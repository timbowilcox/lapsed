// LTV restoration calculator — Sprint 08 chunk 8 (decision 23).
//
// LTV restoration is measured as a COHORT-RELATIVE DELTA — never a modelled
// forecast, never a stay-probability projection. For a campaign:
//
//   treatment customer i  → post_i  = their revenue in the ltvWindow days
//                                     AFTER their (earliest) campaign outbound
//   holdout cohort        → holdout_mean = average revenue of holdout customers
//                                     over the same calendar window (anchored
//                                     at the campaign's median send time, since
//                                     holdout customers have no send anchor)
//   per-customer delta    → delta_i = post_i − holdout_mean
//   restored LTV          → Σ delta_i  = Σ post_i − treatmentSize × holdout_mean
//
// It is a MEASUREMENT of what happened in the observed window, not a forecast.
// The 95% CI comes from Welch's t-test on the two per-customer revenue
// distributions (same machinery as chunk 6). Below the 30-per-cohort
// insufficient-evidence threshold no CI is produced.
//
// Per-customer pre/post markers are materialised into `ltv_snapshots`
// (idempotent upsert on the (campaign_id, customer_id) UNIQUE). All currency
// is integer cents; only the final reported fields are rounded.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { getTreatmentCohort } from "./attribution-treatment";
import { getHoldoutCohort, getHoldoutOrders } from "./attribution-holdout";
import { getLtvEvaluationWindow } from "./attribution-config";
import { campaignCalendarWindow, INSUFFICIENT_EVIDENCE_MIN_COHORT } from "./incremental-revenue";
import { welchConfidenceInterval } from "./stats/welch";
import { fetchAllRows, chunk, IN_CLAUSE_CHUNK } from "./paginate";

const DAY_MS = 86_400_000;

export interface LtvRestorationResult {
  campaignId: string;
  treatmentCohortSize: number;
  holdoutCohortSize: number;
  /** LTV evaluation window in days (merchant-configurable, default 30). */
  ltvWindowDays: number;
  /** Mean post-window revenue per treatment customer (fractional cents). */
  treatmentPostMeanCents: number;
  /** Mean window revenue per holdout customer (fractional cents). */
  holdoutPostMeanCents: number;
  /** treatmentPostMean − holdoutPostMean (fractional cents). */
  ltvDeltaPerCustomerCents: number;
  /** Σ per-customer delta, rounded to integer cents. */
  ltvRestoredCents: number;
  /** 95% CI lower bound on total restored LTV; null when insufficient. */
  ltvCiLowCents: number | null;
  /** 95% CI upper bound on total restored LTV; null when insufficient. */
  ltvCiHighCents: number | null;
  /** True when either cohort is below the 30-customer threshold. */
  insufficientEvidence: boolean;
  /** Count of ltv_snapshots rows materialised (one per treatment customer). */
  snapshotsWritten: number;
}

interface OrderRow {
  id: string;
  shopify_customer_gid: string;
  total_price_cents: number;
  shopify_created_at: string;
}

/** Parses an ISO timestamp to epoch ms, throwing on a malformed value. */
function epochMs(iso: string, field: string, id: string): number {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`ltv-restoration: ${field} on ${id} is not a valid timestamp: ${iso}`);
  }
  return ms;
}

/**
 * Computes a campaign's cohort-relative LTV restoration (decision 23) and
 * materialises the per-customer markers into `ltv_snapshots`. Returns the
 * campaign-level summary the attribution batch cron (chunk 9) folds into
 * `attribution_results`.
 */
