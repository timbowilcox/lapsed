import { describe, expect, it } from "vitest";
import { runAttributionBatch } from "../src/attribution-batch";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const ARMS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
];

const day = (n: number): string =>
  new Date(Date.UTC(2026, 3, 1) + n * 86_400_000).toISOString();
const at = (n: number) => () => new Date(Date.UTC(2026, 3, 1) + n * 86_400_000);

interface OrderSpec {
  customer: number;
  cents: number;
  placedDay: number;
}

/**
 * Seeds one approved campaign launched at day 0 (14-day window) with
 * `treatmentCount` treatment customers + `holdoutCount` holdout customers,
 * plus a bandit_state row per arm and the given orders.
 */
function seedBatch(opts: {
  treatmentCount: number;
  holdoutCount: number;
  treatmentOrders?: OrderSpec[];
  holdoutOrders?: OrderSpec[];
}) {
  const conversations: FakeRow[] = [];
  const messages: FakeRow[] = [];
  const snapshots: FakeRow[] = [];
  const orders: FakeRow[] = [];
  const banditState: FakeRow[] = ARMS.map((armId) => ({
    arm_id: armId,
    merchant_id: MERCHANT,
    proposal_id: CAMPAIGN,
    sentiment_alpha: 1,
    sentiment_beta: 1,
    observation_count: 0,
    order_alpha: 1,
    order_beta: 1,
    order_observation_count: 0,
    order_last_updated_at: null,
    last_updated_at: day(0),
  }));

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
      // Message ids are real UUIDs — recordOrderArrival validates them.
      id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
      merchant_id: MERCHANT,
      conversation_id: `conv-${cid}`,
      direction: "outbound",
      campaign_id: CAMPAIGN,
      arm_id: ARMS[i % 3],
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
      id: `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: `t${o.customer}`,
      total_price_cents: o.cents,
      shopify_created_at: day(o.placedDay),
    });
  }
  for (const o of opts.holdoutOrders ?? []) {
    orders.push({
      id: `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: `h${o.customer}`,
      total_price_cents: o.cents,
      shopify_created_at: day(o.placedDay),
    });
  }

  return makeFakeSupabase({
    campaign_proposals: [
      { id: CAMPAIGN, merchant_id: MERCHANT, status: "approved", attribution_window_days: 14 },
    ],
    conversations,
    messages,
    campaign_group_snapshots: snapshots,
    bandit_state: banditState,
    orders,
  });
}

const buyers = (count: number, cents: number, placedDay = 5): OrderSpec[] =>
  Array.from({ length: count }, (_, i) => ({ customer: i, cents, placedDay }));

