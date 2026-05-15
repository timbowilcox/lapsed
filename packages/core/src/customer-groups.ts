import type { LifecycleStage } from "./customer-lifecycle";

export type GroupSlug =
  | "lapsed_vips"
  | "at_risk_regulars"
  | "single_purchase_converters"
  | "price_sensitive_lapsed"
  | "recent_first_purchasers"
  | "win_backs_at_risk";

/**
 * Minimal customer snapshot needed for group assignment.
 * All monetary values in cents. lifecycle must be pre-computed by classifyLifecycle.
 */
export interface CustomerForGrouping {
  totalOrderCount: number;
  totalLtvCents: number;
  lastOrderDaysAgo: number | null;
  firstOrderDaysAgo: number | null;
  lifecycle: LifecycleStage;
  engagementEventsInPast30Days: number;
}

/**
 * Merchant-level aggregate context sourced from the merchant_aggregates
 * materialized view (refreshed nightly by the RFM batch).
 * All monetary values in cents.
 */
export interface MerchantContext {
  ltvP90Cents: number;
  ltvP75Cents: number;
  medianLtvCents: number;
  medianAovCents: number;
}

/**
 * Assign a customer to zero or more system-defined groups.
 *
 * Pure function — same inputs, same output. No side effects.
 * Results are written to customer_inferred_state.group_memberships (a cache).
 * A customer can belong to multiple groups simultaneously.
 *
 * Templates (Sprint 04):
 * 1. lapsed_vips             — lapsed + top-10% LTV (≥ P90)
 * 2. at_risk_regulars        — at_risk + ≥ 3 orders
 * 3. single_purchase_converters — 1 order, >60 days old, AOV > merchant median
 * 4. price_sensitive_lapsed  — lapsed, ≥ 2 orders, avg order < merchant median AOV
 * 5. recent_first_purchasers — new lifecycle, first order ≥ 14 days ago
 * 6. win_backs_at_risk       — won_back lifecycle, no engagement in past 30 days
 */
export function assignGroups(
  customer: CustomerForGrouping,
  merchantContext: MerchantContext,
): GroupSlug[] {
  const {
    totalOrderCount,
    totalLtvCents,
    lastOrderDaysAgo,
    firstOrderDaysAgo,
    lifecycle,
    engagementEventsInPast30Days,
  } = customer;

  const { ltvP90Cents, medianAovCents } = merchantContext;
  const avgOrderValueCents = totalOrderCount > 0
    ? Math.round(totalLtvCents / totalOrderCount)
    : 0;

  const groups: GroupSlug[] = [];

  // 1. Lapsed VIPs — lapsed lifecycle and LTV in top 10% of merchant's distribution.
  if (lifecycle === "lapsed" && totalLtvCents >= ltvP90Cents) {
    groups.push("lapsed_vips");
  }

  // 2. At-risk regulars — at_risk with a meaningful purchase history.
  if (lifecycle === "at_risk" && totalOrderCount >= 3) {
    groups.push("at_risk_regulars");
  }

  // 3. Single-purchase converters — 1 order, not recent, order value exceeds median AOV.
  //    These are customers worth a personalised nudge toward a second purchase.
  if (
    totalOrderCount === 1 &&
    lastOrderDaysAgo !== null &&
    lastOrderDaysAgo > 60 &&
    totalLtvCents > medianAovCents
  ) {
    groups.push("single_purchase_converters");
  }

  // 4. Price-sensitive lapsed — lapsed multi-buyers whose avg order is below median.
  //    These respond better to discount or value-framed re-engagement.
  if (
    lifecycle === "lapsed" &&
    totalOrderCount >= 2 &&
    avgOrderValueCents < medianAovCents
  ) {
    groups.push("price_sensitive_lapsed");
  }

  // 5. Recent first-purchasers — new customers who are now warm enough for
  //    a second-purchase nudge (at least 14 days post-purchase).
  if (lifecycle === "new" && firstOrderDaysAgo !== null && firstOrderDaysAgo >= 14) {
    groups.push("recent_first_purchasers");
  }

  // 6. Win-backs at risk — won-back customers who've gone quiet again.
  //    No engagement in 30 days signals the reactivation is losing momentum.
  if (lifecycle === "won_back" && engagementEventsInPast30Days === 0) {
    groups.push("win_backs_at_risk");
  }

  return groups;
}
