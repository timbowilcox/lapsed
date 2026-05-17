// Incremental revenue calculator — Sprint 08 chunk 6.
//
// Orchestrates the treatment engine (chunk 4) and the holdout engine (chunk 5)
// into the headline number Sprint 09 bills on: the incremental revenue a
// campaign produced over its matched holdout, with a 95% confidence interval.
//
//   treatment_per_customer  = treatment_revenue / treatment_cohort_size
//   holdout_per_customer    = holdout_revenue   / holdout_cohort_size
//   incremental_per_customer = treatment_per_customer − holdout_per_customer
//   incremental_total        = incremental_per_customer × treatment_cohort_size
//
// The CI comes from Welch's t-test on the two per-customer revenue
// distributions (chunk 6's welch.ts). If EITHER cohort has fewer than
// INSUFFICIENT_EVIDENCE_MIN_COHORT (30) customers, no CI is computed — the
// result carries insufficient_evidence = true with the raw counts only. A CI
// on a tiny sample is confidently wrong; the threshold is the safety rail.
//
// All currency is integer cents. Per-customer means are inherently fractional
// during the statistics; only the final reported integer-cents fields are
// rounded (Math.round) — never floating dollars.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { getTreatmentCohort, getTreatmentOrders, type CampaignOutbound } from "./attribution-treatment";
import { getHoldoutCohort, getHoldoutOrders, type CalendarWindow } from "./attribution-holdout";
import { welchConfidenceInterval } from "./stats/welch";

const DAY_MS = 86_400_000;

/**
 * Minimum customers per cohort before a confidence interval is computed. Below
 * this, the result is returned with raw counts and insufficient_evidence=true.
 * Hardcoded by design — it is a statistical safety rail, not a tuning knob.
 */
export const INSUFFICIENT_EVIDENCE_MIN_COHORT = 30;

export interface IncrementalRevenueResult {
  campaignId: string;
  treatmentCohortSize: number;
  holdoutCohortSize: number;
  treatmentRevenueCents: number;
  holdoutRevenueCents: number;
  /** Mean treatment revenue per cohort customer (fractional cents). */
  treatmentPerCustomerCents: number;
  /** Mean holdout revenue per cohort customer (fractional cents). */
  holdoutPerCustomerCents: number;
  /** treatment_per_customer − holdout_per_customer (fractional cents). */
  incrementalPerCustomerCents: number;
  /** incremental_per_customer × treatment_cohort_size, rounded to integer cents. */
  incrementalRevenueCents: number;
  /** 95% CI lower bound on total incremental revenue; null when insufficient. */
  incrementalCiLowCents: number | null;
  /** 95% CI upper bound on total incremental revenue; null when insufficient. */
  incrementalCiHighCents: number | null;
  /** True when either cohort is below the 30-customer threshold. */
  insufficientEvidence: boolean;
}

/**
 * The campaign-calendar window over which BOTH cohorts are measured (decision
 * 27): anchored at `launched_at` — the campaign's EARLIEST outbound — and
 * `windowDays` long. This is exactly the window `getTreatmentOrders` uses for
 * the treatment cohort, so the holdout cohort is measured over the identical
 * `[launched_at, launched_at + windowDays]` interval. Methodological symmetry
 * (decision 27) requires the same anchor on both sides.
 *
 * Sprint 08 anchored this at the MEDIAN send time, which left the treatment
 * (per-customer windows) and holdout (median calendar window) cohorts measured
 * over different intervals. Anchoring both at `launched_at` removes that
 * asymmetry. Exported so the LTV calculator anchors its post-window identically.
 */
export function campaignCalendarWindow(
  outbounds: readonly CampaignOutbound[],
  windowDays: number,
): CalendarWindow {
  if (outbounds.length === 0) {
    throw new Error("campaignCalendarWindow: campaign has no outbounds to anchor the window");
  }
  let launchedMs = Infinity;
  for (const o of outbounds) {
    const ms = new Date(o.sentAt).getTime();
    if (!Number.isFinite(ms)) {
      throw new Error(`campaignCalendarWindow: invalid sent_at on message ${o.messageId}`);
    }
    if (ms < launchedMs) launchedMs = ms;
  }
  return {
    startIso: new Date(launchedMs).toISOString(),
    endIso: new Date(launchedMs + windowDays * DAY_MS).toISOString(),
  };
}

