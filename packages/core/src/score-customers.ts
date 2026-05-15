/**
 * Haiku propensity scoring orchestrator.
 *
 * Per merchant:
 *  1. Open a scoring_runs row (status: "running").
 *  2. Check + reset the daily token cap.
 *  3. Find scorable customers (lifecycle ≠ churned, incremental skip logic).
 *  4. Batch into chunks of BATCH_SIZE; call Haiku for each batch.
 *  5. For each scored customer:
 *     a. Write customer_scored event (Decision 1 — event sourcing).
 *     b. Update customer_inferred_state with propensity scores.
 *  6. Track tokens + cost; halt if cap reached.
 *  7. Close scoring_runs with status "succeeded" or "failed".
 *
 * Idempotent: re-running for the same merchant in the same window produces
 * consistent state (scoring events are written, but inferred state ends up the
 * same due to idempotent upserts and the incremental skip guard).
 */

import type { LapsedSupabaseClient } from "@lapsed/db";
import { appendCustomerEvent } from "./customer-events";
import {
  scoreBatch,
  HAIKU_MODEL,
  BATCH_SIZE,
  type CustomerScoringInput,
  type ScoringBatchResult,
} from "./customer-scoring";
import type { LifecycleStage } from "./customer-lifecycle";
import type Anthropic from "@anthropic-ai/sdk";

export interface ScoreCustomersResult {
  scoringRunId: string;
  customersScored: number;
  tokensInput: number;
  tokensOutput: number;
  costCents: number;
  status: "succeeded" | "failed";
  capReached: boolean;
}

interface CustomerEligibilityRow {
  shopify_customer_gid: string;
  total_order_count: number;
  last_order_days_ago: number | null;
  total_ltv_cents: number;
  lapsed_at: string | null;
}

interface InferredStateEligibilityRow {
  shopify_customer_gid: string;
  lifecycle_stage: string | null;
  last_scored_at: string | null;
  last_engagement_event_at: string | null;
  score_model_version: string | null;
}

interface RfmEligibilityRow {
  shopify_customer_gid: string;
  lifecycle_stage: string | null;
}

interface OrderEventEnrichmentRow {
  shopify_customer_gid: string;
  occurred_at: string;
}

interface CustomerEventEnrichmentRow {
  shopify_customer_gid: string;
}

interface CustomerEventEnrichment {
  firstOrderDaysAgo: number | null;
  ordersInPast12Months: number;
  engagementEventsInPast90Days: number;
}

interface TokenCapRow {
  id: string;
  daily_token_cap: number;
  period_start: string;
  tokens_used_today: number;
}

const DEFAULT_TOKEN_CAP = 10_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Event data enrichment
// ─────────────────────────────────────────────────────────────────────────────

// customer_scored is a system event written by the scoring run itself — excluding it
// prevents the incremental-skip guard from treating a prior score as fresh engagement.
const SYSTEM_EVENTS = "(customer_created,customer_updated,customer_backfilled,customer_scored)";

/**
 * Bulk-fetches order_events and customer_events for a list of GIDs and
 * returns per-customer enrichment data needed to populate the scoring input.
 * A single query per event table avoids N+1 queries across a 50-customer batch.
 */