export async function computeLtvRestoration(
  client: LapsedSupabaseClient,
  campaignId: string,
): Promise<LtvRestorationResult> {
  z.string().uuid("campaignId must be a UUID").parse(campaignId);

  const treatmentCohort = await getTreatmentCohort(client, campaignId);
  const holdoutCohort = await getHoldoutCohort(client, campaignId);
  const ltvWindowDays = await getLtvEvaluationWindow(client, treatmentCohort.merchantId);

  const treatmentCohortSize = treatmentCohort.cohort.length;
  const holdoutCohortSize = holdoutCohort.cohort.length;

  // A campaign with no outbounds has not launched — nothing to measure.
  if (treatmentCohort.outbounds.length === 0) {
    return {
      campaignId,
      treatmentCohortSize,
      holdoutCohortSize,
      ltvWindowDays,
      treatmentPostMeanCents: 0,
      holdoutPostMeanCents: 0,
      ltvDeltaPerCustomerCents: 0,
      ltvRestoredCents: 0,
      ltvCiLowCents: null,
      ltvCiHighCents: null,
      insufficientEvidence: true,
      snapshotsWritten: 0,
    };
  }

  // Each treatment customer's anchor is their EARLIEST campaign outbound.
  const earliestSendMs = new Map<string, number>();
  for (const ob of treatmentCohort.outbounds) {
    const sentMs = epochMs(ob.sentAt, "sent_at", ob.messageId);
    const prior = earliestSendMs.get(ob.customerId);
    if (prior === undefined || sentMs < prior) earliestSendMs.set(ob.customerId, sentMs);
  }

  // All orders placed by treatment-cohort customers (paged + id-chunked).
  const treatmentOrderRows: OrderRow[] = [];
  for (const idChunk of chunk(treatmentCohort.cohort, IN_CLAUSE_CHUNK)) {
    const rows = await fetchAllRows<OrderRow>((from, to) =>
      client
        .from("orders")
        .select("id, shopify_customer_gid, total_price_cents, shopify_created_at")
        .eq("merchant_id", treatmentCohort.merchantId)
        .in("shopify_customer_gid", idChunk)
        .range(from, to),
    );
    treatmentOrderRows.push(...rows);
  }

  // Per-customer pre/post window revenue, in cohort order.
  const preByCustomer = new Map<string, number>();
  const postByCustomer = new Map<string, number>();
  for (const id of treatmentCohort.cohort) {
    preByCustomer.set(id, 0);
    postByCustomer.set(id, 0);
  }
  const windowMs = ltvWindowDays * DAY_MS;
  for (const o of treatmentOrderRows) {
    const sendMs = earliestSendMs.get(o.shopify_customer_gid);
    if (sendMs === undefined) continue; // not a cohort customer
    if (!Number.isInteger(o.total_price_cents)) {
      throw new Error(
        `ltv-restoration: order ${o.id} total_price_cents is not an integer: ${o.total_price_cents}`,
      );
    }
    const placedMs = epochMs(o.shopify_created_at, "shopify_created_at", o.id);
    // post: (send, send + window]; pre: [send − window, send].
    if (placedMs > sendMs && placedMs <= sendMs + windowMs) {
      postByCustomer.set(
        o.shopify_customer_gid,
        (postByCustomer.get(o.shopify_customer_gid) ?? 0) + o.total_price_cents,
      );
    } else if (placedMs >= sendMs - windowMs && placedMs <= sendMs) {
      preByCustomer.set(
        o.shopify_customer_gid,
        (preByCustomer.get(o.shopify_customer_gid) ?? 0) + o.total_price_cents,
      );
    }
  }

  // Holdout cohort's revenue over the same calendar window, anchored at the
  // campaign's median send time (holdout customers have no send anchor).
  const holdoutWindow = campaignCalendarWindow(treatmentCohort.outbounds, ltvWindowDays);
  const holdoutOrders = await getHoldoutOrders(client, holdoutCohort, holdoutWindow);

  const treatmentPost = treatmentCohort.cohort.map((id) => postByCustomer.get(id) ?? 0);
  const holdoutPerCustomer = holdoutOrders.perCustomerRevenueCents;

  const treatmentPostMeanCents =
    treatmentCohortSize > 0
      ? treatmentPost.reduce((s, v) => s + v, 0) / treatmentCohortSize
      : 0;
  const holdoutPostMeanCents =
    holdoutCohortSize > 0 ? holdoutOrders.revenueCents / holdoutCohortSize : 0;
  const ltvDeltaPerCustomerCents = treatmentPostMeanCents - holdoutPostMeanCents;
  const ltvRestoredCents = Math.round(ltvDeltaPerCustomerCents * treatmentCohortSize);

  // Materialise per-customer markers — delta is the cohort-relative delta
  // (post minus the holdout mean). Idempotent upsert on (campaign_id, customer_id).
  const snapshotRows = treatmentCohort.cohort.map((id) => {
    const post = postByCustomer.get(id) ?? 0;
    return {
      merchant_id: treatmentCohort.merchantId,
      campaign_id: campaignId,
      customer_id: id,
      pre_30d_revenue_cents: preByCustomer.get(id) ?? 0,
      post_30d_revenue_cents: post,
      delta_cents: Math.round(post - holdoutPostMeanCents),
    };
  });
  if (snapshotRows.length > 0) {
    const { error: upsertErr } = await client
      .from("ltv_snapshots")
      .upsert(snapshotRows, { onConflict: "campaign_id,customer_id" });
    if (upsertErr) throw upsertErr;
  }

  const insufficientEvidence =
    treatmentCohortSize < INSUFFICIENT_EVIDENCE_MIN_COHORT ||
    holdoutCohortSize < INSUFFICIENT_EVIDENCE_MIN_COHORT;

  const base = {
    campaignId,
    treatmentCohortSize,
    holdoutCohortSize,
    ltvWindowDays,
    treatmentPostMeanCents,
    holdoutPostMeanCents,
    ltvDeltaPerCustomerCents,
    ltvRestoredCents,
    snapshotsWritten: snapshotRows.length,
  };

  if (insufficientEvidence) {
    return { ...base, ltvCiLowCents: null, ltvCiHighCents: null, insufficientEvidence: true };
  }

  // 95% CI via Welch on the per-customer post-window revenue distributions.
  const welch = welchConfidenceInterval(treatmentPost, holdoutPerCustomer);
  return {
    ...base,
    ltvCiLowCents: Math.round(welch.ciLow * treatmentCohortSize),
    ltvCiHighCents: Math.round(welch.ciHigh * treatmentCohortSize),
    insufficientEvidence: false,
  };
}