/**
 * Computes the incremental revenue of a campaign against its holdout, with a
 * 95% confidence interval. Reads only — the attribution batch cron (chunk 9)
 * is what persists the result into `attribution_results`.
 */
export async function computeIncrementalRevenue(
  client: LapsedSupabaseClient,
  campaignId: string,
): Promise<IncrementalRevenueResult> {
  z.string().uuid("campaignId must be a UUID").parse(campaignId);

  const treatmentCohort = await getTreatmentCohort(client, campaignId);
  const treatmentOrders = await getTreatmentOrders(client, treatmentCohort);
  const holdoutCohort = await getHoldoutCohort(client, campaignId);

  const treatmentCohortSize = treatmentCohort.cohort.length;
  const holdoutCohortSize = holdoutCohort.cohort.length;

  // A campaign with no outbounds has not launched — there is nothing to
  // measure. Return explicit zeros rather than computing against an
  // undefined window.
  if (treatmentCohort.outbounds.length === 0) {
    return {
      campaignId,
      treatmentCohortSize,
      holdoutCohortSize,
      treatmentRevenueCents: 0,
      holdoutRevenueCents: 0,
      treatmentPerCustomerCents: 0,
      holdoutPerCustomerCents: 0,
      incrementalPerCustomerCents: 0,
      incrementalRevenueCents: 0,
      incrementalCiLowCents: null,
      incrementalCiHighCents: null,
      insufficientEvidence: true,
    };
  }

  const window = campaignCalendarWindow(treatmentCohort.outbounds, treatmentCohort.windowDays);
  const holdoutOrders = await getHoldoutOrders(client, holdoutCohort, window);

  const treatmentRevenueCents = treatmentOrders.revenueCents;
  const holdoutRevenueCents = holdoutOrders.revenueCents;
  const treatmentPerCustomerCents =
    treatmentCohortSize > 0 ? treatmentRevenueCents / treatmentCohortSize : 0;
  const holdoutPerCustomerCents =
    holdoutCohortSize > 0 ? holdoutRevenueCents / holdoutCohortSize : 0;
  const incrementalPerCustomerCents = treatmentPerCustomerCents - holdoutPerCustomerCents;
  const incrementalRevenueCents = Math.round(incrementalPerCustomerCents * treatmentCohortSize);

  const insufficientEvidence =
    treatmentCohortSize < INSUFFICIENT_EVIDENCE_MIN_COHORT ||
    holdoutCohortSize < INSUFFICIENT_EVIDENCE_MIN_COHORT;

  const base = {
    campaignId,
    treatmentCohortSize,
    holdoutCohortSize,
    treatmentRevenueCents,
    holdoutRevenueCents,
    treatmentPerCustomerCents,
    holdoutPerCustomerCents,
    incrementalPerCustomerCents,
    incrementalRevenueCents,
  };

  if (insufficientEvidence) {
    // Below threshold — never compute a CI on a tiny sample.
    return {
      ...base,
      incrementalCiLowCents: null,
      incrementalCiHighCents: null,
      insufficientEvidence: true,
    };
  }

  // Welch's t-test on the per-customer revenue distributions. meanDifference
  // equals incrementalPerCustomerCents by construction. The CI on the TOTAL
  // is the per-customer CI scaled by the treatment cohort size.
  const welch = welchConfidenceInterval(
    treatmentOrders.perCustomerRevenueCents,
    holdoutOrders.perCustomerRevenueCents,
  );

  return {
    ...base,
    incrementalCiLowCents: Math.round(welch.ciLow * treatmentCohortSize),
    incrementalCiHighCents: Math.round(welch.ciHigh * treatmentCohortSize),
    insufficientEvidence: false,
  };
}