async function enrichWithEventData(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  gids: string[],
  now: Date,
): Promise<Map<string, CustomerEventEnrichment>> {
  if (gids.length === 0) return new Map();

  const cutoff12m = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const cutoff90d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Fetch all order events for the batch in one query.
  const { data: orderEvents, error: oeErr } = await serviceClient
    .from("order_events")
    .select("shopify_customer_gid,occurred_at")
    .eq("merchant_id", merchantId)
    .in("shopify_customer_gid", gids)
    .in("event_type", ["order_paid", "order_backfilled"]);

  if (oeErr) throw oeErr;

  // Fetch engagement events (non-identity) in past 90 days for the batch.
  const { data: engagementEvents, error: eeErr } = await serviceClient
    .from("customer_events")
    .select("shopify_customer_gid")
    .eq("merchant_id", merchantId)
    .in("shopify_customer_gid", gids)
    .not("event_type", "in", SYSTEM_EVENTS)
    .gte("occurred_at", cutoff90d.toISOString());

  if (eeErr) throw eeErr;

  // Aggregate order data per GID.
  const orderData = new Map<string, { firstOrderAt: Date | null; ordersIn12m: number }>();
  for (const gid of gids) orderData.set(gid, { firstOrderAt: null, ordersIn12m: 0 });

  for (const ev of (orderEvents ?? []) as OrderEventEnrichmentRow[]) {
    const d = new Date(ev.occurred_at);
    const entry = orderData.get(ev.shopify_customer_gid) ?? { firstOrderAt: null, ordersIn12m: 0 };
    if (!entry.firstOrderAt || d < entry.firstOrderAt) entry.firstOrderAt = d;
    if (d >= cutoff12m) entry.ordersIn12m++;
    orderData.set(ev.shopify_customer_gid, entry);
  }

  // Aggregate engagement event counts per GID.
  const engagementCounts = new Map<string, number>();
  for (const gid of gids) engagementCounts.set(gid, 0);
  for (const ev of (engagementEvents ?? []) as CustomerEventEnrichmentRow[]) {
    engagementCounts.set(ev.shopify_customer_gid, (engagementCounts.get(ev.shopify_customer_gid) ?? 0) + 1);
  }

  // Build result map.
  const result = new Map<string, CustomerEventEnrichment>();
  for (const gid of gids) {
    const orders = orderData.get(gid)!;
    const firstOrderDaysAgo = orders.firstOrderAt
      ? Math.floor((now.getTime() - orders.firstOrderAt.getTime()) / (1000 * 60 * 60 * 24))
      : null;
    result.set(gid, {
      firstOrderDaysAgo,
      ordersInPast12Months: orders.ordersIn12m,
      engagementEventsInPast90Days: engagementCounts.get(gid) ?? 0,
    });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token cap management
// ─────────────────────────────────────────────────────────────────────────────

async function getOrCreateTokenCap(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  today: string,
): Promise<TokenCapRow> {
  const { data, error } = await serviceClient
    .from("merchant_scoring_caps")
    .select("id,daily_token_cap,period_start,tokens_used_today")
    .eq("merchant_id", merchantId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    // First-ever scoring run for this merchant — create a cap row.
    const { data: created, error: insertErr } = await serviceClient
      .from("merchant_scoring_caps")
      .insert({ merchant_id: merchantId })
      .select("id,daily_token_cap,period_start,tokens_used_today")
      .single();
    if (insertErr || !created) throw insertErr ?? new Error("Failed to create cap row");
    return created as unknown as TokenCapRow;
  }

  const row = data as unknown as TokenCapRow;

  // Reset daily counter if the period has rolled over.
  if (row.period_start < today) {
    const { error: resetErr } = await serviceClient
      .from("merchant_scoring_caps")
      .update({ tokens_used_today: 0, period_start: today })
      .eq("id", row.id);
    if (resetErr) throw resetErr;
    return { ...row, tokens_used_today: 0, period_start: today };
  }

  return row;
}

async function setTokenUsage(
  serviceClient: LapsedSupabaseClient,
  capId: string,
  tokensUsedTotal: number,
): Promise<void> {
  const { error } = await serviceClient
    .from("merchant_scoring_caps")
    .update({ tokens_used_today: tokensUsedTotal })
    .eq("id", capId);
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────────────────────────────────────

/** Build the set of scorable customers. Excludes churned lifecycle and applies
 * incremental skip: skip if last_scored_at > last_engagement_event_at AND
 * lifecycle_stage is unchanged (no new signal since last score). */
async function findScorable(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  forceFullRescore: boolean,
): Promise<CustomerScoringInput[]> {
  // Fetch customers who are not churned (scoring is not effective for churned).
  // Fetch all customers — churned filter is applied below using the inferred state map.
  const { data: customers, error: custErr } = await serviceClient
    .from("customers")
    .select(
      "shopify_customer_gid,total_order_count,last_order_days_ago,total_ltv_cents,lapsed_at",
    )
    .eq("merchant_id", merchantId);

  if (custErr) throw custErr;
  const customerList = (customers ?? []) as CustomerEligibilityRow[];

  if (customerList.length === 0) return [];

  // Fetch existing inferred states for incremental skip logic.
  const gids = customerList.map((c) => c.shopify_customer_gid);
  const { data: states, error: statesErr } = await serviceClient
    .from("customer_inferred_state")
    .select("shopify_customer_gid,lifecycle_stage,last_scored_at,last_engagement_event_at,score_model_version")
    .eq("merchant_id", merchantId)
    .in("shopify_customer_gid", gids);

  if (statesErr) throw statesErr;

  const stateMap = new Map(
    ((states ?? []) as InferredStateEligibilityRow[]).map((s) => [s.shopify_customer_gid, s]),
  );

  // Fetch current RFM lifecycle stage for each candidate. The RFM job writes
  // the freshly-computed lifecycle to customer_rfm nightly; the scoring job
  // writes its own lifecycle snapshot to customer_inferred_state when it scores.
  // Comparing the two detects lifecycle transitions that happened between scoring
  // cycles but did not produce a new engagement event (e.g. at_risk → lapsed
  // due to time passing), forcing a rescore even when engagement is stale.
  const { data: rfmRows, error: rfmErr } = await serviceClient
    .from("customer_rfm")
    .select("shopify_customer_gid,lifecycle_stage")
    .eq("merchant_id", merchantId)
    .in("shopify_customer_gid", gids);

  if (rfmErr) throw rfmErr;

  const rfmLifecycleMap = new Map(
    ((rfmRows ?? []) as RfmEligibilityRow[]).map((r) => [r.shopify_customer_gid, r.lifecycle_stage]),
  );

  const scorable = customerList.filter((c) => {
    const state = stateMap.get(c.shopify_customer_gid);
    // Exclude churned customers — scoring is ineffective for them.
    if (state?.lifecycle_stage === "churned") return false;
    if (forceFullRescore) return true;
    if (!state?.last_scored_at) return true; // never scored
    // Auto-rescore when score was produced by a stale model version.
    if (state.score_model_version !== HAIKU_MODEL) return true;
    // Skip if no new engagement signal since last score AND lifecycle is unchanged.
    const lastScored = new Date(state.last_scored_at).getTime();
    const lastEngaged = state.last_engagement_event_at
      ? new Date(state.last_engagement_event_at).getTime()
      : 0;
    const rfmLifecycle = rfmLifecycleMap.get(c.shopify_customer_gid) ?? null;
    return lastEngaged > lastScored || rfmLifecycle !== state.lifecycle_stage;
  });

  if (scorable.length === 0) return [];

  const scorableGids = scorable.map((c) => c.shopify_customer_gid);
  const now = new Date();
  const enrichment = await enrichWithEventData(serviceClient, merchantId, scorableGids, now);

  return scorable.map((c) => {
    const avgOrderValueCents =
      c.total_order_count > 0 ? Math.round(c.total_ltv_cents / c.total_order_count) : 0;
    const state = stateMap.get(c.shopify_customer_gid);
    const ev = enrichment.get(c.shopify_customer_gid);
    return {
      shopifyCustomerGid: c.shopify_customer_gid,
      totalOrderCount: c.total_order_count,
      lastOrderDaysAgo: c.last_order_days_ago,
      firstOrderDaysAgo: ev?.firstOrderDaysAgo ?? null,
      totalLtvCents: c.total_ltv_cents,
      ordersInPast12Months: ev?.ordersInPast12Months ?? 0,
      engagementEventsInPast90Days: ev?.engagementEventsInPast90Days ?? 0,
      lifecycleStage: rfmLifecycleMap.get(c.shopify_customer_gid) ?? state?.lifecycle_stage ?? "lapsed",
      avgOrderValueCents,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-customer post-scoring write
// ─────────────────────────────────────────────────────────────────────────────

async function writeScoreForCustomer(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  scoringRunId: string,
  gid: string,
  result: ScoringBatchResult["scores"][number],
  lifecycleStage: LifecycleStage,
  now: string,
): Promise<void> {
  // Decision 1: write customer_scored event before touching inferred state.
  await appendCustomerEvent(serviceClient, {
    merchantId,
    shopifyCustomerGid: gid,
    eventType: "customer_scored",
    source: "haiku_scoring",
    payload: {
      propensity_30d: result.propensity30d,
      propensity_60d: result.propensity60d,
      propensity_90d: result.propensity90d,
      predicted_residual_ltv_cents: result.predictedResidualLtvCents,
      top_signal: result.topSignal,
      score_run_id: scoringRunId,
    },
    occurredAt: now,
  });

  // Update scoring columns in customer_inferred_state.
  // lifecycle_stage is written here (not by rfm-batch) so that the next
  // scoring run can compare inferred_state.lifecycle_stage (= last scored
  // lifecycle) against customer_rfm.lifecycle_stage (= current RFM lifecycle)
  // to detect transitions that occurred without new engagement events.
  const { error } = await serviceClient
    .from("customer_inferred_state")
    .upsert(
      {
        merchant_id: merchantId,
        shopify_customer_gid: gid,
        lifecycle_stage: lifecycleStage,
        propensity_30d: result.propensity30d,
        propensity_60d: result.propensity60d,
        propensity_90d: result.propensity90d,
        predicted_residual_ltv_cents: String(result.predictedResidualLtvCents),
        top_signal: result.topSignal,
        score_model_version: HAIKU_MODEL,
        score_run_id: scoringRunId,
        last_scored_at: now,
      },
      { onConflict: "merchant_id,shopify_customer_gid" },
    );
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreCustomersOpts {
  merchantId: string;
  medianAovCents: number;
  forceFullRescore?: boolean;
  tokenCapDefault?: number;
}

export async function scoreCustomers(
  serviceClient: LapsedSupabaseClient,
  anthropicClient: Anthropic,
  opts: ScoreCustomersOpts,
): Promise<ScoreCustomersResult> {
  const { merchantId, medianAovCents, forceFullRescore = false, tokenCapDefault = DEFAULT_TOKEN_CAP } = opts;
  const now = new Date().toISOString();
  const today = now.slice(0, 10); // YYYY-MM-DD

  // Open scoring_runs row.
  const { data: runRow, error: runErr } = await serviceClient
    .from("scoring_runs")
    .insert({ merchant_id: merchantId, model_version: HAIKU_MODEL, status: "running" })
    .select("id")
    .single();

  if (runErr || !runRow) throw runErr ?? new Error("Failed to open scoring_runs row");
  const scoringRunId = (runRow as { id: string }).id;

  let customersScored = 0;
  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  let totalCostCents = 0;
  let capReached = false;
  let finalStatus: "succeeded" | "failed" = "succeeded";
  let errorMessage: string | null = null;

  try {
    // Check token cap.
    const cap = await getOrCreateTokenCap(serviceClient, merchantId, today);
    const effectiveCap = cap.daily_token_cap ?? tokenCapDefault;
    const remainingTokens = effectiveCap - cap.tokens_used_today;

    if (remainingTokens <= 0) {
      capReached = true;
      console.warn(
        JSON.stringify({ event: "scoring_cap_reached", merchant_id: merchantId.slice(0, 8) }),
      );
    } else {
      const scorable = await findScorable(serviceClient, merchantId, forceFullRescore);

      // Process in batches of BATCH_SIZE.
      for (let i = 0; i < scorable.length; i += BATCH_SIZE) {
        if (capReached) break;

        const batch = scorable.slice(i, i + BATCH_SIZE);
        const batchLifecycleMap = new Map(batch.map((b) => [b.shopifyCustomerGid, b.lifecycleStage]));
        let batchResult: ScoringBatchResult;

        const batchStart = Date.now();
        try {
          batchResult = await scoreBatch(anthropicClient, batch, medianAovCents);
        } catch (err) {
          console.error(
            JSON.stringify({
              event: "scoring_batch_api_error",
              merchant_id: merchantId.slice(0, 8),
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          throw err; // escalate — API errors are fatal for the run
        }

        totalTokensInput += batchResult.tokensInput;
        totalTokensOutput += batchResult.tokensOutput;
        totalCostCents += batchResult.costCents;

        // Write cumulative token usage so far.
        await setTokenUsage(
          serviceClient,
          cap.id,
          cap.tokens_used_today + totalTokensInput + totalTokensOutput,
        );

        // Cap check for next iteration.
        if (cap.tokens_used_today + totalTokensInput + totalTokensOutput >= effectiveCap) {
          capReached = true;
        }

        // Write scores per customer.
        for (const score of batchResult.scores) {
          try {
            await writeScoreForCustomer(
              serviceClient,
              merchantId,
              scoringRunId,
              score.shopifyCustomerGid,
              score,
              (batchLifecycleMap.get(score.shopifyCustomerGid) ?? "lapsed") as LifecycleStage,
              now,
            );
            customersScored++;
          } catch (err) {
            console.error(
              JSON.stringify({
                event: "scoring_write_error",
                merchant_id: merchantId.slice(0, 8),
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }

        console.log(
          JSON.stringify({
            event: "scoring_batch_complete",
            merchant_id: merchantId.slice(0, 8),
            batch_size: batch.length,
            tokens_in: batchResult.tokensInput,
            tokens_out: batchResult.tokensOutput,
            latency_ms: Date.now() - batchStart,
            status: "succeeded",
          }),
        );
      }
    }
  } catch (err) {
    finalStatus = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: "scoring_run_failed",
        merchant_id: merchantId.slice(0, 8),
        error: errorMessage,
      }),
    );
  }

  // Close scoring_runs row.
  const { error: closeErr } = await serviceClient
    .from("scoring_runs")
    .update({
      status: finalStatus,
      finished_at: new Date().toISOString(),
      customers_scored: customersScored,
      tokens_input: totalTokensInput,
      tokens_output: totalTokensOutput,
      cost_cents: totalCostCents,
      error_message: errorMessage,
    })
    .eq("id", scoringRunId);

  if (closeErr) {
    console.error(
      JSON.stringify({
        event: "scoring_run_close_error",
        merchant_id: merchantId.slice(0, 8),
        error: closeErr.message,
      }),
    );
  }

  return {
    scoringRunId,
    customersScored,
    tokensInput: totalTokensInput,
    tokensOutput: totalTokensOutput,
    costCents: totalCostCents,
    status: finalStatus,
    capReached,
  };
}
