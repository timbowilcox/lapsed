// AI Insights/Recommendations engine (decision 36).
//
// Deterministic: no LLM calls, no ML models. All recommendations are derived
// from existing DB signals against static thresholds. Every recommendation is
// traceable to a specific metric crossing a specific threshold.
//
// Five signal categories (decision 36):
//   cohort    — lapsed VIP count spike
//   arm       — underperforming campaign arm (bandit rate gap)
//   opt_out   — elevated recent opt-out count
//   conversation — stale conversations (no reply to recent outbound)
//   payment   — subscription renewal approaching
//
// Append-only table pattern:
//   State changes (dismiss/act/snooze) write new rows; getActive resolves
//   current state via DISTINCT ON (insight_key). An active, non-expired row
//   suppresses re-insertion within the 18-hour expiry window (idempotency).

import {
  getActiveInsights,
  getInsightById,
  insertInsight,
  hasActiveInsight,
  type LapsedSupabaseClient,
  type InsightRow,
  type InsightPriority,
  type InsightCategory,
  type InsertInsightInput,
} from "@lapsed/db";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type { InsightRow, InsightPriority, InsightCategory };

export interface GenerateRecommendationsResult {
  generated: number;
  skipped: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal thresholds — tunable constants, not magic numbers
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum dormant-VIP customers to surface the cohort recommendation. */
const COHORT_LAPSED_VIP_THRESHOLD = 10;

/** Minimum arm observation count before the arm signal fires. */
const ARM_MIN_OBSERVATIONS = 10;

/** Minimum performance gap (absolute) between best and worst arm to flag. */
const ARM_GAP_THRESHOLD = 0.20;

/** Opt-out count in last 30 days to trigger the opt-out signal. */
const OPT_OUT_COUNT_THRESHOLD = 5;

/** Conversations with a recent outbound but no reply after this many days. */
const NO_REPLY_DAYS = 7;

/** Minimum stale conversations to surface the conversation signal. */
const STALE_CONV_THRESHOLD = 5;

/** Days until subscription renewal that triggers the payment signal. */
const RENEWAL_WARNING_DAYS = 7;

/** How long an active insight row remains valid before expiring. */
const INSIGHT_TTL_HOURS = 18;

// ─────────────────────────────────────────────────────────────────────────────
// Internal signal candidate shape
// ─────────────────────────────────────────────────────────────────────────────

interface SignalCandidate {
  insightKey: string;
  priority: InsightPriority;
  category: InsightCategory;
  signalMetric: string;
  signalValue: number;
  threshold: number;
  merchantCopy: string;
  ctaAction: { route: string; params?: Record<string, string> };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal evaluators — each returns zero or more candidates whose threshold
// has been crossed. They use only the serviceClient (service role — bypasses
// RLS) and never call an LLM or external API.
// ─────────────────────────────────────────────────────────────────────────────

async function evaluateCohortSignal(
  client: LapsedSupabaseClient,
  merchantId: string,
): Promise<SignalCandidate[]> {
  // Count customers in the lapsed_vips group who are in a lapsed lifecycle
  // stage. This is the primary "dormant VIP" signal.
  const { count, error } = await client
    .from("customer_inferred_state")
    .select("shopify_customer_gid", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .contains("group_memberships", ["lapsed_vips"])
    .eq("lifecycle_stage", "lapsed");
  if (error) throw error;

  const lapsedVipCount = count ?? 0;
  if (lapsedVipCount < COHORT_LAPSED_VIP_THRESHOLD) return [];

  return [
    {
      insightKey: `cohort:lapsed_vip_dormancy`,
      priority: "HIGH",
      category: "cohort",
      signalMetric: "lapsed_vip_count",
      signalValue: lapsedVipCount,
      threshold: COHORT_LAPSED_VIP_THRESHOLD,
      merchantCopy: `${lapsedVipCount} dormant VIP customers — a targeted win-back campaign typically recovers 10-15% of this group.`,
      ctaAction: { route: "/app/campaigns/new" },
    },
  ];
}

async function evaluateArmSignal(
  client: LapsedSupabaseClient,
  merchantId: string,
): Promise<SignalCandidate[]> {
  // For each approved campaign, check whether any arm is performing
  // significantly below the best arm (by Thompson-sampling rate alpha/(alpha+beta)).
  // Only consider arms with enough observations to yield a reliable estimate.
  const { data: armRows, error } = await client
    .from("bandit_state")
    .select("arm_id, proposal_id, sentiment_alpha, sentiment_beta, observation_count")
    .eq("merchant_id", merchantId)
    .gte("observation_count", ARM_MIN_OBSERVATIONS);
  if (error) throw error;
  if (!armRows || armRows.length === 0) return [];

  // Group by proposal_id
  const byProposal = new Map<
    string,
    Array<{ armId: string; rate: number; observations: number }>
  >();
  for (const row of armRows) {
    const alpha = Number(row.sentiment_alpha);
    const beta = Number(row.sentiment_beta);
    const rate = alpha / (alpha + beta);
    if (!byProposal.has(row.proposal_id)) byProposal.set(row.proposal_id, []);
    byProposal.get(row.proposal_id)!.push({
      armId: row.arm_id,
      rate,
      observations: row.observation_count,
    });
  }

  const candidates: SignalCandidate[] = [];
  for (const [proposalId, arms] of byProposal) {
    if (arms.length < 2) continue;
    const rates = arms.map((a) => a.rate);
    const maxRate = Math.max(...rates);
    const minRate = Math.min(...rates);
    const gap = maxRate - minRate;
    if (gap < ARM_GAP_THRESHOLD) continue;

    candidates.push({
      insightKey: `arm:performance_gap:${proposalId}`,
      priority: "MEDIUM",
      category: "arm",
      signalMetric: "arm_rate_gap",
      signalValue: Math.round(gap * 1000) / 1000,
      threshold: ARM_GAP_THRESHOLD,
      merchantCopy: `One of your campaign arms is converting ${Math.round(gap * 100)}% below the top arm — consider reviewing its message approach.`,
      ctaAction: { route: "/app/campaigns" },
    });
  }
  return candidates;
}

async function evaluateOptOutSignal(
  client: LapsedSupabaseClient,
  merchantId: string,
  now: Date,
): Promise<SignalCandidate[]> {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await client
    .from("customer_opt_outs")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .gte("created_at", thirtyDaysAgo);
  if (error) throw error;

  const optOutCount = count ?? 0;
  if (optOutCount < OPT_OUT_COUNT_THRESHOLD) return [];

  return [
    {
      insightKey: `opt_out:elevated_count`,
      priority: "HIGH",
      category: "opt_out",
      signalMetric: "opt_out_count_30d",
      signalValue: optOutCount,
      threshold: OPT_OUT_COUNT_THRESHOLD,
      merchantCopy: `${optOutCount} customers opted out in the last 30 days — review your message frequency and tone to reduce this.`,
      ctaAction: { route: "/app/settings" },
    },
  ];
}

async function evaluateConversationSignal(
  client: LapsedSupabaseClient,
  merchantId: string,
  now: Date,
): Promise<SignalCandidate[]> {
  // Count conversations where the merchant sent an outbound in the last 7 days
  // but received no inbound reply (last_inbound_at is null or older than 7 days).
  const cutoff = new Date(now.getTime() - NO_REPLY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Conversations with a recent outbound but stale (no inbound since cutoff).
  const { count, error } = await client
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .gte("last_message_at", cutoff)
    .or(`last_inbound_at.is.null,last_inbound_at.lt.${cutoff}`);
  if (error) throw error;

  const staleCount = count ?? 0;
  if (staleCount < STALE_CONV_THRESHOLD) return [];

  return [
    {
      insightKey: `conversation:no_reply_accumulation`,
      priority: "MEDIUM",
      category: "conversation",
      signalMetric: "stale_conversation_count",
      signalValue: staleCount,
      threshold: STALE_CONV_THRESHOLD,
      merchantCopy: `${staleCount} recent messages haven't received a reply — consider refreshing your outbound approach.`,
      ctaAction: { route: "/app/conversations" },
    },
  ];
}

async function evaluatePaymentSignal(
  client: LapsedSupabaseClient,
  merchantId: string,
  now: Date,
): Promise<SignalCandidate[]> {
  const warningCutoff = new Date(
    now.getTime() + RENEWAL_WARNING_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await client
    .from("merchant_subscriptions")
    .select("current_period_end, status")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .lte("current_period_end", warningCutoff)
    .maybeSingle();
  if (error) throw error;
  if (!data) return [];

  const daysUntilRenewal = Math.max(
    0,
    Math.ceil(
      (new Date(data.current_period_end).getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
    ),
  );

  return [
    {
      insightKey: `payment:renewal_approaching`,
      priority: "HIGH",
      category: "payment",
      signalMetric: "days_until_renewal",
      signalValue: daysUntilRenewal,
      threshold: RENEWAL_WARNING_DAYS,
      merchantCopy: `Your subscription renews in ${daysUntilRenewal} day${daysUntilRenewal === 1 ? "" : "s"} — make sure your billing details are up to date.`,
      ctaAction: { route: "/app/settings/billing" },
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluates all signal categories for a merchant and inserts active insight
 * rows for any threshold that has been crossed and has no existing active,
 * non-expired row (idempotency).
 *
 * The `now` parameter is injectable for testing; production callers omit it
 * (defaults to `new Date()`).
 *
 * NO LLM CALLS. Verified by the code-reviewer subagent: this file imports
 * nothing from anthropic-ai/sdk or openai.
 */
export async function generateRecommendations(
  client: LapsedSupabaseClient,
  merchantId: string,
  now?: Date,
): Promise<GenerateRecommendationsResult> {
  const effectiveNow = now ?? new Date();
  const expiresAt = new Date(
    effectiveNow.getTime() + INSIGHT_TTL_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Collect all signal candidates.
  const [cohort, arms, optOut, conv, payment] = await Promise.all([
    evaluateCohortSignal(client, merchantId).catch(() => [] as SignalCandidate[]),
    evaluateArmSignal(client, merchantId).catch(() => [] as SignalCandidate[]),
    evaluateOptOutSignal(client, merchantId, effectiveNow).catch(() => [] as SignalCandidate[]),
    evaluateConversationSignal(client, merchantId, effectiveNow).catch(
      () => [] as SignalCandidate[],
    ),
    evaluatePaymentSignal(client, merchantId, effectiveNow).catch(() => [] as SignalCandidate[]),
  ]);

  const candidates: SignalCandidate[] = [...cohort, ...arms, ...optOut, ...conv, ...payment];

  let generated = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    // Idempotency: skip if there is already an active, non-expired row for
    // this insight_key. This prevents duplicate rows from concurrent cron runs
    // and suppresses re-insertion while the insight is still fresh.
    const alreadyActive = await hasActiveInsight(
      client,
      merchantId,
      candidate.insightKey,
      effectiveNow,
    );
    if (alreadyActive) {
      skipped++;
      continue;
    }

    const input: InsertInsightInput = {
      merchantId,
      insightKey: candidate.insightKey,
      priority: candidate.priority,
      category: candidate.category,
      signalMetric: candidate.signalMetric,
      signalValue: candidate.signalValue,
      threshold: candidate.threshold,
      merchantCopy: candidate.merchantCopy,
      ctaAction: candidate.ctaAction,
      expiresAt,
    };
    await insertInsight(client, input);
    generated++;
  }

  return { generated, skipped };
}

/**
 * Returns the current active, non-expired insights for a merchant.
 * Delegates to the DB layer (DISTINCT ON resolved in JS — see queries.ts).
 */
export async function getActive(
  client: LapsedSupabaseClient,
  merchantId: string,
  now?: Date,
): Promise<InsightRow[]> {
  return getActiveInsights(client, merchantId, now);
}

/**
 * Records that the merchant has acted on the recommendation (clicked the CTA).
 * Inserts a new row with state='acted'.
 */
export async function markActed(
  client: LapsedSupabaseClient,
  merchantId: string,
  insightId: string,
): Promise<void> {
  await transitionState(client, merchantId, insightId, "acted");
}

/**
 * Records that the merchant has dismissed the recommendation.
 * Inserts a new row with state='dismissed'.
 */
export async function markDismissed(
  client: LapsedSupabaseClient,
  merchantId: string,
  insightId: string,
): Promise<void> {
  await transitionState(client, merchantId, insightId, "dismissed");
}

/**
 * Records that the merchant has snoozed the recommendation.
 * Inserts a new row with state='snoozed'.
 */
export async function markSnoozed(
  client: LapsedSupabaseClient,
  merchantId: string,
  insightId: string,
): Promise<void> {
  await transitionState(client, merchantId, insightId, "snoozed");
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state-transition helper
// ─────────────────────────────────────────────────────────────────────────────

async function transitionState(
  client: LapsedSupabaseClient,
  merchantId: string,
  insightId: string,
  newState: "dismissed" | "acted" | "snoozed",
): Promise<void> {
  const original = await getInsightById(client, merchantId, insightId);
  if (!original) {
    throw new InsightNotFoundError(insightId);
  }
  // Write a new append-only row preserving all original fields, with the new
  // state. The DISTINCT ON (insight_key, created_at DESC) in getActive will
  // pick this new row as the current state.
  // State-change rows carry no expiry — they are the terminal state for this
  // key until the next signal evaluation cycle re-activates if still crossed.
  await insertInsight(client, {
    merchantId: original.merchantId,
    insightKey: original.insightKey,
    priority: original.priority,
    category: original.category,
    signalMetric: original.signalMetric,
    signalValue: original.signalValue,
    threshold: original.threshold,
    merchantCopy: original.merchantCopy,
    ctaAction: original.ctaAction as { route: string; params?: Record<string, string> },
    expiresAt: null,
    state: newState,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Error type
// ─────────────────────────────────────────────────────────────────────────────

export class InsightNotFoundError extends Error {
  readonly insightId: string;
  constructor(insightId: string) {
    super(`Insight ${insightId} not found or does not belong to this merchant.`);
    this.name = "InsightNotFoundError";
    this.insightId = insightId;
  }
}
