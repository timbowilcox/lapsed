// Bandit dual-signal posterior — Sprint 08 chunk 7 (decision 22).
//
// Sprint 07 gave each campaign arm a Beta(sentiment_alpha, sentiment_beta)
// posterior fired by inbound-reply sentiment classification — a LEADING signal:
// fast, but noisy. Sprint 08 adds a second, independent Beta posterior fired by
// ground-truth order outcomes — a LAGGING signal: slow, but real.
//
//   recordOrderArrival     — an attributed order landed → order_alpha + 1
//   recordNoOrderOutcome   — a treated customer's window closed with no order
//                            → order_beta + 1
//   selectArm              — Thompson selection that routes to the order
//                            posterior once it has ≥ 30 observations, else the
//                            sentiment posterior
//
// The two posteriors NEVER cross-contaminate: an order update touches only the
// order_* columns, a sentiment update (bandit.ts updatePosterior) touches only
// the sentiment_* columns. selectArm reads one or the other per arm — it never
// blends them.
//
// Decision 14 still holds: arm IDENTITY (arm_id, template, voice attributes) is
// never mutated — only the posterior counters move. This module touches only
// order_alpha / order_beta / order_observation_count / order_last_updated_at.
//
// IDEMPOTENCY. recordOrderArrival / recordNoOrderOutcome write the decision row
// to `attribution_decisions` FIRST and fire the posterior only if that insert
// is the one that won. `attribution_decisions` carries a partial UNIQUE on
// (order_id) for arrivals and on (attributed_campaign_id, customer_id) for
// no-order rows — so a re-run (the attribution cron is re-runnable) finds the
// existing decision row and no-ops without double-moving the posterior. The
// decision row is the idempotency ledger; recording it before the posterior
// update means a crash in between costs at most one missed observation (a
// benign statistical loss) rather than a double-count (a posterior corruption).

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { thompsonSample, type BanditState, type ThompsonSampleOptions } from "./bandit";

/**
 * Order-observation count at which arm selection switches from the leading
 * sentiment posterior to the lagging order posterior (decision 22). Hardcoded —
 * it is a statistical maturity threshold, not a tuning knob.
 */
export const ORDER_POSTERIOR_MIN_OBSERVATIONS = 30;

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

/**
 * Tenancy guard — asserts the campaign proposal belongs to the merchant before
 * any attribution_decisions row or posterior update is written for it. Defence
 * in depth: the cron always derives (merchantId, campaignId) from the same
 * query path, but a mismatched pair must fail loud rather than write a
 * cross-tenant-inconsistent row.
 */
