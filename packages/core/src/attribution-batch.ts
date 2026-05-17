// Attribution batch — Sprint 08 chunk 9 (decision 26).
//
// The nightly orchestrator. For every approved-and-launched campaign whose
// attribution window has closed, it:
//   1. computes incremental revenue (chunk 6) + LTV restoration (chunk 8),
//   2. fires the ground-truth bandit ORDER posterior (chunk 7) — success for
//      every attributed order, failure for every ARM-EXPOSED customer who
//      placed no order in the window. Under symmetric ITT (decision 27, Sprint
//      09 chunk 3) the cohort includes opt-out / cap-deferred customers who
//      received no outbound: a `no_order` attribution_decisions row is written
//      for every ITT cohort member (audit trail + ITT denominator), but the
//      bandit posterior is moved ONLY for customers an arm actually reached.
//      A never-sent customer was exposed to no arm, so their non-conversion is
//      not a signal about any arm's efficacy — booking it onto an arm would
//      contaminate the arm-selection posterior with the campaign's send rate.
//      Effective reach is captured separately, in attribution_results'
//      treatment_cohort_size (the ITT denominator),
//   3. materialises one `attribution_results` row per (campaign, window-close).
//
// IDEMPOTENT. The UNIQUE on `attribution_results (campaign_id, window_close_date)`
// plus a pre-check means a re-run skips an already-materialised campaign. The
// bandit record* helpers (chunk 7) are independently idempotent on their
// decision rows. Re-running the cron the next night is a safe no-op for
// campaigns already done.
//
// INSUFFICIENT EVIDENCE. When either cohort is below the 30-customer threshold
// the `attribution_results` row is still written (with `insufficient_evidence`
// = true and null CIs) but the bandit posteriors are NOT fired — a low-
// confidence cohort must not pollute the order posterior.
//
// This module is the ONLY write path to `attribution_results` (decision 26).

import type { LapsedSupabaseClient } from "@lapsed/db";
import { getTreatmentCohort, getTreatmentOrders } from "./attribution-treatment";
import { computeIncrementalRevenue } from "./incremental-revenue";
import { computeLtvRestoration } from "./ltv-restoration";
import { recordOrderArrival, recordNoOrderOutcome } from "./bandit-order";

const DAY_MS = 86_400_000;

