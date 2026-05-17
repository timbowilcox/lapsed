// Treatment cohort engine tests — Sprint 09 chunk 2 (symmetric-ITT refactor).
//
// The treatment cohort is now the ITT snapshot (`campaign_group_snapshots`
// where `included_in_holdout = false`), NOT the set of customers who received
// an outbound. Orders are counted over the campaign-calendar window
// `[launched_at, launched_at + windowDays]`. See decision 27.

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

/** A frozen ITT snapshot row (decision 27). included_in_holdout defaults false. */
function snapshot(customerId: string, campaignId: string, includedInHoldout = false): FakeRow {
  return {
    proposal_id: campaignId,
    merchant_id: MERCHANT,
    customer_id: customerId,
    included_in_holdout: includedInHoldout,
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

describe("getTreatmentCohort — ITT snapshot source (decision 27)", () => {
  it("returns the non-holdout snapshot customers, deduplicated and sorted", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [
        snapshot("cust-2", CAMPAIGN_A),
        snapshot("cust-1", CAMPAIGN_A),
        snapshot("h-1", CAMPAIGN_A, true), // holdout — excluded from treatment
      ],
      conversations: [conversation("cust-1"), conversation("cust-2")],
      messages: [
        outbound("m1", "cust-1", CAMPAIGN_A, day(0)),
        outbound("m2", "cust-2", CAMPAIGN_A, day(0)),
      ],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    expect(cohort.cohort).toEqual(["cust-1", "cust-2"]);
    expect(cohort.windowDays).toBe(14);
    expect(cohort.merchantId).toBe(MERCHANT);
  });

  it("includes a snapshot customer who received NO outbound (opt-out / cap-deferred)", async () => {
    // cust-sent received an outbound; cust-quiet is in the ITT snapshot but
    // never got a send (opted out before launch, or daily-cap-deferred). Both
    // count in the cohort denominator (decision 27).
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [
        snapshot("cust-sent", CAMPAIGN_A),
        snapshot("cust-quiet", CAMPAIGN_A),
      ],
      conversations: [conversation("cust-sent")],
      messages: [outbound("m1", "cust-sent", CAMPAIGN_A, day(0))],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    expect(cohort.cohort).toEqual(["cust-quiet", "cust-sent"]);
    // Only one outbound was actually sent — cohort size (2) exceeds it.
    expect(cohort.outbounds).toHaveLength(1);
  });

  it("cohort size equals the campaign_group_snapshots non-holdout row count", async () => {
    const snapshots: FakeRow[] = [];
    for (let i = 0; i < 7; i++) snapshots.push(snapshot(`t${i}`, CAMPAIGN_A));
    for (let i = 0; i < 3; i++) snapshots.push(snapshot(`h${i}`, CAMPAIGN_A, true));
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: snapshots,
      conversations: [],
      messages: [],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    expect(cohort.cohort).toHaveLength(7); // 7 non-holdout, 3 holdout excluded
  });

  it("returns an empty cohort when the snapshot has no non-holdout customers", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [snapshot("h-1", CAMPAIGN_A, true)],
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

  it("propagates a query error from the campaign-proposal lookup", async () => {
    const { client } = makeFakeSupabase(
      { campaign_proposals: [proposal(CAMPAIGN_A, 14)] },
      { failOn: [{ table: "campaign_proposals", op: "select" }] },
    );
    await expect(getTreatmentCohort(client, CAMPAIGN_A)).rejects.toThrow(/fake error/);
  });

  it("propagates a query error from the campaign_group_snapshots fetch", async () => {
    // A silently truncated snapshot read would understate the ITT denominator
    // and inflate the billing meter — the error must surface, never be swallowed.
    const { client } = makeFakeSupabase(
      {
        campaign_proposals: [proposal(CAMPAIGN_A, 14)],
        campaign_group_snapshots: [snapshot("cust-1", CAMPAIGN_A)],
      },
      { failOn: [{ table: "campaign_group_snapshots", op: "select" }] },
    );
    await expect(getTreatmentCohort(client, CAMPAIGN_A)).rejects.toThrow(/fake error/);
  });
});

describe("getTreatmentOrders — calendar window, single campaign", () => {
  it("attributes an in-window order and excludes an out-of-window order", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [
        snapshot("cust-1", CAMPAIGN_A),
        snapshot("cust-2", CAMPAIGN_A),
      ],
      conversations: [conversation("cust-1"), conversation("cust-2")],
      messages: [
        outbound("m1", "cust-1", CAMPAIGN_A, day(0)),
        outbound("m2", "cust-2", CAMPAIGN_A, day(0)),
      ],
      orders: [
        order("o1", "cust-1", 5000, day(5)), // within [day0, day14] → attributed
        order("o2", "cust-2", 9900, day(20)), // outside the calendar window → excluded
      ],
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    const result = await getTreatmentOrders(client, cohort);

    expect(result.orders.map((o) => o.orderId)).toEqual(["o1"]);
    expect(result.revenueCents).toBe(5000);
    expect(result.customersWithOrders).toBe(1);
    // Per-customer distribution has one entry per ITT cohort customer.
    expect(result.perCustomerRevenueCents.sort((a, b) => a - b)).toEqual([0, 5000]);
  });

  it("counts an order from a sent-to customer regardless of cohort send rate", async () => {
    // Three ITT customers; only one received a send. The buyer is attributed;
    // the two quiet customers contribute zero. perCustomer length == cohort 3.
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [
        snapshot("buyer", CAMPAIGN_A),
        snapshot("quiet-1", CAMPAIGN_A),
        snapshot("quiet-2", CAMPAIGN_A),
      ],
      conversations: [conversation("buyer")],
      messages: [outbound("m1", "buyer", CAMPAIGN_A, day(0))],
      orders: [order("o1", "buyer", 7000, day(3))],
    });
    const result = await getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A));
    expect(result.revenueCents).toBe(7000);
    expect(result.perCustomerRevenueCents).toHaveLength(3);
    expect([...result.perCustomerRevenueCents].sort((a, b) => a - b)).toEqual([0, 0, 7000]);
  });

  it("does NOT attribute an order from an ITT customer who received no outbound", async () => {
    // cust-quiet opted out / send failed — they are in the cohort but have no
    // preceding outbound, so their order is won by no campaign (zero revenue).
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [
        snapshot("cust-sent", CAMPAIGN_A),
        snapshot("cust-quiet", CAMPAIGN_A),
      ],
      conversations: [conversation("cust-sent")],
      messages: [outbound("m1", "cust-sent", CAMPAIGN_A, day(0))],
      orders: [
        order("o1", "cust-sent", 5000, day(4)),
        order("o2", "cust-quiet", 8800, day(6)), // organic — NOT attributed
      ],
    });
    const result = await getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A));
    expect(result.orders.map((o) => o.orderId)).toEqual(["o1"]);
    expect(result.revenueCents).toBe(5000);
    // cust-quiet is in the cohort (entry present) but contributes 0.
    expect(result.perCustomerRevenueCents.sort((a, b) => a - b)).toEqual([0, 5000]);
  });

  it("excludes an order placed before the outbound", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [snapshot("cust-1", CAMPAIGN_A)],
      conversations: [conversation("cust-1")],
      messages: [outbound("m1", "cust-1", CAMPAIGN_A, day(10))],
      orders: [order("o1", "cust-1", 5000, day(2))], // before the outbound
    });
    const cohort = await getTreatmentCohort(client, CAMPAIGN_A);
    const result = await getTreatmentOrders(client, cohort);
    expect(result.orders).toEqual([]);
    expect(result.revenueCents).toBe(0);
  });

  it("excludes an order beyond the calendar window of a late-sent customer", async () => {
    // launched_at = day 0 (earliest outbound). A customer sent to on day 10
    // still has the campaign-calendar window [day0, day14] — NOT [day10, day24].
    // Their order on day 20 is OUTSIDE the campaign window. This is the
    // symmetric-ITT fix: Sprint 08's per-customer window would have included it.
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [
        snapshot("early", CAMPAIGN_A),
        snapshot("late", CAMPAIGN_A),
      ],
      conversations: [conversation("early"), conversation("late")],
      messages: [
        outbound("m-early", "early", CAMPAIGN_A, day(0)),
        outbound("m-late", "late", CAMPAIGN_A, day(10)),
      ],
      orders: [order("o-late", "late", 5000, day(20))], // day20 > day0+14 → excluded
    });
    const result = await getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A));
    expect(result.orders).toEqual([]);
    expect(result.revenueCents).toBe(0);
  });

  it("returns zeros for an empty cohort", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [],
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
    // X places one order on day 5. Both windows are 14d, so both campaign
    // calendar windows qualify — the order must attribute to B (most recent).
    const seed = {
      campaign_proposals: [proposal(CAMPAIGN_A, 14), proposal(CAMPAIGN_B, 14)],
      campaign_group_snapshots: [
        snapshot("cust-X", CAMPAIGN_A),
        snapshot("cust-X", CAMPAIGN_B),
      ],
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

    // Counted exactly once across the two campaigns — never both.
    expect(resultA.orders.length + resultB.orders.length).toBe(1);
  });

  it("breaks an exact-same-sent_at tie deterministically by message id", async () => {
    // A and B both send at day 0 to cust-X; order on day 5. The winner must be
    // stable (lexically-smallest message id) regardless of seed/row order.
    const seed = {
      campaign_proposals: [proposal(CAMPAIGN_A, 14), proposal(CAMPAIGN_B, 14)],
      campaign_group_snapshots: [
        snapshot("cust-X", CAMPAIGN_A),
        snapshot("cust-X", CAMPAIGN_B),
      ],
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

  it("a winning campaign counts the order only if the customer is in ITS ITT cohort", async () => {
    // cust-X is in campaign A's ITT snapshot but NOT B's. X received outbounds
    // from both (A day 0, B day 3) and orders on day 5. Single-attribution
    // names B the winner (most-recent-preceding) — so A does not count it. But
    // X is not in B's ITT cohort, so getTreatmentOrders(B) never fetches X's
    // order either. The order is attributed to B by the winner rule yet lands
    // in NO campaign's treatment revenue — the correct, defensible semantics
    // of "cohort = the frozen snapshot" combined with "winner = any outbound".
    const seed = {
      campaign_proposals: [proposal(CAMPAIGN_A, 14), proposal(CAMPAIGN_B, 14)],
      campaign_group_snapshots: [
        snapshot("cust-X", CAMPAIGN_A),
        snapshot("cust-Y", CAMPAIGN_B), // B's cohort is cust-Y, not cust-X
      ],
      conversations: [conversation("cust-X")],
      messages: [
        outbound("mA", "cust-X", CAMPAIGN_A, day(0)),
        outbound("mB", "cust-X", CAMPAIGN_B, day(3)),
      ],
      orders: [order("o1", "cust-X", 9000, day(5))],
    };
    const { client: cA } = makeFakeSupabase(seed);
    const rA = await getTreatmentOrders(cA, await getTreatmentCohort(cA, CAMPAIGN_A));
    expect(rA.revenueCents).toBe(0); // B won the order — A does not count it

    const { client: cB } = makeFakeSupabase(seed);
    const cohortB = await getTreatmentCohort(cB, CAMPAIGN_B);
    expect(cohortB.cohort).toEqual(["cust-Y"]); // X is not in B's ITT snapshot
    const rB = await getTreatmentOrders(cB, cohortB);
    expect(rB.revenueCents).toBe(0); // X's order is never fetched for B's cohort
  });

  it("attributes to A when B's calendar window does not cover the order", async () => {
    // B launched day 0 with a SHORT 2-day window; A launched day 1 with 14d.
    // Order on day 5: B's calendar window [day0, day2] does NOT cover it; A's
    // [day1, day15] does → A wins even though B's outbound was earlier.
    const seed = {
      campaign_proposals: [proposal(CAMPAIGN_A, 14), proposal(CAMPAIGN_B, 2)],
      campaign_group_snapshots: [
        snapshot("cust-X", CAMPAIGN_A),
        snapshot("cust-X", CAMPAIGN_B),
      ],
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
  it("includes an order placed exactly at the calendar-window edge and at the send instant", async () => {
    // launched_at = day 0. Calendar window [day0, day14].
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [
        snapshot("c-edge", CAMPAIGN_A),
        snapshot("c-instant", CAMPAIGN_A),
      ],
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

  it("excludes an order one millisecond past the calendar-window edge", async () => {
    const justPast = new Date(Date.UTC(2026, 3, 1) + 14 * 86_400_000 + 1).toISOString();
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [snapshot("c1", CAMPAIGN_A)],
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
      campaign_group_snapshots: [
        snapshot("c1", CAMPAIGN_A),
        snapshot("c2", CAMPAIGN_A),
      ],
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
      campaign_group_snapshots: [snapshot("c1", CAMPAIGN_A)],
      conversations: [conversation("c1")], // no conversation for the orphan message
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
    expect(cohort.cohort).toEqual(["c1"]); // cohort is the snapshot, unaffected
    expect(cohort.outbounds).toHaveLength(1); // the orphan outbound is dropped
  });

  it("throws on a malformed order timestamp rather than silently dropping it", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [snapshot("c1", CAMPAIGN_A)],
      conversations: [conversation("c1")],
      messages: [outbound("m1", "c1", CAMPAIGN_A, day(0))],
      orders: [order("o1", "c1", 1000, "not-a-date")],
    });
    await expect(
      getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A)),
    ).rejects.toThrow(/valid timestamp/);
  });

  it("throws on a non-integer total_price_cents", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposal(CAMPAIGN_A, 14)],
      campaign_group_snapshots: [snapshot("c1", CAMPAIGN_A)],
      conversations: [conversation("c1")],
      messages: [outbound("m1", "c1", CAMPAIGN_A, day(0))],
      orders: [order("o1", "c1", 100.5, day(3))],
    });
    await expect(
      getTreatmentOrders(client, await getTreatmentCohort(client, CAMPAIGN_A)),
    ).rejects.toThrow(/not an integer/);
  });

  it("propagates a query error from the orders fetch", async () => {
    const { client } = makeFakeSupabase(
      {
        campaign_proposals: [proposal(CAMPAIGN_A, 14)],
        campaign_group_snapshots: [snapshot("c1", CAMPAIGN_A)],
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
});