describe("runAttributionBatch", () => {
  it("materialises an attribution_results row for a closed-window campaign", async () => {
    const { client, tables } = seedBatch({
      treatmentCount: 35,
      holdoutCount: 31,
      treatmentOrders: buyers(15, 5000),
      holdoutOrders: buyers(3, 5000),
    });
    // now = day 20 → the day-0 launch + 14-day window has closed.
    const result = await runAttributionBatch(client, { merchantId: MERCHANT, now: at(20) });

    expect(result.campaignsComputed).toBe(1);
    expect(result.resultsWritten).toBe(1);
    expect(tables.attribution_results).toHaveLength(1);
    const row = tables.attribution_results![0]!;
    expect(row.campaign_id).toBe(CAMPAIGN);
    expect(row.window_close_date).toBe(day(14).slice(0, 10));
    expect(row.treatment_cohort_size).toBe(35);
    expect(row.holdout_cohort_size).toBe(31);
    expect(row.insufficient_evidence).toBe(false);
    // Bandit order posteriors fired: 15 arrivals + 20 no-order = 35 decisions.
    expect(tables.attribution_decisions).toHaveLength(35);
  });

  it("is idempotent — a second run writes no new attribution_results rows", async () => {
    const { client, tables } = seedBatch({
      treatmentCount: 35,
      holdoutCount: 31,
      treatmentOrders: buyers(15, 5000),
      holdoutOrders: buyers(3, 5000),
    });
    const first = await runAttributionBatch(client, { merchantId: MERCHANT, now: at(20) });
    const second = await runAttributionBatch(client, { merchantId: MERCHANT, now: at(21) });

    expect(first.campaignsComputed).toBe(1);
    expect(second.campaignsComputed).toBe(0);
    expect(second.campaignsSkipped).toBe(1);
    expect(tables.attribution_results).toHaveLength(1);
    // Posteriors were not re-fired — still exactly 35 decisions.
    expect(tables.attribution_decisions).toHaveLength(35);
  });

  it("skips a campaign whose attribution window has not yet closed", async () => {
    const { client, tables } = seedBatch({
      treatmentCount: 35,
      holdoutCount: 31,
      treatmentOrders: buyers(15, 5000),
    });
    // now = day 10 → launch day 0 + 14-day window still open.
    const result = await runAttributionBatch(client, { merchantId: MERCHANT, now: at(10) });
    expect(result.campaignsComputed).toBe(0);
    expect(result.campaignsSkipped).toBe(1);
    expect(tables.attribution_results ?? []).toHaveLength(0);
  });

  it("writes insufficient_evidence and does NOT fire bandit posteriors below threshold", async () => {
    const { client, tables } = seedBatch({
      treatmentCount: 10, // below the 30-customer threshold
      holdoutCount: 8,
      treatmentOrders: buyers(4, 5000),
      holdoutOrders: buyers(1, 5000),
    });
    const result = await runAttributionBatch(client, { merchantId: MERCHANT, now: at(20) });

    expect(result.campaignsComputed).toBe(1);
    expect(tables.attribution_results).toHaveLength(1);
    expect(tables.attribution_results![0]!.insufficient_evidence).toBe(true);
    expect(tables.attribution_results![0]!.incremental_ci_low_cents).toBeNull();
    // No bandit posterior pollution from a low-confidence cohort.
    expect(tables.attribution_decisions ?? []).toHaveLength(0);
    for (const arm of tables.bandit_state!) {
      expect(arm.order_alpha).toBe(1);
      expect(arm.order_beta).toBe(1);
      expect(arm.order_observation_count).toBe(0);
    }
  });

  it("skips a campaign that has no outbounds (not launched)", async () => {
    const { client, tables } = seedBatch({ treatmentCount: 0, holdoutCount: 31 });
    const result = await runAttributionBatch(client, { merchantId: MERCHANT, now: at(20) });
    expect(result.campaignsComputed).toBe(0);
    expect(result.campaignsSkipped).toBe(1);
    expect(tables.attribution_results ?? []).toHaveLength(0);
  });

  it("isolates a per-campaign error — increments errors, batch still resolves", async () => {
    const { client } = seedBatch({
      treatmentCount: 35,
      holdoutCount: 31,
      treatmentOrders: buyers(15, 5000),
    });
    // Force the attribution_results pre-check to fail → processCampaign throws.
    const failing = makeFakeSupabase(
      {
        campaign_proposals: [
          { id: CAMPAIGN, merchant_id: MERCHANT, status: "approved", attribution_window_days: 14 },
        ],
        conversations: Array.from({ length: 35 }, (_, i) => ({
          id: `conv-t${i}`,
          merchant_id: MERCHANT,
          customer_id: `t${i}`,
        })),
        messages: Array.from({ length: 35 }, (_, i) => ({
          id: `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
          merchant_id: MERCHANT,
          conversation_id: `conv-t${i}`,
          direction: "outbound",
          campaign_id: CAMPAIGN,
          arm_id: ARMS[i % 3],
          sent_at: day(0),
        })),
        campaign_group_snapshots: Array.from({ length: 35 }, (_, i) => ({
          proposal_id: CAMPAIGN,
          merchant_id: MERCHANT,
          customer_id: `t${i}`,
          included_in_holdout: false,
        })),
      },
      { failOn: [{ table: "attribution_results", op: "select" }] },
    );
    void client;
    // The batch must resolve (not reject) and record the error.
    const result = await runAttributionBatch(failing.client, {
      merchantId: MERCHANT,
      now: at(20),
    });
    expect(result.errors).toBe(1);
    expect(result.campaignsComputed).toBe(0);
  });

  it("processes every merchant when merchantId is omitted", async () => {
    const MERCHANT_2 = "660e8400-e29b-41d4-a716-446655440000";
    const CAMPAIGN_2 = "22222222-2222-4222-8222-222222222222";
    // Both campaigns are deliberately sub-30 (insufficient evidence) so the run
    // exercises the multi-merchant loop without bandit-arm coupling — the
    // posterior-firing path is covered by the sufficient-cohort tests above.
    const mkCampaign = (mId: string, cId: string, custPrefix: string) => ({
      proposal: { id: cId, merchant_id: mId, status: "approved", attribution_window_days: 14 },
      conversations: Array.from({ length: 12 }, (_, i) => ({
        id: `conv-${custPrefix}${i}`,
        merchant_id: mId,
        customer_id: `${custPrefix}${i}`,
      })),
      messages: Array.from({ length: 12 }, (_, i) => ({
        id: `${cId.slice(0, 24)}${String(i).padStart(12, "0")}`,
        merchant_id: mId,
        conversation_id: `conv-${custPrefix}${i}`,
        direction: "outbound",
        campaign_id: cId,
        arm_id: ARMS[0],
        sent_at: day(0),
      })),
      snapshots: [
        ...Array.from({ length: 12 }, (_, i) => ({
          proposal_id: cId,
          merchant_id: mId,
          customer_id: `${custPrefix}${i}`,
          included_in_holdout: false,
        })),
        ...Array.from({ length: 12 }, (_, i) => ({
          proposal_id: cId,
          merchant_id: mId,
          customer_id: `${custPrefix}h${i}`,
          included_in_holdout: true,
        })),
      ],
    });
    const c1 = mkCampaign(MERCHANT, CAMPAIGN, "m1c");
    const c2 = mkCampaign(MERCHANT_2, CAMPAIGN_2, "m2c");
    const { client, tables } = makeFakeSupabase({
      merchants: [{ id: MERCHANT }, { id: MERCHANT_2 }],
      campaign_proposals: [c1.proposal, c2.proposal],
      conversations: [...c1.conversations, ...c2.conversations],
      messages: [...c1.messages, ...c2.messages],
      campaign_group_snapshots: [...c1.snapshots, ...c2.snapshots],
      orders: [],
    });
    // merchantId omitted → both merchants' campaigns are processed.
    const result = await runAttributionBatch(client, { now: at(20) });
    expect(result.merchantsProcessed).toBe(2);
    expect(result.campaignsComputed).toBe(2);
    expect(tables.attribution_results).toHaveLength(2);
    expect(tables.attribution_results!.every((r) => r.insufficient_evidence === true)).toBe(true);
  });

  it("fires order_alpha for attributed customers and order_beta for no-order customers", async () => {
    const { client, tables } = seedBatch({
      treatmentCount: 30,
      holdoutCount: 30,
      treatmentOrders: buyers(12, 5000),
      holdoutOrders: buyers(2, 5000),
    });
    await runAttributionBatch(client, { merchantId: MERCHANT, now: at(20) });
    // Across the 3 arms: 12 arrivals (order_alpha+) and 18 no-orders (order_beta+).
    const totalAlpha = tables.bandit_state!.reduce((s, a) => s + (a.order_alpha as number), 0);
    const totalBeta = tables.bandit_state!.reduce((s, a) => s + (a.order_beta as number), 0);
    // Each arm starts at order_alpha=1, order_beta=1 (3 arms → base 3 + 3).
    expect(totalAlpha).toBe(3 + 12);
    expect(totalBeta).toBe(3 + 18);
  });
});
