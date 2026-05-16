import { describe, expect, it } from "vitest";
import { getTreatmentCohort, getTreatmentOrders } from "../src/attribution-treatment";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CAMPAIGN_A = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_B = "22222222-2222-4222-8222-222222222222";

// A fixed day-grid so window arithmetic is unambiguous.
const day = (n: number): string =>
  new Date(Date.UTC(2026, 3, 1) + n * 86_400_000).toISOString();

function proposal(id: string, windowDays = 14): FakeRow {
  return { id, merchant_id: MERCHANT, attribution_window_days: windowDays };
}

function conversation(customerId: string): FakeRow {
  return { id: `conv-${customerId}`, merchant_id: MERCHANT, customer_id: customerId };
}

function outbound(
  id: string,
  customerId: string,
  campaignId: string,
  sentAt: string,
): FakeRow {
  return {
    id,
    merchant_id: MERCHANT,
    conversation_id: `conv-${customerId}`,
    direction: "outbound",
    campaign_id: campaignId,
    arm_id: `arm-${campaignId}`,
    sent_at: sentAt,
  };
}

function order(id: string, customerId: string, cents: number, placedAt: string): FakeRow {
  return {
    id,
    merchant_id: MERCHANT,
    shopify_customer_gid: customerId,
    total_price_cents: cents,
    shopify_created_at: placedAt,
  };
}

describe("getTreatmentCohort", () => {
  it("returns the distinct customers who received an outbound from the campaign", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [conversation("cust-1"), conversation("cust-2")],
      messages: [
        outbound("m1", "cust-1", CAMPAIGN_A, day(0)),
        outbound("m2", "cust-2", CAMPAIGN_A, day(0)),
        // A second outbound to cust-1 — cohort is still the DISTINCT set.
        outbound("m3", "cust-1", CAMPAIGN_A, day(1)),
      ],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    expect(cohort.cohort).toEqual(["cust-1", "cust-2"]);
    expect(cohort.outbounds).toHaveLength(3);
    expect(cohort.windowDays).toBe(14);
    expect(cohort.merchantId).toBe(MERCHANT);
  });

  it("returns an empty cohort when the campaign sent no outbounds", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [],
      messages: [],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    expect(cohort.cohort).toEqual([]);
    expect(cohort.outbounds).toEqual([]);
  });

  it("throws when the campaign proposal does not exist", async () => {
    const { client } = makeFakeSupabase({ campaign_proposals: [] });
    await expect(getTreatmentCohort(client, CAMPAIGN_A)).rejects.toThrow(/not found/);
  });
});

describe("getTreatmentOrders — single campaign", () => {
  it("attributes an in-window order and excludes an out-of-window order", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [conversation("cust-1"), conversation("cust-2")],
      messages: [
        outbound("m1", "cust-1", CAMPAIGN_A, day(0)),
        outbound("m2", "cust-2", CAMPAIGN_A, day(0)),
      ],
      orders: [
        order("o1", "cust-1", 5000, day(5)), // within 14d → attributed
        order("o2", "cust-2", 9900, day(20)), // outside 14d → excluded
      ],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    const result = await getTreatmentOrders(client, cohort);

    expect(result.orders.map((o) => o.orderId)).toEqual(["o1"]);
    expect(result.revenueCents).toBe(5000);
    expect(result.customersWithOrders).toBe(1);
    // Per-customer distribution has one entry per cohort customer (Welch input).
    expect(result.perCustomerRevenueCents.sort((a, b) => a - b)).toEqual([0, 5000]);
  });

  it("excludes an order placed before the outbound", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [conversation("cust-1")],
      messages: [outbound("m1", "cust-1", CAMPAIGN_A, day(10))],
      orders: [order("o1", "cust-1", 5000, day(2))], // before the outbound
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    const result = await getTreatmentOrders(client, cohort);
    expect(result.orders).toEqual([]);
    expect(result.revenueCents).toBe(0);
  });

  it("returns zeros for an empty cohort", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [],
      messages: [],
      orders: [],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    const result = await getTreatmentOrders(client, cohort);
    expect(result).toEqual({
      orders: [],
      revenueCents: 0,
      customersWithOrders: 0,
      perCustomerRevenueCents: [],
    });
  });
});

