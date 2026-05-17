// Constructed-scenario validation — Sprint 08 chunk 12. THE math-defensibility
// gate: Sprint 09 bills on these numbers, so the attribution engine is exercised
// end-to-end against synthetic data with KNOWN expected outcomes.
//
// The five non-negotiable scenarios (SPRINT.md chunk 12):
//   1. High-lift           — clear positive incremental, CI excludes zero
//   2. Zero-lift           — ~$0 incremental, CI brackets zero
//   3. Negative-lift       — holdout outperforms; negative surfaced cleanly
//   4. Insufficient-evidence — sub-30 cohort → insufficient_evidence, no CI
//   5. Multi-campaign-overlap — single-attribution: most-recent campaign wins
//
// Plus a Monte-Carlo coverage check: Welch's 95% CI must bracket the true mean
// difference in ≈ 95% of runs.
//
// Synthetic data is seeded directly (NOT via the Shopify webhook) — the math is
// what is under test. All amounts integer cents; $50 = 5000.

import { describe, expect, it } from "vitest";
import {
  computeIncrementalRevenue,
  computeLtvRestoration,
  getTreatmentCohort,
  getTreatmentOrders,
  welchConfidenceInterval,
} from "../src/index";
import { mulberry32 } from "../src/bandit";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const day = (n: number): string =>
  new Date(Date.UTC(2026, 3, 1) + n * 86_400_000).toISOString();

interface CampaignSpec {
  id: string;
  windowDays?: number;
  /** outbounds: each treatment customer + the day their outbound was sent */
  treatment: Array<{ customerId: string; sentDay: number }>;
  /** holdout customer ids (frozen snapshot) */
  holdout: string[];
}

/**
 * Seeds one or more campaigns and a shared order set. Customers may appear in
 * several campaigns' treatment lists (scenario 5). One conversation per
 * distinct customer.
 */
