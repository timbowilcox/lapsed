import { describe, expect, it } from "vitest";
import {
  computeIncrementalRevenue,
  campaignCalendarWindow,
} from "../src/incremental-revenue";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";

const day = (n: number): string =>
  new Date(Date.UTC(2026, 3, 1) + n * 86_400_000).toISOString();

interface OrderSpec {
  /** index into the cohort (0-based) */
  customer: number;
  cents: number;
  /** day offset for shopify_created_at */
  placedDay: number;
}

/**
 * Seeds a campaign with `treatmentCount` treatment customers (each with a
 * conversation + a day-0 campaign outbound) and `holdoutCount` holdout
 * customers (frozen snapshot rows). Orders are attached by cohort index.
 */
function seedCampaign(opts: {
  treatmentCount: number;
  holdoutCount: number;
  treatmentOrders?: OrderSpec[];
  holdoutOrders?: OrderSpec[];
  windowDays?: number;
}) {
  const windowDays = opts.windowDays ?? 14;
  const conversations: FakeRow[] = [];
  const messages: FakeRow[] = [];
  const snapshots: FakeRow[] = [];
  const orders: FakeRow[] = [];

  for (let i = 0; i < opts.treatmentCount; i++) {
    const cid = `t${i}`;
    conversations.push({ id: `conv-${cid}`, merchant_id: MERCHANT, customer_id: cid });
    // Symmetric ITT (decision 27): the treatment cohort is the frozen snapshot.
    snapshots.push({
      proposal_id: CAMPAIGN,
      merchant_id: MERCHANT,
      customer_id: cid,
      included_in_holdout: false,
    });
    messages.push({
      id: `mt${i}`,
      merchant_id: MERCHANT,
      conversation_id: `conv-${cid}`,
      direction: "outbound",
      campaign_id: CAMPAIGN,
      arm_id: `arm-${i % 3}`,
      sent_at: day(0),
    });
  }
  for (let i = 0; i < opts.holdoutCount; i++) {
    snapshots.push({
      proposal_id: CAMPAIGN,
      merchant_id: MERCHANT,
      customer_id: `h${i}`,
      included_in_holdout: true,
    });
  }
  let orderSeq = 0;
  for (const o of opts.treatmentOrders ?? []) {
    orders.push({
      id: `o${orderSeq++}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: `t${o.customer}`,
      total_price_cents: o.cents,
      shopify_created_at: day(o.placedDay),
    });
  }
  for (const o of opts.holdoutOrders ?? []) {
    orders.push({
      id: `o${orderSeq++}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: `h${o.customer}`,
      total_price_cents: o.cents,
      shopify_created_at: day(o.placedDay),
    });
  }

  return makeFakeSupabase({
    campaign_proposals: [
      { id: CAMPAIGN, merchant_id: MERCHANT, attribution_window_days: windowDays },
    ],
    conversations,
    messages,
    campaign_group_snapshots: snapshots,
    orders,
  });
}

/** N order specs: the first `buyers` customers each place one `cents` order. */
function buyers(count: number, cents: number, placedDay = 5): OrderSpec[] {
  return Array.from({ length: count }, (_, i) => ({ customer: i, cents, placedDay }));
}

describe("campaignCalendarWindow", () => {
  it("anchors a windowDays-long window at launched_at (the earliest send) — decision 27", () => {
    const outbounds = [
      { messageId: "m1", customerId: "c1", campaignId: CAMPAIGN, armId: null, sentAt: day(2) },
      { messageId: "m2", customerId: "c2", campaignId: CAMPAIGN, armId: null, sentAt: day(0) },
      { messageId: "m3", customerId: "c3", campaignId: CAMPAIGN, armId: null, sentAt: day(10) },
    ];
    const w = campaignCalendarWindow(outbounds, 14);
    expect(w.startIso).toBe(day(0)); // earliest of {0,2,10} — NOT the median
    expect(w.endIso).toBe(day(14)); // launched_at + 14 days
  });

  it("is unaffected by send spread — only the earliest send anchors the window", () => {
    const outbounds = [
      { messageId: "m1", customerId: "c1", campaignId: CAMPAIGN, armId: null, sentAt: day(4) },
      { messageId: "m2", customerId: "c2", campaignId: CAMPAIGN, armId: null, sentAt: day(0) },
      { messageId: "m3", customerId: "c3", campaignId: CAMPAIGN, armId: null, sentAt: day(2) },
      { messageId: "m4", customerId: "c4", campaignId: CAMPAIGN, armId: null, sentAt: day(10) },
    ];
    // launched_at = day 0 regardless of the later sends.
    const w = campaignCalendarWindow(outbounds, 14);
    expect(w.startIso).toBe(day(0));
    expect(w.endIso).toBe(day(14));
  });

  it("throws when the campaign has no outbounds", () => {
    expect(() => campaignCalendarWindow([], 14)).toThrow(/no outbounds/);
  });

  it("throws on a malformed sent_at", () => {
    const outbounds = [
      { messageId: "m1", customerId: "c1", campaignId: CAMPAIGN, armId: null, sentAt: "not-a-date" },
    ];
    expect(() => campaignCalendarWindow(outbounds, 14)).toThrow(/invalid sent_at/);
  });
});