describe("getTreatmentOrders — multi-campaign single-attribution (decision 21)", () => {
  it("attributes a shared customer's order to the most-recent-preceding campaign only", async () => {
    // cust-X is in campaign A (outbound day 0) AND campaign B (outbound day 3).
    // X places one order on day 5. Both windows are 14d, so both outbounds
    // qualify — the order must attribute to B (most recent), never to both.
    const seed = {
      campaign_proposals: [proposal(CAMPAIGN_A, 14), proposal(CAMPAIGN_B, 14)],
      conversations: [conversation("cust-X")],
      messages: [
        outbound("mA", "cust-X", CAMPAIGN_A, day(0)),
        outbound("mB", "cust-X", CAMPAIGN_B, day(3)),
      ],
      orders: [order("o1", "cust-X", 8000, day(5))],
    };

    const { client: clientA } = makeFakeSupabase(seed);
    const resultA = await getTreatmentOrders(clientA, await getTreatmentCohort(clientA, CAMPAIGN_A));
    // Campaign A's cohort still includes cust-X (membership), but the order is
    // NOT attributed to A.
    expect(resultA.orders).toEqual([]);
    expect(resultA.revenueCents).toBe(0);

    const { client: clientB } = makeFakeSupabase(seed);
    const resultB = await getTreatmentOrders(clientB, await getTreatmentCohort(clientB, CAMPAIGN_B));
    expect(resultB.orders.map((o) => o.orderId)).toEqual(["o1"]);
    expect(resultB.orders[0]!.attributedMessageId).toBe("mB");
    expect(resultB.revenueCents).toBe(8000);
  });

  it("breaks an exact-same-sent_at tie deterministically by message id", async () => {
    // A and B both send at day 0 to cust-X; order on day 5. The winner must be
    // stable (lexically-smallest message id) regardless of seed/row order.
    const seed = {
      campaign_proposals: [proposal(CAMPAIGN_A, 14), proposal(CAMPAIGN_B, 14)],
      conversations: [conversation("cust-X")],
      messages: [
        outbound("mA", "cust-X", CAMPAIGN_A, day(0)),
        outbound("mB", "cust-X", CAMPAIGN_B, day(0)),
      ],
      orders: [order("o1", "cust-X", 6000, day(5))],
    };
    const { client: cA } = makeFakeSupabase(seed);
    const rA = await getTreatmentOrders(cA, await getTreatmentCohort(cA, CAMPAIGN_A));
    const { client: cB } = makeFakeSupabase(seed);
    const rB = await getTreatmentOrders(cB, await getTreatmentCohort(cB, CAMPAIGN_B));
    // Exactly one campaign wins — never both.
    expect(rA.orders.length + rB.orders.length).toBe(1);
    expect(rA.orders.map((o) => o.orderId)).toEqual(["o1"]); // "mA" < "mB"
    expect(rB.orders).toEqual([]);
  });

  it("attributes to A when B's outbound is outside its own window for that order", async () => {
    // B sent on day 0 with a SHORT 2-day window; A sent on day 1 with 14d.
    // Order on day 5: B's outbound is out of B's window, A's is in window →
    // A wins even though B's outbound was earlier and A's is more recent.
    const seed = {
      campaign_proposals: [proposal(CAMPAIGN_A, 14), proposal(CAMPAIGN_B, 2)],
      conversations: [conversation("cust-X")],
      messages: [
        outbound("mB", "cust-X", CAMPAIGN_B, day(0)),
        outbound("mA", "cust-X", CAMPAIGN_A, day(1)),
      ],
      orders: [order("o1", "cust-X", 4200, day(5))],
    };
    const { client: clientB } = makeFakeSupabase(seed);
    const resultB = await getTreatmentOrders(clientB, await getTreatmentCohort(clientB, CAMPAIGN_B));
    expect(resultB.orders).toEqual([]);

    const { client: clientA } = makeFakeSupabase(seed);
    const resultA = await getTreatmentOrders(clientA, await getTreatmentCohort(clientA, CAMPAIGN_A));
    expect(resultA.orders.map((o) => o.orderId)).toEqual(["o1"]);
    expect(resultA.revenueCents).toBe(4200);
  });
});