function seedScenario(
  campaigns: CampaignSpec[],
  orders: Array<{ customerId: string; cents: number; day: number }>,
) {
  const conversations = new Map<string, FakeRow>();
  const messages: FakeRow[] = [];
  const proposals: FakeRow[] = [];
  const snapshots: FakeRow[] = [];
  let msgSeq = 0;

  for (const c of campaigns) {
    proposals.push({
      id: c.id,
      merchant_id: MERCHANT,
      status: "approved",
      attribution_window_days: c.windowDays ?? 14,
    });
    for (const t of c.treatment) {
      if (!conversations.has(t.customerId)) {
        conversations.set(t.customerId, {
          id: `conv-${t.customerId}`,
          merchant_id: MERCHANT,
          customer_id: t.customerId,
        });
      }
      messages.push({
        id: `m${msgSeq++}`,
        merchant_id: MERCHANT,
        conversation_id: `conv-${t.customerId}`,
        direction: "outbound",
        campaign_id: c.id,
        arm_id: `arm-${c.id}`,
        sent_at: day(t.sentDay),
      });
    }
    for (const h of c.holdout) {
      snapshots.push({
        proposal_id: c.id,
        merchant_id: MERCHANT,
        customer_id: h,
        included_in_holdout: true,
      });
    }
  }

  return makeFakeSupabase({
    campaign_proposals: proposals,
    conversations: [...conversations.values()],
    messages,
    campaign_group_snapshots: snapshots,
    orders: orders.map((o, i) => ({
      id: `order-${i}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: o.customerId,
      total_price_cents: o.cents,
      shopify_created_at: day(o.day),
    })),
  });
}

/**
 * Builds a single-campaign scenario: `treatmentCount` treatment customers
 * (outbound at day 0), `treatmentBuyers` of whom order `cents` on `buyDay`;
 * `holdoutCount` holdout customers, `holdoutBuyers` of whom order `cents`.
 */
function oneCampaign(opts: {
  campaignId: string;
  treatmentCount: number;
  treatmentBuyers: number;
  holdoutCount: number;
  holdoutBuyers: number;
  cents?: number;
  buyDay?: number;
}) {
  const cents = opts.cents ?? 5000;
  const buyDay = opts.buyDay ?? 5;
  const treatment = Array.from({ length: opts.treatmentCount }, (_, i) => ({
    customerId: `t${i}`,
    sentDay: 0,
  }));
  const holdout = Array.from({ length: opts.holdoutCount }, (_, i) => `h${i}`);
  const orders: Array<{ customerId: string; cents: number; day: number }> = [];
  for (let i = 0; i < opts.treatmentBuyers; i++) {
    orders.push({ customerId: `t${i}`, cents, day: buyDay });
  }
  for (let i = 0; i < opts.holdoutBuyers; i++) {
    orders.push({ customerId: `h${i}`, cents, day: buyDay });
  }
  return seedScenario([{ id: opts.campaignId, treatment, holdout }], orders);
}

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";

describe("Scenario 1 — high-lift", () => {
  it("yields a clear positive incremental with a CI that excludes zero", async () => {
    // Treatment 100 (40 buy $50); holdout 30 (6 buy $50).
    const { client } = oneCampaign({
      campaignId: CAMPAIGN,
      treatmentCount: 100,
      treatmentBuyers: 40,
      holdoutCount: 30,
      holdoutBuyers: 6,
    });
    const inc = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(inc.insufficientEvidence).toBe(false);
    // treatment per-customer 2000¢, holdout per-customer 1000¢ → +1000¢ × 100.
    expect(inc.incrementalRevenueCents).toBe(100_000);
    expect(inc.incrementalCiLowCents).not.toBeNull();
    expect(inc.incrementalCiLowCents!).toBeGreaterThan(0); // interval excludes 0

    const ltv = await computeLtvRestoration(client, CAMPAIGN);
    expect(ltv.ltvRestoredCents).toBe(100_000);
    expect(ltv.insufficientEvidence).toBe(false);
    // The LTV interval is genuinely computed (not null) on a sufficient cohort.
    expect(ltv.ltvCiLowCents).not.toBeNull();
    expect(ltv.ltvCiHighCents).not.toBeNull();
  });
});

describe("Scenario 2 — zero-lift", () => {
  it("yields ~zero incremental with a CI that brackets zero", async () => {
    // Both cohorts ~20% conversion at $50.
    const { client } = oneCampaign({
      campaignId: CAMPAIGN,
      treatmentCount: 100,
      treatmentBuyers: 20,
      holdoutCount: 30,
      holdoutBuyers: 6,
    });
    const inc = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(inc.insufficientEvidence).toBe(false);
    // 20/100 = 0.20 and 6/30 = 0.20 → identical per-customer revenue → 0.
    expect(inc.incrementalRevenueCents).toBe(0);
    expect(inc.incrementalCiLowCents!).toBeLessThan(0);
    expect(inc.incrementalCiHighCents!).toBeGreaterThan(0);

    const ltv = await computeLtvRestoration(client, CAMPAIGN);
    expect(ltv.ltvRestoredCents).toBe(0);
  });
});

describe("Scenario 3 — negative-lift", () => {
  it("surfaces a negative incremental and negative LTV cleanly, no special-casing", async () => {
    // Treatment 100 (10 buy); holdout 30 (12 buy) — holdout outperforms.
    const { client } = oneCampaign({
      campaignId: CAMPAIGN,
      treatmentCount: 100,
      treatmentBuyers: 10,
      holdoutCount: 30,
      holdoutBuyers: 12,
    });
    const inc = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(inc.insufficientEvidence).toBe(false);
    // treatment 500¢/customer, holdout 2000¢/customer → −1500¢ × 100.
    expect(inc.incrementalRevenueCents).toBe(-150_000);
    expect(inc.incrementalCiHighCents!).toBeLessThan(0); // whole interval below 0
    expect(inc.incrementalCiLowCents!).toBeLessThan(inc.incrementalCiHighCents!); // ordered

    const ltv = await computeLtvRestoration(client, CAMPAIGN);
    expect(ltv.ltvRestoredCents).toBeLessThan(0);
  });
});

describe("Scenario 4 — insufficient evidence", () => {
  it("flags insufficient_evidence with raw numbers and no CI when a cohort is below 30", async () => {
    // Treatment 25, holdout 10 — both below the 30 threshold.
    const { client } = oneCampaign({
      campaignId: CAMPAIGN,
      treatmentCount: 25,
      treatmentBuyers: 5,
      holdoutCount: 10,
      holdoutBuyers: 2,
    });
    const inc = await computeIncrementalRevenue(client, CAMPAIGN);
    expect(inc.insufficientEvidence).toBe(true);
    expect(inc.incrementalCiLowCents).toBeNull();
    expect(inc.incrementalCiHighCents).toBeNull();
    // Raw counts + revenue are still reported.
    expect(inc.treatmentCohortSize).toBe(25);
    expect(inc.holdoutCohortSize).toBe(10);
    expect(inc.treatmentRevenueCents).toBe(25_000); // 5 × 5000

    const ltv = await computeLtvRestoration(client, CAMPAIGN);
    expect(ltv.insufficientEvidence).toBe(true);
    expect(ltv.ltvCiLowCents).toBeNull();
  });
});

describe("Scenario 5 — multi-campaign overlap (single-attribution, decision 21)", () => {
  it("attributes a shared customer's order to the most-recent campaign only", async () => {
    const CAMPAIGN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const CAMPAIGN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    // Customer X is in A (outbound day 0) AND B (outbound day 3). X orders on
    // day 5 — 5 days after A's outbound, 2 days after B's. Both 14-day windows.
    const { client } = seedScenario(
      [
        { id: CAMPAIGN_A, treatment: [{ customerId: "X", sentDay: 0 }], holdout: [] },
        { id: CAMPAIGN_B, treatment: [{ customerId: "X", sentDay: 3 }], holdout: [] },
      ],
      [{ customerId: "X", cents: 5000, day: 5 }],
    );

    // A's cohort includes X (membership) but the order is NOT attributed to A.
    const cohortA = await getTreatmentCohort(client, CAMPAIGN_A);
    expect(cohortA.cohort).toContain("X");
    const ordersA = await getTreatmentOrders(client, cohortA);
    expect(ordersA.orders).toEqual([]);
    expect(ordersA.revenueCents).toBe(0);

    // B is the most-recent preceding outbound → the order attributes to B.
    const cohortB = await getTreatmentCohort(client, CAMPAIGN_B);
    const ordersB = await getTreatmentOrders(client, cohortB);
    expect(ordersB.orders).toHaveLength(1);
    expect(ordersB.revenueCents).toBe(5000);

    // The order is counted exactly once across the two campaigns — never both.
    expect(ordersA.orders.length + ordersB.orders.length).toBe(1);

    // And the incremental aggregation agrees: the $50 lands in B's revenue,
    // never A's — single-attribution holds through to computeIncrementalRevenue,
    // not just the order-level winner selection. (Both are sub-30 cohorts, so
    // insufficient_evidence is expected; the point is the revenue placement.)
    const incA = await computeIncrementalRevenue(client, CAMPAIGN_A);
    const incB = await computeIncrementalRevenue(client, CAMPAIGN_B);
    expect(incA.treatmentRevenueCents).toBe(0);
    expect(incB.treatmentRevenueCents).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Monte-Carlo coverage — Welch's 95% CI must bracket the true delta ≈ 95% of runs
// ─────────────────────────────────────────────────────────────────────────────

/** Standard normal variate via Box-Muller, drawing from a [0,1) rng. */
function normal(rng: () => number, mean: number, sd: number): number {
  let u1 = rng();
  while (u1 <= 0) u1 = rng();
  const u2 = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

describe("Welch CI — Monte-Carlo coverage", () => {
  it("brackets the true mean difference in ≈95% of runs (2000 trials)", () => {
    const TRIALS = 2000;
    const rng = mulberry32(0x5e8d08);
    const n1 = 50;
    const n2 = 40;
    const mu1 = 1000;
    const mu2 = 700;
    const sd1 = 300;
    const sd2 = 480; // deliberately unequal variances — Welch's whole point
    const trueDelta = mu1 - mu2; // 300

    let covered = 0;
    for (let t = 0; t < TRIALS; t++) {
      const a = Array.from({ length: n1 }, () => normal(rng, mu1, sd1));
      const b = Array.from({ length: n2 }, () => normal(rng, mu2, sd2));
      const w = welchConfidenceInterval(a, b);
      if (w.ciLow <= trueDelta && trueDelta <= w.ciHigh) covered += 1;
    }
    const rate = covered / TRIALS;
    // A correctly-calibrated 95% interval covers ~0.95; with 2000 trials the
    // 2σ band is ≈±0.01. Outside [0.93, 0.97] would be a calibration bug.
    expect(rate).toBeGreaterThanOrEqual(0.93);
    expect(rate).toBeLessThanOrEqual(0.97);
  });

  it("a 99% interval is wider and covers more than the 95% interval", () => {
    const rng = mulberry32(0x13ab99);
    const a = Array.from({ length: 60 }, () => normal(rng, 500, 200));
    const b = Array.from({ length: 60 }, () => normal(rng, 500, 200));
    const ci95 = welchConfidenceInterval(a, b, 0.05);
    const ci99 = welchConfidenceInterval(a, b, 0.01);
    expect(ci99.ciHigh - ci99.ciLow).toBeGreaterThan(ci95.ciHigh - ci95.ciLow);
  });
});
