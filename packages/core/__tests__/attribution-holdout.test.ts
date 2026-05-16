import { describe, expect, it } from "vitest";
import { getHoldoutCohort, getHoldoutOrders } from "../src/attribution-holdout";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";

const day = (n: number): string =>
  new Date(Date.UTC(2026, 3, 1) + n * 86_400_000).toISOString();

function snapshot(customerId: string, isHoldout: boolean): FakeRow {
  return {
    proposal_id: CAMPAIGN,
    merchant_id: MERCHANT,
    customer_id: customerId,
    included_in_holdout: isHoldout,
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

const proposalRow: FakeRow = { id: CAMPAIGN, merchant_id: MERCHANT };
const WINDOW = { startIso: day(0), endIso: day(14) };

describe("getHoldoutCohort", () => {
  it("returns only the included_in_holdout customers from the frozen snapshot", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [
        snapshot("h1", true),
        snapshot("h2", true),
        snapshot("t1", false), // treatment member — must NOT be in the holdout
        snapshot("t2", false),
      ],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    expect(cohort.cohort).toEqual(["h1", "h2"]);
    expect(cohort.merchantId).toBe(MERCHANT);
  });

  it("reads the frozen snapshot — a later group-membership change does not leak in", async () => {
    // campaign_group_snapshots IS the frozen set (decision 15). Only the rows
    // captured at proposal time are returned; nothing live-recomputes the group.
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [snapshot("h1", true)],
      // A live customer_inferred_state group change post-snapshot is irrelevant.
      customer_inferred_state: [
        { merchant_id: MERCHANT, shopify_customer_gid: "h999", group_memberships: ["lapsed_vips"] },
      ],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    expect(cohort.cohort).toEqual(["h1"]);
  });

  it("returns an empty cohort when the proposal has no holdout rows", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [snapshot("t1", false)],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    expect(cohort.cohort).toEqual([]);
  });

  it("throws when the campaign proposal does not exist", async () => {
    const { client } = makeFakeSupabase({ campaign_proposals: [] });
    await expect(getHoldoutCohort(client, CAMPAIGN)).rejects.toThrow(/not found/);
  });

  it("propagates a query error from the snapshot fetch", async () => {
    const { client } = makeFakeSupabase(
      { campaign_proposals: [proposalRow], campaign_group_snapshots: [] },
      { failOn: [{ table: "campaign_group_snapshots", op: "select" }] },
    );
    await expect(getHoldoutCohort(client, CAMPAIGN)).rejects.toThrow(/fake error/);
  });
});

describe("getHoldoutOrders", () => {
  it("counts holdout orders inside the calendar window and excludes those outside", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [snapshot("h1", true), snapshot("h2", true)],
      orders: [
        order("o1", "h1", 4000, day(5)), // inside window → counted
        order("o2", "h1", 1000, day(20)), // after window → excluded
        order("o3", "h2", 2500, day(0)), // exactly window start → counted
      ],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    const result = await getHoldoutOrders(client, cohort, WINDOW);
    expect(result.orders.map((o) => o.orderId).sort()).toEqual(["o1", "o3"]);
    expect(result.revenueCents).toBe(6500);
    expect(result.customersWithOrders).toBe(2);
    // One per-customer entry per holdout customer.
    expect([...result.perCustomerRevenueCents].sort((a, b) => a - b)).toEqual([2500, 4000]);
  });

  it("includes an order exactly at the window end and excludes one just past it", async () => {
    const justPast = new Date(Date.UTC(2026, 3, 1) + 14 * 86_400_000 + 1).toISOString();
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [snapshot("h1", true)],
      orders: [
        order("edge", "h1", 1000, day(14)),
        order("past", "h1", 9999, justPast),
      ],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    const result = await getHoldoutOrders(client, cohort, WINDOW);
    expect(result.orders.map((o) => o.orderId)).toEqual(["edge"]);
    expect(result.revenueCents).toBe(1000);
  });

  it("returns zeros for an empty holdout cohort", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [snapshot("t1", false)],
      orders: [],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    const result = await getHoldoutOrders(client, cohort, WINDOW);
    expect(result).toEqual({
      orders: [],
      revenueCents: 0,
      customersWithOrders: 0,
      perCustomerRevenueCents: [],
    });
  });

  it("sums multiple in-window orders for one holdout customer", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [snapshot("h1", true), snapshot("h2", true)],
      orders: [
        order("o1", "h1", 3000, day(2)),
        order("o2", "h1", 1500, day(9)),
      ],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    const result = await getHoldoutOrders(client, cohort, WINDOW);
    expect(result.revenueCents).toBe(4500);
    expect(result.customersWithOrders).toBe(1);
    expect([...result.perCustomerRevenueCents].sort((a, b) => a - b)).toEqual([0, 4500]);
  });

  it("throws on a malformed calendar-window timestamp, even for an empty cohort", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [], // empty holdout
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    await expect(
      getHoldoutOrders(client, cohort, { startIso: "not-a-date", endIso: day(14) }),
    ).rejects.toThrow(/valid timestamp/);
  });

  it("throws on a non-integer total_price_cents", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [snapshot("h1", true)],
      orders: [order("o1", "h1", 4000.5, day(5))],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    await expect(getHoldoutOrders(client, cohort, WINDOW)).rejects.toThrow(/not an integer/);
  });

  it("throws on a malformed order timestamp", async () => {
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: [snapshot("h1", true)],
      orders: [order("o1", "h1", 1000, "not-a-date")],
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    await expect(getHoldoutOrders(client, cohort, WINDOW)).rejects.toThrow(/valid timestamp/);
  });

  it("counts orders across a cohort larger than the .in() chunk size", async () => {
    // 250 holdout customers > IN_CLAUSE_CHUNK (200), so the orders fetch runs
    // in two chunks — verify accumulation across chunk boundaries is correct.
    const snapshots: FakeRow[] = [];
    const orders: FakeRow[] = [];
    for (let i = 0; i < 250; i++) {
      const cid = `h${String(i).padStart(3, "0")}`;
      snapshots.push(snapshot(cid, true));
    }
    // One order for a customer in the first chunk and one in the second.
    orders.push(order("o-early", "h005", 1100, day(4)));
    orders.push(order("o-late", "h240", 2200, day(8)));
    const { client } = makeFakeSupabase({
      campaign_proposals: [proposalRow],
      campaign_group_snapshots: snapshots,
      orders,
    });
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    expect(cohort.cohort).toHaveLength(250);
    const result = await getHoldoutOrders(client, cohort, WINDOW);
    expect(result.revenueCents).toBe(3300);
    expect(result.customersWithOrders).toBe(2);
    expect(result.perCustomerRevenueCents).toHaveLength(250);
  });

  it("propagates a query error from the orders fetch", async () => {
    const { client } = makeFakeSupabase(
      {
        campaign_proposals: [proposalRow],
        campaign_group_snapshots: [snapshot("h1", true)],
        orders: [],
      },
      { failOn: [{ table: "orders", op: "select" }] },
    );
    const cohort = await getHoldoutCohort(client, CAMPAIGN);
    await expect(getHoldoutOrders(client, cohort, WINDOW)).rejects.toThrow(/fake error/);
  });
});