describe("getTreatmentOrders — boundary + robustness cases", () => {
  it("includes an order placed exactly at the window edge and at the send instant", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [conversation("c-edge"), conversation("c-instant")],
      messages: [
        outbound("m-edge", "c-edge", CAMPAIGN_A, day(0)),
        outbound("m-instant", "c-instant", CAMPAIGN_A, day(3)),
      ],
      orders: [
        order("o-edge", "c-edge", 1000, day(14)), // exactly window edge — included
        order("o-instant", "c-instant", 2000, day(3)), // exactly send instant — included
      ],
    });
    const result = await getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A));
    expect(result.orders.map((o) => o.orderId).sort()).toEqual(["o-edge", "o-instant"]);
    expect(result.revenueCents).toBe(3000);
  });

  it("excludes an order one millisecond past the window edge", async () => {
    const justPast = new Date(Date.UTC(2026, 3, 1) + 14 * 86_400_000 + 1).toISOString();
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [conversation("c1")],
      messages: [outbound("m1", "c1", CAMPAIGN_A, day(0))],
      orders: [order("o1", "c1", 1000, justPast)],
    });
    const result = await getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A));
    expect(result.orders).toEqual([]);
  });

  it("sums multiple attributed orders for one customer in perCustomerRevenueCents", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [conversation("c1"), conversation("c2")],
      messages: [
        outbound("m1", "c1", CAMPAIGN_A, day(0)),
        outbound("m2", "c2", CAMPAIGN_A, day(0)),
      ],
      orders: [
        order("o1", "c1", 3000, day(2)),
        order("o2", "c1", 4500, day(6)),
      ],
    });
    const result = await getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A));
    expect(result.revenueCents).toBe(7500);
    expect(result.customersWithOrders).toBe(1);
    // c1 → 7500 (two orders summed), c2 → 0. One entry per cohort customer.
    expect([...result.perCustomerRevenueCents].sort((a, b) => a - b)).toEqual([0, 7500]);
  });

  it("skips an outbound whose conversation cannot be resolved to a customer", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [conversation("c1")], // no conversation for c-orphan's message
      messages: [
        outbound("m1", "c1", CAMPAIGN_A, day(0)),
        // conversation_id "conv-c-orphan" has no conversations row
        {
          id: "m-orphan",
          merchant_id: MERCHANT,
          conversation_id: "conv-c-orphan",
          direction: "outbound",
          campaign_id: CAMPAIGN_A,
          arm_id: "arm",
          sent_at: day(0),
        },
      ],
      orders: [],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    expect(cohort.cohort).toEqual(["c1"]); // orphan message contributes no customer
  });

  it("throws on a malformed order timestamp rather than silently dropping it", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      conversations: [conversation("c1")],
      messages: [outbound("m1", "c1", CAMPAIGN_A, day(0))],
      orders: [order("o1", "c1", 1000, "not-a-date")],
    });
    await expect(
      getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A)),
    ).rejects.toThrow(/valid timestamp/);
  });

  it("propagates a query error from the orders fetch", async () => {
    const { client } = makeFakeSupabase(
      {
        campaign_proposals: [proposal(CAMPAIGN_A, 14)],
        conversations: [conversation("c1")],
        messages: [outbound("m1", "c1", CAMPAIGN_A, day(0))],
        orders: [],
      },
      { failOn: [{ table: "orders", op: "select" }] },
    );
    await expect(
      getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A)),
    ).rejects.toThrow(/fake error/);
  });

  it("propagates a query error from the campaign-proposal lookup", async () => {
    const { client } = makeFakeSupabase(
      { campaign_proposals: [proposal(CAMPAIGN_A, 14)] },
      { failOn: [{ table: "campaign_proposals", op: "select" }] },
    );
    await expect(getTreatmentCohort(client, CAMPAIGN_A)).rejects.toThrow(/fake error/);
  });
});
