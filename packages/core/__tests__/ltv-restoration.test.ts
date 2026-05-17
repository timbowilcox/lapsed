import { describe, expect, it } from "vitest";
import { computeLtvRestoration } from "../src/ltv-restoration";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";

const day = (n: number): string =>
  new Date(Date.UTC(2026, 3, 1) + n * 86_400_000).toISOString();

interface OrderSpec {
  /** cohort index (0-based) */
  customer: number;
  cents: number;
  /** day offset for shopify_created_at; outbounds are all at day 0 */
  placedDay: number;
}

/**
 * Seeds a campaign: `treatmentCount` treatment customers (each with a day-0
 * campaign outbound) and `holdoutCount` holdout snapshot customers, plus
 * treatment + holdout orders attached by cohort index.
 */
function seedCampaign(opts: {
  treatmentCount: number;
  holdoutCount: number;
  treatmentOrders?: OrderSpec[];
  holdoutOrders?: OrderSpec[];
}) {
  const conversations: FakeRow[] = [];
  const messages: FakeRow[] = [];
  const snapshots: FakeRow[] = [];
  const orders: FakeRow[] = [];

  for (let i = 0; i < opts.treatmentCount; i++) {
    const cid = `t${i}`;
    conversations.push({ id: `conv-${cid}`, merchant_id: MERCHANT, customer_id: cid });
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
  let seq = 0;
  for (const o of opts.treatmentOrders ?? []) {
    orders.push({
      id: `o${seq++}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: `t${o.customer}`,
      total_price_cents: o.cents,
      shopify_created_at: day(o.placedDay),
    });
  }
  for (const o of opts.holdoutOrders ?? []) {
    orders.push({
      id: `o${seq++}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: `h${o.customer}`,
      total_price_cents: o.cents,
      shopify_created_at: day(o.placedDay),
    });
  }

  return makeFakeSupabase({
    campaign_proposals: [
      { id: CAMPAIGN, merchant_id: MERCHANT, attribution_window_days: 14 },
    ],
    conversations,
    messages,
    campaign_group_snapshots: snapshots,
    orders,
  });
}

/** The first `count` customers each place one `cents` order at `placedDay`. */
function buyers(count: number, cents: number, placedDay = 5): OrderSpec[] {
  return Array.from({ length: count }, (_, i) => ({ customer: i, cents, placedDay }));
}

describe("computeLtvRestoration", () => {
  it("computes a positive restored-LTV delta with a CI when treatment outperforms holdout", async () => {
    // 40 treatment, 20 buy $50 in the post window; 40 holdout, 4 buy $50.
    const { client } = seedCampaign({
      treatmentCount: 40,
      holdoutCount: 40,
      treatmentOrders: buyers(20, 5000),
      holdoutOrders: buyers(4, 5000),
    });
    const r = await computeLtvRestoration(client, CAMPAIGN);

    expect(r.ltvWindowDays).toBe(30); // merchant default
    expect(r.treatmentPostMeanCents).toBeCloseTo(2500, 6); // 100000 / 40
    expect(r.holdoutPostMeanCents).toBeCloseTo(500, 6); // 20000 / 40
    expect(r.ltvDeltaPerCustomerCents).toBeCloseTo(2000, 6);
    expect(r.ltvRestoredCents).toBe(80_000); // 2000 × 40
    expect(r.insufficientEvidence).toBe(false);
    expect(r.ltvCiLowCents).not.toBeNull();
    expect(r.ltvCiLowCents!).toBeGreaterThan(0); // a real restoration
  });

  it("computes a ~zero delta with a zero-bracketing CI when cohorts are indistinguishable", async () => {
    const { client } = seedCampaign({
      treatmentCount: 40,
      holdoutCount: 40,
      treatmentOrders: buyers(8, 5000),
      holdoutOrders: buyers(8, 5000),
    });
    const r = await computeLtvRestoration(client, CAMPAIGN);
    expect(r.ltvRestoredCents).toBe(0);
    expect(r.ltvCiLowCents!).toBeLessThan(0);
    expect(r.ltvCiHighCents!).toBeGreaterThan(0);
  });

  it("materialises one ltv_snapshots row per treatment customer with pre/post/delta", async () => {
    const { client, tables } = seedCampaign({
      treatmentCount: 40,
      holdoutCount: 40,
      // t0 buys post-window (day 5) and pre-window (day -10).
      treatmentOrders: [
        { customer: 0, cents: 7000, placedDay: 5 },
        { customer: 0, cents: 3000, placedDay: -10 },
      ],
      holdoutOrders: buyers(4, 5000),
    });
    const r = await computeLtvRestoration(client, CAMPAIGN);
    expect(r.snapshotsWritten).toBe(40);
    expect(tables.ltv_snapshots).toHaveLength(40);

    const t0 = tables.ltv_snapshots!.find((s) => s.customer_id === "t0")!;
    expect(t0.post_30d_revenue_cents).toBe(7000);
    expect(t0.pre_30d_revenue_cents).toBe(3000);
    expect(t0.campaign_id).toBe(CAMPAIGN);
    // delta = post − holdout mean (20000/40 = 500) → 6500.
    expect(t0.delta_cents).toBe(6500);

    // A non-buyer's post revenue is 0.
    const t9 = tables.ltv_snapshots!.find((s) => s.customer_id === "t9")!;
    expect(t9.post_30d_revenue_cents).toBe(0);
  });

  it("re-running is idempotent — snapshots are upserted, not duplicated", async () => {
    const { client, tables } = seedCampaign({
      treatmentCount: 35,
      holdoutCount: 31,
      treatmentOrders: buyers(10, 5000),
      holdoutOrders: buyers(3, 5000),
    });
    await computeLtvRestoration(client, CAMPAIGN);
    await computeLtvRestoration(client, CAMPAIGN);
    expect(tables.ltv_snapshots).toHaveLength(35); // not 70
  });

  it("flags insufficient_evidence and emits no CI when a cohort is below 30", async () => {
    const { client } = seedCampaign({
      treatmentCount: 29,
      holdoutCount: 40,
      treatmentOrders: buyers(10, 5000),
      holdoutOrders: buyers(4, 5000),
    });
    const r = await computeLtvRestoration(client, CAMPAIGN);
    expect(r.insufficientEvidence).toBe(true);
    expect(r.ltvCiLowCents).toBeNull();
    expect(r.ltvCiHighCents).toBeNull();
  });

  it("emits only integer-cent values for the persisted fields", async () => {
    const { client, tables } = seedCampaign({
      treatmentCount: 33,
      holdoutCount: 31,
      treatmentOrders: buyers(7, 3333),
      holdoutOrders: buyers(3, 3333),
    });
    const r = await computeLtvRestoration(client, CAMPAIGN);
    expect(Number.isInteger(r.ltvRestoredCents)).toBe(true);
    expect(Number.isInteger(r.ltvCiLowCents!)).toBe(true);
    expect(Number.isInteger(r.ltvCiHighCents!)).toBe(true);
    for (const s of tables.ltv_snapshots!) {
      expect(Number.isInteger(s.delta_cents)).toBe(true);
    }
  });

  it("honours a per-merchant LTV evaluation window override", async () => {
    const { client } = seedCampaign({
      treatmentCount: 32,
      holdoutCount: 31,
      // Buys on day 45 — inside a 60-day window, outside the default 30.
      treatmentOrders: buyers(10, 5000, 45),
      holdoutOrders: [],
    });
    // Add a merchant config row with a 60-day LTV window.
    const withConfig = makeFakeSupabase({
      campaign_proposals: [{ id: CAMPAIGN, merchant_id: MERCHANT, attribution_window_days: 14 }],
      merchant_attribution_config: [
        { merchant_id: MERCHANT, attribution_window_days: 14, ltv_evaluation_window_days: 60 },
      ],
      conversations: Array.from({ length: 32 }, (_, i) => ({
        id: `conv-t${i}`,
        merchant_id: MERCHANT,
        customer_id: `t${i}`,
      })),
      messages: Array.from({ length: 32 }, (_, i) => ({
        id: `mt${i}`,
        merchant_id: MERCHANT,
        conversation_id: `conv-t${i}`,
        direction: "outbound",
        campaign_id: CAMPAIGN,
        arm_id: "arm-0",
        sent_at: day(0),
      })),
      campaign_group_snapshots: Array.from({ length: 31 }, (_, i) => ({
        proposal_id: CAMPAIGN,
        merchant_id: MERCHANT,
        customer_id: `h${i}`,
        included_in_holdout: true,
      })),
      orders: Array.from({ length: 10 }, (_, i) => ({
        id: `o${i}`,
        merchant_id: MERCHANT,
        shopify_customer_gid: `t${i}`,
        total_price_cents: 5000,
        shopify_created_at: day(45),
      })),
    });
    void client;
    const r = await computeLtvRestoration(withConfig.client, CAMPAIGN);
    expect(r.ltvWindowDays).toBe(60);
    // Day-45 orders fall inside the 60-day post window.
    expect(r.treatmentPostMeanCents).toBeGreaterThan(0);
  });

  it("returns zeros for a campaign that has not launched", async () => {
    const { client } = seedCampaign({ treatmentCount: 0, holdoutCount: 40 });
    const r = await computeLtvRestoration(client, CAMPAIGN);
    expect(r.insufficientEvidence).toBe(true);
    expect(r.ltvRestoredCents).toBe(0);
    expect(r.snapshotsWritten).toBe(0);
  });

  it("partitions orders at the window boundaries correctly (pre vs post, no overlap)", async () => {
    // Sends are all at day 0, default 30-day window.
    //   day 0   (exactly send)        → pre
    //   day 30  (exactly send+window) → post
    //   day -30 (exactly send-window) → pre
    //   day 31  (one day past post)   → neither
    const { client, tables } = seedCampaign({
      treatmentCount: 31,
      holdoutCount: 31,
      treatmentOrders: [
        { customer: 0, cents: 1000, placedDay: 0 },
        { customer: 1, cents: 2000, placedDay: 30 },
        { customer: 2, cents: 3000, placedDay: -30 },
        { customer: 3, cents: 4000, placedDay: 31 },
      ],
      holdoutOrders: buyers(3, 5000),
    });
    await computeLtvRestoration(client, CAMPAIGN);
    const snap = (id: string) => tables.ltv_snapshots!.find((s) => s.customer_id === id)!;
    // day 0 → pre, not post.
    expect(snap("t0").pre_30d_revenue_cents).toBe(1000);
    expect(snap("t0").post_30d_revenue_cents).toBe(0);
    // day 30 → post, not pre.
    expect(snap("t1").post_30d_revenue_cents).toBe(2000);
    expect(snap("t1").pre_30d_revenue_cents).toBe(0);
    // day -30 → pre.
    expect(snap("t2").pre_30d_revenue_cents).toBe(3000);
    // day 31 → neither.
    expect(snap("t3").pre_30d_revenue_cents).toBe(0);
    expect(snap("t3").post_30d_revenue_cents).toBe(0);
  });

  it("anchors the window on a customer's EARLIEST outbound when they have several", async () => {
    // t0 has two outbounds: day 0 and day 5. The earliest (day 0) is the
    // anchor, so a day-3 order is post-window; anchored at day 5 it would be pre.
    const conversations = Array.from({ length: 31 }, (_, i) => ({
      id: `conv-t${i}`,
      merchant_id: MERCHANT,
      customer_id: `t${i}`,
    }));
    const messages = Array.from({ length: 31 }, (_, i) => ({
      id: `mt${i}`,
      merchant_id: MERCHANT,
      conversation_id: `conv-t${i}`,
      direction: "outbound",
      campaign_id: CAMPAIGN,
      arm_id: "arm-0",
      sent_at: day(0),
    }));
    messages.push({
      id: "mt0-second",
      merchant_id: MERCHANT,
      conversation_id: "conv-t0",
      direction: "outbound",
      campaign_id: CAMPAIGN,
      arm_id: "arm-0",
      sent_at: day(5),
    });
    const { client, tables } = makeFakeSupabase({
      campaign_proposals: [{ id: CAMPAIGN, merchant_id: MERCHANT, attribution_window_days: 14 }],
      conversations,
      messages,
      campaign_group_snapshots: Array.from({ length: 31 }, (_, i) => ({
        proposal_id: CAMPAIGN,
        merchant_id: MERCHANT,
        customer_id: `h${i}`,
        included_in_holdout: true,
      })),
      orders: [
        {
          id: "o0",
          merchant_id: MERCHANT,
          shopify_customer_gid: "t0",
          total_price_cents: 6000,
          shopify_created_at: day(3),
        },
      ],
    });
    await computeLtvRestoration(client, CAMPAIGN);
    const t0 = tables.ltv_snapshots!.find((s) => s.customer_id === "t0")!;
    expect(t0.post_30d_revenue_cents).toBe(6000); // day 3 is post relative to day-0 anchor
    expect(t0.pre_30d_revenue_cents).toBe(0);
  });

  it("propagates a query error from the treatment orders fetch", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [{ id: CAMPAIGN, merchant_id: MERCHANT, attribution_window_days: 14 }],
      conversations: [{ id: "conv-t0", merchant_id: MERCHANT, customer_id: "t0" }],
      messages: [
        {
          id: "mt0",
          merchant_id: MERCHANT,
          conversation_id: "conv-t0",
          direction: "outbound",
          campaign_id: CAMPAIGN,
          arm_id: "arm-0",
          sent_at: day(0),
        },
      ],
      campaign_group_snapshots: [],
    }, { failOn: [{ table: "orders", op: "select" }] });
    await expect(computeLtvRestoration(client, CAMPAIGN)).rejects.toThrow(/fake error/);
  });

  it("propagates an upsert error from the ltv_snapshots write", async () => {
    const { client } = seedCampaign({
      treatmentCount: 31,
      holdoutCount: 31,
      treatmentOrders: buyers(5, 5000),
    });
    // Re-wrap with a failOn for the ltv_snapshots upsert.
    const failing = makeFakeSupabase(
      {
        campaign_proposals: [{ id: CAMPAIGN, merchant_id: MERCHANT, attribution_window_days: 14 }],
        conversations: Array.from({ length: 31 }, (_, i) => ({
          id: `conv-t${i}`,
          merchant_id: MERCHANT,
          customer_id: `t${i}`,
        })),
        messages: Array.from({ length: 31 }, (_, i) => ({
          id: `mt${i}`,
          merchant_id: MERCHANT,
          conversation_id: `conv-t${i}`,
          direction: "outbound",
          campaign_id: CAMPAIGN,
          arm_id: "arm-0",
          sent_at: day(0),
        })),
        campaign_group_snapshots: Array.from({ length: 31 }, (_, i) => ({
          proposal_id: CAMPAIGN,
          merchant_id: MERCHANT,
          customer_id: `h${i}`,
          included_in_holdout: true,
        })),
        orders: [],
      },
      { failOn: [{ table: "ltv_snapshots", op: "upsert" }] },
    );
    void client;
    await expect(computeLtvRestoration(failing.client, CAMPAIGN)).rejects.toThrow(/fake error/);
  });

  it("throws on a malformed order timestamp", async () => {
    const { client } = seedCampaign({
      treatmentCount: 31,
      holdoutCount: 31,
      treatmentOrders: [{ customer: 0, cents: 5000, placedDay: 0 }],
    });
    // Corrupt the seeded order's timestamp directly.
    const { client: bad } = makeFakeSupabase({
      campaign_proposals: [{ id: CAMPAIGN, merchant_id: MERCHANT, attribution_window_days: 14 }],
      conversations: [{ id: "conv-t0", merchant_id: MERCHANT, customer_id: "t0" }],
      messages: [
        {
          id: "mt0",
          merchant_id: MERCHANT,
          conversation_id: "conv-t0",
          direction: "outbound",
          campaign_id: CAMPAIGN,
          arm_id: "arm-0",
          sent_at: day(0),
        },
      ],
      campaign_group_snapshots: [],
      orders: [
        {
          id: "o0",
          merchant_id: MERCHANT,
          shopify_customer_gid: "t0",
          total_price_cents: 5000,
          shopify_created_at: "not-a-date",
        },
      ],
    });
    void client;
    await expect(computeLtvRestoration(bad, CAMPAIGN)).rejects.toThrow(/valid timestamp/);
  });

  it("throws on a non-integer order amount", async () => {
    const { client } = seedCampaign({
      treatmentCount: 31,
      holdoutCount: 31,
      treatmentOrders: [{ customer: 0, cents: 99.9, placedDay: 5 }],
    });
    await expect(computeLtvRestoration(client, CAMPAIGN)).rejects.toThrow(/not an integer/);
  });
});
