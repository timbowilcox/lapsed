// Holdout cohort engine — Sprint 08 chunk 5.
//
// The holdout cohort of a campaign is the deterministic ~10% control group
// frozen into `campaign_group_snapshots` at proposal time (decision 15). These
// customers received NO outbound, so they have no per-customer send anchor —
// their orders are counted over a single CALENDAR window supplied by the
// caller (chunk 6 derives it from the treatment cohort's send dates so the two
// cohorts are measured over a comparable period).
//
// The holdout snapshot is the source of truth: re-scoring or lifecycle drift
// in the underlying group after proposal time does NOT change this set
// (decision 15). getHoldoutCohort reads the frozen snapshot rows directly.
//
// All currency is integer cents.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { fetchAllRows, chunk, IN_CLAUSE_CHUNK } from "./paginate";

/** A calendar window [startIso, endIso], both ISO-8601, inclusive. */
export interface CalendarWindow {
  startIso: string;
  endIso: string;
}

export interface HoldoutCohortResult {
  merchantId: string;
  campaignId: string;
  /** Distinct holdout customer ids — the frozen control group (decision 15). */
  cohort: string[];
}

/** An order placed by a holdout customer within the calendar window. */
export interface HoldoutOrder {
  orderId: string;
  customerId: string;
  totalPriceCents: number;
  placedAt: string;
}

export interface HoldoutOrdersResult {
  orders: HoldoutOrder[];
  revenueCents: number;
  customersWithOrders: number;
  /**
   * Per-customer revenue in cents, ONE entry per holdout cohort customer (0
   * when the customer placed no order in the window). This is the holdout
   * distribution Welch's t-test consumes in chunk 6.
   */
  perCustomerRevenueCents: number[];
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
    throw new Error(`attribution-holdout: ${field} on ${id} is not a valid timestamp: ${iso}`);
  }
  return ms;
}

// ─────────────────────────────────────────────────────────────────────────────
// getHoldoutCohort
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a campaign's holdout cohort from the frozen `campaign_group_snapshots`
 * rows where `included_in_holdout = true` (decision 15). The snapshot is keyed
 * by `proposal_id`; this engine never live-recomputes the group.
 */
export async function getHoldoutCohort(
  client: LapsedSupabaseClient,
  campaignId: string,
): Promise<HoldoutCohortResult> {
  z.string().uuid("campaignId must be a UUID").parse(campaignId);

  const { data: proposal, error: proposalErr } = await client
    .from("campaign_proposals")
    .select("merchant_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (proposalErr) throw proposalErr;
  if (!proposal) {
    throw new Error(`getHoldoutCohort: campaign proposal ${campaignId} not found`);
  }
  const merchantId = proposal.merchant_id as string;

  const rows = await fetchAllRows<{ customer_id: string }>((from, to) =>
    client
      .from("campaign_group_snapshots")
      .select("customer_id")
      .eq("proposal_id", campaignId)
      .eq("included_in_holdout", true)
      .range(from, to),
  );

  const cohort = [...new Set(rows.map((r) => r.customer_id))].sort();
  return { merchantId, campaignId, cohort };
}

// ─────────────────────────────────────────────────────────────────────────────
// getHoldoutOrders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counts the orders holdout customers placed within the calendar window
 * `[window.startIso, window.endIso]` (both inclusive). Unlike the treatment
 * cohort there is no per-customer send anchor — every holdout customer is
 * measured over the same calendar window so the cohorts are comparable.
 */
export async function getHoldoutOrders(
  client: LapsedSupabaseClient,
  cohort: HoldoutCohortResult,
  window: CalendarWindow,
): Promise<HoldoutOrdersResult> {
  const { merchantId, cohort: customerIds } = cohort;

  // Validate the caller-supplied window BEFORE the empty-cohort short-circuit:
  // a malformed window must fail loud even against an empty holdout, so chunk 6
  // never mistakes a silent zero for a valid baseline.
  const startMs = epochMs(window.startIso, "window.startIso", "calendar window");
  const endMs = epochMs(window.endIso, "window.endIso", "calendar window");

  if (customerIds.length === 0) {
    return { orders: [], revenueCents: 0, customersWithOrders: 0, perCustomerRevenueCents: [] };
  }

  // Chunk the customer id list — PostgREST encodes `.in(...)` in the URL, so a
  // multi-thousand-customer holdout would overflow it. Each chunk is paged.
  const orderRows: OrderRow[] = [];
  for (const idChunk of chunk(customerIds, IN_CLAUSE_CHUNK)) {
    const rows = await fetchAllRows<OrderRow>((from, to) =>
      client
        .from("orders")
        .select("id, shopify_customer_gid, total_price_cents, shopify_created_at")
        .eq("merchant_id", merchantId)
        .in("shopify_customer_gid", idChunk)
        .range(from, to),
    );
    orderRows.push(...rows);
  }

  const cohortSet = new Set(customerIds);
  const inWindow: HoldoutOrder[] = [];
  for (const o of orderRows) {
    // .in() already scopes to cohort customers; this guard is defence in depth.
    if (!cohortSet.has(o.shopify_customer_gid)) continue;
    // Currency is integer cents end-to-end — reject a non-integer (or NaN)
    // rather than let fractional drift into the Welch input / billing meter.
    if (!Number.isInteger(o.total_price_cents)) {
      throw new Error(
        `attribution-holdout: order ${o.id} total_price_cents is not an integer: ${o.total_price_cents}`,
      );
    }
    const placedMs = epochMs(o.shopify_created_at, "shopify_created_at", o.id);
    if (placedMs < startMs || placedMs > endMs) continue;
    inWindow.push({
      orderId: o.id,
      customerId: o.shopify_customer_gid,
      totalPriceCents: o.total_price_cents,
      placedAt: o.shopify_created_at,
    });
  }

  const revenueByCustomer = new Map<string, number>();
  for (const id of customerIds) revenueByCustomer.set(id, 0);
  for (const o of inWindow) {
    revenueByCustomer.set(o.customerId, (revenueByCustomer.get(o.customerId) ?? 0) + o.totalPriceCents);
  }

  return {
    orders: inWindow,
    revenueCents: inWindow.reduce((sum, o) => sum + o.totalPriceCents, 0),
    customersWithOrders: new Set(inWindow.map((o) => o.customerId)).size,
    perCustomerRevenueCents: customerIds.map((id) => revenueByCustomer.get(id) ?? 0),
  };
}