async function assertCampaignOwnership(
  client: LapsedSupabaseClient,
  merchantId: string,
  campaignId: string,
): Promise<void> {
  const { data, error } = await client
    .from("campaign_proposals")
    .select("merchant_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`bandit-order: campaign ${campaignId} not found`);
  }
  if (data.merchant_id !== merchantId) {
    throw new Error(
      `bandit-order: campaign ${campaignId} does not belong to merchant ${merchantId}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Order posterior update — touches ONLY the order_* columns
// ─────────────────────────────────────────────────────────────────────────────

interface OrderPosteriorRow {
  arm_id: string;
  order_alpha: number;
  order_beta: number;
  order_observation_count: number;
}

const ORDER_POSTERIOR_COLUMNS = "arm_id, order_alpha, order_beta, order_observation_count";

/**
 * Folds one ground-truth order observation into an arm's ORDER posterior:
 *   success → order_alpha + 1   (an attributed order arrived)
 *   failure → order_beta  + 1   (the window closed with no order)
 * and bumps order_observation_count + order_last_updated_at.
 *
 * Never touches the sentiment posterior. Throws if the arm has no bandit_state
 * row (it must have been initialized at proposal approval — decision 14).
 *
 * The read-then-write is NOT atomic — identical to bandit.ts's sentiment-side
 * `updatePosterior`. Safe because the attribution batch cron is the only
 * caller and runs single-invocation per (campaign, window-close-date); two
 * concurrent observations for one arm cannot occur within a cron run.
 */
async function updateOrderPosterior(
  client: LapsedSupabaseClient,
  armId: string,
  success: boolean,
  now: () => Date,
): Promise<void> {
  const { data: current, error: readErr } = await client
    .from("bandit_state")
    .select(ORDER_POSTERIOR_COLUMNS)
    .eq("arm_id", armId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!current) {
    throw new Error(`updateOrderPosterior: arm ${armId} has no bandit_state row`);
  }
  const row = current as OrderPosteriorRow;

  const { error: upErr } = await client
    .from("bandit_state")
    .update({
      order_alpha: row.order_alpha + (success ? 1 : 0),
      order_beta: row.order_beta + (success ? 0 : 1),
      order_observation_count: row.order_observation_count + 1,
      order_last_updated_at: now().toISOString(),
    })
    .eq("arm_id", armId);
  if (upErr) throw upErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// recordOrderArrival — the success signal
// ─────────────────────────────────────────────────────────────────────────────

const RecordOrderArrivalInputSchema = z.object({
  merchantId: z.string().uuid("merchantId must be a UUID"),
  campaignId: z.string().uuid("campaignId must be a UUID"),
  orderId: z.string().uuid("orderId must be a UUID"),
  customerId: z.string().min(1, "customerId is required"),
  attributedMessageId: z.string().uuid("attributedMessageId must be a UUID"),
  /** arm of the attributed outbound; null only if the outbound carried none. */
  armId: z.string().uuid().nullable(),
  attributionWindowDays: z.number().int().positive(),
});

export type RecordOrderArrivalInput = z.infer<typeof RecordOrderArrivalInputSchema>;

export interface RecordOutcomeResult {
  /** True when a decision row already existed — the call was a no-op. */
  alreadyRecorded: boolean;
  /** True when the order posterior was moved by this call. */
  posteriorUpdated: boolean;
}

/**
 * Records an attributed order's arrival: writes the single-attribution
 * `attribution_decisions` row and fires the arm's ORDER posterior with
 * success=true. Idempotent — a re-run for an order already decided is a no-op.
 *
 * Called by the attribution batch cron (chunk 9) for every attributed order.
 */
export async function recordOrderArrival(
  client: LapsedSupabaseClient,
  input: RecordOrderArrivalInput,
  opts: { now?: () => Date } = {},
): Promise<RecordOutcomeResult> {
  const v = RecordOrderArrivalInputSchema.parse(input);
  const now = opts.now ?? (() => new Date());

  // Tenancy: the campaign must belong to the merchant before any write.
  await assertCampaignOwnership(client, v.merchantId, v.campaignId);

  // Idempotency pre-check: a decision row for this order means it was already
  // recorded. (The partial UNIQUE on order_id is the race backstop below.)
  const { data: existing, error: checkErr } = await client
    .from("attribution_decisions")
    .select("id")
    .eq("order_id", v.orderId)
    .maybeSingle();
  if (checkErr) throw checkErr;
  if (existing) return { alreadyRecorded: true, posteriorUpdated: false };

  // Record the decision FIRST — it is the idempotency ledger. A unique
  // violation here means a concurrent run won the race: no-op, do not fire.
  const { error: insertErr } = await client.from("attribution_decisions").insert({
    merchant_id: v.merchantId,
    order_id: v.orderId,
    customer_id: v.customerId,
    decision_type: "attributed",
    attributed_campaign_id: v.campaignId,
    attributed_message_id: v.attributedMessageId,
    attribution_window_days: v.attributionWindowDays,
    decided_at: now().toISOString(),
  });
  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      return { alreadyRecorded: true, posteriorUpdated: false };
    }
    throw insertErr;
  }

  // The decision is committed — fire the order posterior exactly once.
  if (v.armId === null) {
    console.info(
      `bandit_order arrival merchant=${v.merchantId} campaign=${v.campaignId} ` +
        `order=${v.orderId} posterior_skipped=no_arm`,
    );
    return { alreadyRecorded: false, posteriorUpdated: false };
  }
  try {
    await updateOrderPosterior(client, v.armId, true, now);
  } catch (err) {
    // The decision row is committed but the posterior did not move. A re-run
    // will see the decision row and no-op, so this observation is lost. Log it
    // structurally so the drift is observable; the order posterior is noisy
    // ground truth and robust to an occasional single-observation loss.
    console.warn(
      `bandit_order posterior_orphaned order=${v.orderId} arm=${v.armId} ` +
        `reason=${(err as Error).message}`,
    );
    throw err;
  }
  return { alreadyRecorded: false, posteriorUpdated: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// recordNoOrderOutcome — the failure signal (window closed, no order)
// ─────────────────────────────────────────────────────────────────────────────

const RecordNoOrderInputSchema = z.object({
  merchantId: z.string().uuid("merchantId must be a UUID"),
  campaignId: z.string().uuid("campaignId must be a UUID"),
  customerId: z.string().min(1, "customerId is required"),
  /** arm of the customer's outbound from this campaign. */
  armId: z.string().uuid().nullable(),
  attributionWindowDays: z.number().int().positive(),
});

export type RecordNoOrderInput = z.infer<typeof RecordNoOrderInputSchema>;

/**
 * Records a treated customer whose attribution window closed with no order:
 * writes a `no_order` `attribution_decisions` row and fires the arm's ORDER
 * posterior with success=false. Idempotent per (campaign, customer).
 *
 * Called by the attribution batch cron (chunk 9) at window-close.
 */
export async function recordNoOrderOutcome(
  client: LapsedSupabaseClient,
  input: RecordNoOrderInput,
  opts: { now?: () => Date } = {},
): Promise<RecordOutcomeResult> {
  const v = RecordNoOrderInputSchema.parse(input);
  const now = opts.now ?? (() => new Date());

  // Tenancy: the campaign must belong to the merchant before any write.
  await assertCampaignOwnership(client, v.merchantId, v.campaignId);

  // Idempotency pre-check: a no_order decision for this (campaign, customer).
  const { data: existing, error: checkErr } = await client
    .from("attribution_decisions")
    .select("id")
    .eq("attributed_campaign_id", v.campaignId)
    .eq("customer_id", v.customerId)
    .eq("decision_type", "no_order")
    .maybeSingle();
  if (checkErr) throw checkErr;
  if (existing) return { alreadyRecorded: true, posteriorUpdated: false };

  const { error: insertErr } = await client.from("attribution_decisions").insert({
    merchant_id: v.merchantId,
    customer_id: v.customerId,
    decision_type: "no_order",
    attributed_campaign_id: v.campaignId,
    attribution_window_days: v.attributionWindowDays,
    decided_at: now().toISOString(),
  });
  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      return { alreadyRecorded: true, posteriorUpdated: false };
    }
    throw insertErr;
  }

  if (v.armId === null) {
    console.info(
      `bandit_order no_order merchant=${v.merchantId} campaign=${v.campaignId} ` +
        `posterior_skipped=no_arm`,
    );
    return { alreadyRecorded: false, posteriorUpdated: false };
  }
  try {
    await updateOrderPosterior(client, v.armId, false, now);
  } catch (err) {
    // Decision row committed, posterior did not move — see recordOrderArrival.
    console.warn(
      `bandit_order posterior_orphaned campaign=${v.campaignId} ` +
        `arm=${v.armId} reason=${(err as Error).message}`,
    );
    throw err;
  }
  return { alreadyRecorded: false, posteriorUpdated: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// selectArm — dual-signal Thompson selection (decision 22)
// ─────────────────────────────────────────────────────────────────────────────

interface BanditStateRow {
  arm_id: string;
  merchant_id: string;
  proposal_id: string;
  sentiment_alpha: number;
  sentiment_beta: number;
  order_alpha: number;
  order_beta: number;
  observation_count: number;
  order_observation_count: number;
  last_updated_at: string;
  order_last_updated_at: string | null;
}

/** Which posterior an arm's Thompson draw was taken from. */
export type PosteriorSource = "order" | "sentiment";

export interface ArmPosteriorChoice {
  armId: string;
  posteriorSource: PosteriorSource;
  alpha: number;
  beta: number;
  orderObservationCount: number;
}

export interface ArmSelection {
  selectedArmId: string;
  /** Per-arm record of which posterior fed the Thompson draw. */
  perArm: ArmPosteriorChoice[];
}

/**
 * Thompson-samples one arm of a campaign, routing each arm to the posterior
 * decision 22 prescribes: the ORDER posterior once `order_observation_count`
 * reaches ORDER_POSTERIOR_MIN_OBSERVATIONS (30), else the SENTIMENT posterior.
 * The two posteriors are never blended — each arm uses exactly one.
 *
 * Deterministic given `opts.seed`. Logs a structured `bandit_selection` event
 * recording the posterior source used per arm.
 */
export async function selectArm(
  client: LapsedSupabaseClient,
  campaignId: string,
  opts: ThompsonSampleOptions = {},
): Promise<ArmSelection> {
  z.string().uuid("campaignId must be a UUID").parse(campaignId);

  const { data, error } = await client
    .from("bandit_state")
    .select(
      "arm_id, merchant_id, proposal_id, sentiment_alpha, sentiment_beta, order_alpha, order_beta, observation_count, order_observation_count, last_updated_at, order_last_updated_at",
    )
    .eq("proposal_id", campaignId);
  if (error) throw error;
  const rows = (data ?? []) as BanditStateRow[];
  if (rows.length === 0) {
    throw new Error(`selectArm: campaign ${campaignId} has no bandit_state arms`);
  }

  const perArm: ArmPosteriorChoice[] = [];
  const banditStates: BanditState[] = [];
  for (const row of rows) {
    // Decision 22: route to the order posterior once it has matured; otherwise
    // fall back to the sentiment posterior. Exactly one is read — never blended.
    const useOrder = row.order_observation_count >= ORDER_POSTERIOR_MIN_OBSERVATIONS;
    const posteriorSource: PosteriorSource = useOrder ? "order" : "sentiment";
    const alpha = useOrder ? row.order_alpha : row.sentiment_alpha;
    const beta = useOrder ? row.order_beta : row.sentiment_beta;

    perArm.push({
      armId: row.arm_id,
      posteriorSource,
      alpha,
      beta,
      orderObservationCount: row.order_observation_count,
    });
    // thompsonSample consumes ONLY armId + alpha + beta. observationCount and
    // lastUpdatedAt are descriptive carry-through fields it never reads, so
    // they cannot blend the two posteriors — they are populated from the
    // chosen track purely for shape completeness.
    banditStates.push({
      armId: row.arm_id,
      merchantId: row.merchant_id,
      proposalId: row.proposal_id,
      alpha,
      beta,
      observationCount: useOrder ? row.order_observation_count : row.observation_count,
      lastUpdatedAt: (useOrder ? row.order_last_updated_at : row.last_updated_at) ?? row.last_updated_at,
    });
  }

  const selectedArmId = thompsonSample(banditStates, opts);

  // Structured selection log — which posterior fed each arm's draw.
  const sources = perArm.map((a) => `${a.armId}:${a.posteriorSource}`).join(",");
  console.info(`bandit_selection campaign=${campaignId} selected=${selectedArmId} sources=${sources}`);

  return { selectedArmId, perArm };
}