describe("computeIncrementalRevenue", () => {
  it("computes positive incremental revenue with a CI when both cohorts are sufficient", async () => {
    // 40 treatment, 20 of whom buy $50; 40 holdout, 4 of whom buy $50.
    const { client } = seedCampaign({
      treatmentCount: 40,
      holdoutCount: 40,
      treatmentOrders: buyers(20, 5000),
      holdoutOrders: buyers(4, 5000),
    });
    const r = await computeIncrementalRevenue(client, CAMPAIGN);

    expect(r.treatmentCohortSize).toBe(40);
    expect(r.holdoutCohortSize).toBe(40);
    expect(r.treatmentRevenueCents).toBe(100_000); // 20 × 5000
    expect(r.holdoutRevenueCents).toBe(20_000); // 4 × 5000
    // treatment per-customer 2500, holdout per-customer 500 → incremental 2000.
    expect(r.incrementalPerCustomerCents).toBeCloseTo(2000, 6);
    expect(r.incrementalRevenueCents).toBe(80_000); // 2000 × 40
    expect(r.insufficientEvidence).toBe(false);
    expect(r.incrementalCiLowCents).not.toBeNull();
    expect(r.incrementalCiHighCents).not.toBeNull();
    // A real lift — the interval excludes zero.
    expect(r.incrementalCiLowCents!).toBeGreaterThan(0);
    // Point estimate sits inside its own interval.
    expect(r.incrementalCiLowCents!).toBeLessThanOrEqual(r.incrementalRevenueCents);
    expect(r.incrementalCiHighCents!).toBeGreaterThanOrEqual(r.incrementalRevenueCents);
  });

  it("flags insufficient_evidence and emits no CI when a cohort is below 30", async () => {
    const { client } = seedCampaign({
      treatmentCount: 29, // below threshold
      holdoutCount: 40,
      treatmentOrders: buyers(10, 5000),
      holdoutOrders: buyers(4, 5000),
    });
    const r = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(r.insufficientEvidence).toBe(true);
    expect(r.incrementalCiLowCents).toBeNull();
    expect(r.incrementalCiHighCents).toBeNull();
    // Raw counts are still returned.
    expect(r.treatmentCohortSize).toBe(29);
    expect(r.treatmentRevenueCents).toBe(50_000);
  });

  it("surfaces a negative incremental cleanly when the holdout outperforms treatment", async () => {
    // Treatment 40 customers, 5 buy; holdout 40, 20 buy. Holdout wins.
    const { client } = seedCampaign({
      treatmentCount: 40,
      holdoutCount: 40,
      treatmentOrders: buyers(5, 5000),
      holdoutOrders: buyers(20, 5000),
    });
    const r = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(r.incrementalPerCustomerCents).toBeLessThan(0);
    expect(r.incrementalRevenueCents).toBeLessThan(0);
    expect(r.insufficientEvidence).toBe(false);
    // No special-casing — a negative CI is returned, not hidden.
    expect(r.incrementalCiHighCents).not.toBeNull();
    expect(r.incrementalCiHighCents!).toBeLessThan(0);
  });

  it("returns ~zero incremental with a zero-bracketing CI when cohorts are indistinguishable", async () => {
    // Both cohorts ~20% conversion at $50.
    const { client } = seedCampaign({
      treatmentCount: 40,
      holdoutCount: 40,
      treatmentOrders: buyers(8, 5000),
      holdoutOrders: buyers(8, 5000),
    });
    const r = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(r.incrementalRevenueCents).toBe(0);
    expect(r.incrementalCiLowCents!).toBeLessThan(0);
    expect(r.incrementalCiHighCents!).toBeGreaterThan(0);
  });

  it("emits only integer-cent values for the persisted fields", async () => {
    // Revenue that does not divide evenly by the cohort size — the per-customer
    // means are fractional but the reported integer fields must be whole cents.
    const { client } = seedCampaign({
      treatmentCount: 33,
      holdoutCount: 31,
      treatmentOrders: buyers(7, 3333),
      holdoutOrders: buyers(3, 3333),
    });
    const r = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(Number.isInteger(r.incrementalRevenueCents)).toBe(true);
    expect(Number.isInteger(r.incrementalCiLowCents!)).toBe(true);
    expect(Number.isInteger(r.incrementalCiHighCents!)).toBe(true);
    expect(Number.isInteger(r.treatmentRevenueCents)).toBe(true);
    expect(Number.isInteger(r.holdoutRevenueCents)).toBe(true);
  });

  it("returns zeros and insufficient_evidence for a campaign that has not launched", async () => {
    const { client } = seedCampaign({ treatmentCount: 0, holdoutCount: 40 });
    const r = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(r.insufficientEvidence).toBe(true);
    expect(r.incrementalRevenueCents).toBe(0);
    expect(r.incrementalCiLowCents).toBeNull();
  });

  it("rejects a non-UUID campaignId", async () => {
    const { client } = seedCampaign({ treatmentCount: 0, holdoutCount: 0 });
    await expect(computeIncrementalRevenue(client, "not-a-uuid")).rejects.toThrow(/campaignId/);
  });
});
