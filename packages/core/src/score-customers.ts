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
}

interface TokenCapRow {
  id: string;
  daily_token_cap: number;
  period_start: string;
  tokens_used_today: number;
}

const DEFAULT_TOKEN_CAP = 10_000_000;

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
    .select("shopify_customer_gid,lifecycle_stage,last_scored_at,last_engagement_event_at")
    .eq("merchant_id", merchantId)
    .in("shopify_customer_gid", gids);

  if (statesErr) throw statesErr;

  const stateMap = new Map(
    ((states ?? []) as InferredStateEligibilityRow[]).map((s) => [s.shopify_customer_gid, s]),
  );

  return customerList
    .filter((c) => {
      const state = stateMap.get(c.shopify_customer_gid);
      // Exclude churned customers — scoring is ineffective for them.
      if (state?.lifecycle_stage === "churned") return false;
      if (forceFullRescore) return true;
      if (!state?.last_scored_at) return true; // never scored
      // Skip if no new engagement signal since last score.
      const lastScored = new Date(state.last_scored_at).getTime();
      const lastEngaged = state.last_engagement_event_at
        ? new Date(state.last_engagement_event_at).getTime()
        : 0;
      return lastEngaged > lastScored;
    })
    .map((c) => {
      const avgOrderValueCents =
        c.total_order_count > 0 ? Math.round(c.total_ltv_cents / c.total_order_count) : 0;
      const state = stateMap.get(c.shopify_customer_gid);
      return {
        shopifyCustomerGid: c.shopify_customer_gid,
        totalOrderCount: c.total_order_count,
        lastOrderDaysAgo: c.last_order_days_ago,
        firstOrderDaysAgo: null,
        totalLtvCents: c.total_ltv_cents,
        ordersInPast12Months: 0,
        engagementEventsInPast90Days: 0,
        lifecycleStage: state?.lifecycle_stage ?? "lapsed",
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
  const { error } = await serviceClient
    .from("customer_inferred_state")
    .upsert(
      {
        merchant_id: merchantId,
        shopify_customer_gid: gid,
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
}

export async function scoreCustomers(
  serviceClient: LapsedSupabaseClient,
  anthropicClient: Anthropic,
  opts: ScoreCustomersOpts,
): Promise<ScoreCustomersResult> {
  const { merchantId, medianAovCents, forceFullRescore = false } = opts;
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
    const remainingTokens = (cap.daily_token_cap ?? DEFAULT_TOKEN_CAP) - cap.tokens_used_today;

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
        let batchResult: ScoringBatchResult;

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
        if (cap.tokens_used_today + totalTokensInput + totalTokensOutput >= cap.daily_token_cap) {
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