export interface RunAttributionBatchOptions {
  /** Restrict the run to one merchant; omit to process every merchant. */
  merchantId?: string;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

export interface AttributionBatchResult {
  merchantsProcessed: number;
  /** Campaigns whose window closed and were materialised this run. */
  campaignsComputed: number;
  /** Campaigns skipped — window still open or already materialised. */
  campaignsSkipped: number;
  /** attribution_results rows written. */
  resultsWritten: number;
  errors: number;
}

interface MerchantRow {
  id: string;
}

interface CampaignRow {
  id: string;
}

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

/** YYYY-MM-DD (UTC) of an epoch-ms instant. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Extracts a diagnosable message from any thrown value — including the plain
 * `{ message, code }` objects Supabase / PostgREST throw (which are not Error
 * instances, so a bare String() of them yields a useless "[object Object]").
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Runs the attribution batch. Read CLAUDE.md decision 26 — this is the sole
 * write path to `attribution_results`.
 */
export async function runAttributionBatch(
  client: LapsedSupabaseClient,
  opts: RunAttributionBatchOptions = {},
): Promise<AttributionBatchResult> {
  const now = opts.now ?? (() => new Date());
  const today = isoDate(now().getTime());

  const result: AttributionBatchResult = {
    merchantsProcessed: 0,
    campaignsComputed: 0,
    campaignsSkipped: 0,
    resultsWritten: 0,
    errors: 0,
  };

  // Resolve the merchant set.
  let merchants: MerchantRow[];
  if (opts.merchantId) {
    merchants = [{ id: opts.merchantId }];
  } else {
    const { data, error } = await client.from("merchants").select("id");
    if (error) throw error;
    merchants = (data ?? []) as MerchantRow[];
  }

  for (const merchant of merchants) {
    result.merchantsProcessed += 1;

    // Approved campaign proposals for this merchant. status is the materialized
    // cache of the campaign_events log (decision 13).
    const { data: campaignRows, error: campaignErr } = await client
      .from("campaign_proposals")
      .select("id")
      .eq("merchant_id", merchant.id)
      .eq("status", "approved");
    if (campaignErr) throw campaignErr;

    for (const campaign of (campaignRows ?? []) as CampaignRow[]) {
      const startedAt = Date.now();
      try {
        const computed = await processCampaign(client, merchant.id, campaign.id, today, now);
        if (computed) {
          result.campaignsComputed += 1;
          result.resultsWritten += 1;
        } else {
          result.campaignsSkipped += 1;
        }
        console.info(
          `attribution_batch merchant=${merchant.id} campaign=${campaign.id} ` +
            `computed=${computed} elapsed_ms=${Date.now() - startedAt}`,
        );
      } catch (err) {
        result.errors += 1;
        console.error(
          JSON.stringify({
            event: "attribution_batch_campaign_error",
            merchant_id: merchant.id,
            campaign_id: campaign.id,
            error: errorMessage(err),
          }),
        );
      }
    }
  }

  return result;
}

/**
 * Processes one campaign. Returns true when an `attribution_results` row was
 * materialised, false when the campaign was skipped (not launched, window
 * still open, or already computed).
 */
async function processCampaign(
  client: LapsedSupabaseClient,
  merchantId: string,
  campaignId: string,
  today: string,
  now: () => Date,
): Promise<boolean> {
  // Treatment cohort gives us the campaign's outbounds (→ launch time) and the
  // stamped attribution window.
  const cohort = await getTreatmentCohort(client, campaignId);
  if (cohort.outbounds.length === 0) {
    return false; // not launched — no outbounds to anchor a window
  }

  // launched_at = the campaign's earliest outbound. The window closes
  // attribution_window_days later; the batch only materialises CLOSED windows.
  let launchedMs = Infinity;
  for (const ob of cohort.outbounds) {
    const ms = new Date(ob.sentAt).getTime();
    if (Number.isFinite(ms) && ms < launchedMs) launchedMs = ms;
  }
  // Every outbound had an unparseable sent_at — fail loud rather than let
  // isoDate(Infinity) throw an opaque RangeError.
  if (!Number.isFinite(launchedMs)) {
    throw new Error(
      `attribution-batch: campaign ${campaignId} has no outbound with a valid sent_at`,
    );
  }
  const windowCloseDate = isoDate(launchedMs + cohort.windowDays * DAY_MS);
  if (windowCloseDate > today) {
    return false; // window still open — skip until it closes
  }

  // Idempotency: a row for (campaign, window-close) means this is done.
  const { data: existing, error: existErr } = await client
    .from("attribution_results")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("window_close_date", windowCloseDate)
    .maybeSingle();
  if (existErr) throw existErr;
  if (existing) return false;

  // Compute the headline numbers (chunks 6 + 8). computeLtvRestoration also
  // materialises the per-customer ltv_snapshots rows.
  const incremental = await computeIncrementalRevenue(client, campaignId);
  const ltv = await computeLtvRestoration(client, campaignId);

  // The attributed orders + the no-order treatment customers, for the bandit.
  const treatmentOrders = await getTreatmentOrders(client, cohort);

  // Fire the ground-truth bandit ORDER posterior — but ONLY when evidence is
  // sufficient. A sub-30 cohort is too noisy to feed the posterior.
  if (!incremental.insufficientEvidence) {
    // Most-recent outbound arm per SENT customer (decision 19 pattern).
    const armByCustomer = new Map<string, { armId: string | null; sentMs: number }>();
    for (const ob of cohort.outbounds) {
      const sentMs = new Date(ob.sentAt).getTime();
      const prior = armByCustomer.get(ob.customerId);
      if (!prior || sentMs > prior.sentMs) {
        armByCustomer.set(ob.customerId, { armId: ob.armId, sentMs });
      }
    }

    // Symmetric-ITT bandit signal (decision 27, Sprint 09 chunk 3). The
    // treatment cohort (`cohort.cohort`) is now the full ITT snapshot — it
    // includes opt-out / daily-cap-deferred customers who received NO outbound.
    //
    // A `no_order` attribution_decisions row is written for EVERY ITT cohort
    // member with no attributed order (audit trail + the ITT denominator's
    // idempotency stamp). But the bandit ORDER posterior is moved only for a
    // customer an arm actually reached: `recordNoOrderOutcome` fires the
    // posterior only when `armId` is non-null.
    //
    // A never-sent customer was exposed to NO arm — their non-conversion is
    // not a signal about any arm's offer/tone/timing efficacy, so it must not
    // touch a per-arm posterior (decisions 4/14/19/22; mid-sprint checkpoint
    // ruling). Booking it onto an arm would make the arm-selection posterior a
    // function of the campaign's send rate rather than the arm's efficacy, and
    // arms are reused across campaigns. The campaign's effective reach is
    // already captured — correctly — in attribution_results.treatment_cohort_size
    // (the ITT denominator) and in the incremental-revenue per-customer math.
    const customersWithOrder = new Set<string>();
    for (const order of treatmentOrders.orders) {
      customersWithOrder.add(order.customerId);
      await recordOrderArrival(client, {
        merchantId,
        campaignId,
        orderId: order.orderId,
        customerId: order.customerId,
        attributedMessageId: order.attributedMessageId,
        armId: order.attributedArmId,
        attributionWindowDays: cohort.windowDays,
      });
    }

    // Every ITT cohort customer with no attributed order gets a `no_order`
    // decision row. armId is the customer's own outbound arm when they were
    // sent to, else null — a never-sent customer moves no posterior.
    for (const customerId of cohort.cohort) {
      if (customersWithOrder.has(customerId)) continue;
      await recordNoOrderOutcome(client, {
        merchantId,
        campaignId,
        customerId,
        armId: armByCustomer.get(customerId)?.armId ?? null,
        attributionWindowDays: cohort.windowDays,
      });
    }
  }

  // Materialise the attribution_results row — the sole write path (decision 26).
  const { error: insertErr } = await client.from("attribution_results").insert({
    merchant_id: merchantId,
    campaign_id: campaignId,
    window_close_date: windowCloseDate,
    treatment_cohort_size: incremental.treatmentCohortSize,
    holdout_cohort_size: incremental.holdoutCohortSize,
    treatment_revenue_cents: incremental.treatmentRevenueCents,
    holdout_revenue_cents: incremental.holdoutRevenueCents,
    incremental_revenue_cents: incremental.incrementalRevenueCents,
    incremental_ci_low_cents: incremental.incrementalCiLowCents,
    incremental_ci_high_cents: incremental.incrementalCiHighCents,
    ltv_restored_cents: ltv.ltvRestoredCents,
    ltv_ci_low_cents: ltv.ltvCiLowCents,
    ltv_ci_high_cents: ltv.ltvCiHighCents,
    insufficient_evidence: incremental.insufficientEvidence,
    computed_at: now().toISOString(),
  });
  if (insertErr) {
    // A concurrent run won the race — the row is materialised, treat as done.
    if (isUniqueViolation(insertErr)) return false;
    throw insertErr;
  }

  console.info(
    `attribution_batch_result merchant=${merchantId} campaign=${campaignId} ` +
      `window_close_date=${windowCloseDate} treatment_size=${incremental.treatmentCohortSize} ` +
      `holdout_size=${incremental.holdoutCohortSize} ` +
      `incremental_revenue_cents=${incremental.incrementalRevenueCents} ` +
      `insufficient_evidence=${incremental.insufficientEvidence}`,
  );
  return true;
}
