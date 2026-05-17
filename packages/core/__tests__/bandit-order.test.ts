import { describe, expect, it, vi } from "vitest";
import {
  recordOrderArrival,
  recordNoOrderOutcome,
  selectArm,
  ORDER_POSTERIOR_MIN_OBSERVATIONS,
  type RecordOrderArrivalInput,
  type RecordNoOrderInput,
} from "../src/bandit-order";
import { makeFakeSupabase, type FakeRow, type FakeSupabaseOptions } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_MERCHANT = "660e8400-e29b-41d4-a716-446655440000";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const ARM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORDER_1 = "00000000-0000-4000-8000-000000000001";
const MESSAGE_1 = "33333333-3333-4333-8333-333333333331";
const CUSTOMER = "gid://shopify/Customer/1";
const FIXED_NOW = () => new Date("2026-05-17T00:00:00.000Z");

/** The campaign_proposals row the tenancy guard reads. */
const PROPOSAL: FakeRow = { id: CAMPAIGN, merchant_id: MERCHANT };

/**
 * A bandit_state row. `sentiment` / `order` are [alpha, beta]; `orderObs` is
 * the order observation count that drives the selectArm threshold.
 */
function banditRow(
  armId: string,
  sentiment: [number, number],
  order: [number, number],
  orderObs = 0,
): FakeRow {
  return {
    arm_id: armId,
    merchant_id: MERCHANT,
    proposal_id: CAMPAIGN,
    sentiment_alpha: sentiment[0],
    sentiment_beta: sentiment[1],
    order_alpha: order[0],
    order_beta: order[1],
    observation_count: sentiment[0] + sentiment[1] - 2,
    order_observation_count: orderObs,
    last_updated_at: "2026-05-16T00:00:00.000Z",
    order_last_updated_at: null,
  };
}

/** Seeds campaign_proposals (tenancy guard) + the given bandit_state rows. */
function seed(banditRows: FakeRow[], opts?: FakeSupabaseOptions) {
  return makeFakeSupabase(
    { campaign_proposals: [PROPOSAL], bandit_state: banditRows },
    opts,
  );
}

function arrivalInput(over: Partial<RecordOrderArrivalInput> = {}): RecordOrderArrivalInput {
  return {
    merchantId: MERCHANT,
    campaignId: CAMPAIGN,
    orderId: ORDER_1,
    customerId: CUSTOMER,
    attributedMessageId: MESSAGE_1,
    armId: ARM_A,
    attributionWindowDays: 14,
    ...over,
  };
}

function noOrderInput(over: Partial<RecordNoOrderInput> = {}): RecordNoOrderInput {
  return {
    merchantId: MERCHANT,
    campaignId: CAMPAIGN,
    customerId: "gid://shopify/Customer/9",
    armId: ARM_A,
    attributionWindowDays: 14,
    ...over,
  };
}

describe("recordOrderArrival", () => {
  it("moves the ORDER posterior and leaves the SENTIMENT posterior untouched", async () => {
    // Sprint 07 left the sentiment posterior at (2,1) — a positive-fired arm.
    const { client, tables } = seed([banditRow(ARM_A, [2, 1], [1, 1])]);
    const result = await recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW });

    expect(result).toEqual({ alreadyRecorded: false, posteriorUpdated: true });
    const arm = tables.bandit_state![0]!;
    expect(arm.order_alpha).toBe(2);
    expect(arm.order_beta).toBe(1);
    expect(arm.order_observation_count).toBe(1);
    expect(arm.order_last_updated_at).toBe("2026-05-17T00:00:00.000Z");
    expect(arm.sentiment_alpha).toBe(2);
    expect(arm.sentiment_beta).toBe(1);
    expect(tables.attribution_decisions).toHaveLength(1);
    expect(tables.attribution_decisions![0]!.decision_type).toBe("attributed");
    expect(tables.attribution_decisions![0]!.order_id).toBe(ORDER_1);
  });

  it("fires order_alpha+1 even on an arm the sentiment signal scored as a failure", async () => {
    // Sprint 07 fired sentiment beta+1 on this arm → sentiment (1,2).
    const { client, tables } = seed([banditRow(ARM_A, [1, 2], [1, 1])]);
    await recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW });
    const arm = tables.bandit_state![0]!;
    expect(arm.order_alpha).toBe(2);
    expect(arm.order_beta).toBe(1);
    expect(arm.sentiment_alpha).toBe(1);
    expect(arm.sentiment_beta).toBe(2);
  });

  it("is idempotent — the same order processed twice does not double-update", async () => {
    const { client, tables } = seed([banditRow(ARM_A, [2, 1], [1, 1])]);
    const first = await recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW });
    const second = await recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW });

    expect(first.alreadyRecorded).toBe(false);
    expect(second.alreadyRecorded).toBe(true);
    expect(second.posteriorUpdated).toBe(false);
    expect(tables.bandit_state![0]!.order_alpha).toBe(2);
    expect(tables.bandit_state![0]!.order_observation_count).toBe(1);
    expect(tables.attribution_decisions).toHaveLength(1);
  });

  it("treats a unique-violation on the decision insert as already-recorded (race backstop)", async () => {
    // The pre-check passes (no row), then a concurrent run's row makes the
    // insert fail 23505 — the posterior must NOT move.
    const { client, tables } = seed([banditRow(ARM_A, [2, 1], [1, 1])], {
      failOn: [{ table: "attribution_decisions", op: "insert", code: "23505" }],
    });
    const result = await recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW });
    expect(result).toEqual({ alreadyRecorded: true, posteriorUpdated: false });
    expect(tables.bandit_state![0]!.order_alpha).toBe(1); // unchanged
  });

  it("records the decision but skips the posterior when the outbound carried no arm", async () => {
    const { client, tables } = seed([]);
    const result = await recordOrderArrival(client, arrivalInput({ armId: null }), {
      now: FIXED_NOW,
    });
    expect(result).toEqual({ alreadyRecorded: false, posteriorUpdated: false });
    expect(tables.attribution_decisions).toHaveLength(1);
  });

  it("throws when the arm has no bandit_state row", async () => {
    const { client } = seed([]);
    await expect(recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW })).rejects.toThrow(
      /no bandit_state row/,
    );
  });

  it("rejects an order whose campaign belongs to a different merchant (tenancy)", async () => {
    const { client } = seed([banditRow(ARM_A, [2, 1], [1, 1])]);
    await expect(
      recordOrderArrival(client, arrivalInput({ merchantId: OTHER_MERCHANT }), { now: FIXED_NOW }),
    ).rejects.toThrow(/does not belong to merchant/);
  });

  it("rejects a non-UUID orderId", async () => {
    const { client } = seed([banditRow(ARM_A, [2, 1], [1, 1])]);
    await expect(
      recordOrderArrival(client, arrivalInput({ orderId: "nope" }), { now: FIXED_NOW }),
    ).rejects.toThrow(/orderId/);
  });

  it("propagates a query error from the idempotency pre-check", async () => {
    const { client } = seed([banditRow(ARM_A, [2, 1], [1, 1])], {
      failOn: [{ table: "attribution_decisions", op: "select" }],
    });
    await expect(recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW })).rejects.toThrow(
      /fake error/,
    );
  });

  it("propagates a non-unique error from the decision insert", async () => {
    const { client } = seed([banditRow(ARM_A, [2, 1], [1, 1])], {
      failOn: [{ table: "attribution_decisions", op: "insert" }],
    });
    await expect(recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW })).rejects.toThrow(
      /fake error/,
    );
  });

  it("logs posterior_orphaned and rethrows when the posterior update fails after the decision row commits", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, tables } = seed([banditRow(ARM_A, [2, 1], [1, 1])], {
      failOn: [{ table: "bandit_state", op: "update" }],
    });
    await expect(recordOrderArrival(client, arrivalInput(), { now: FIXED_NOW })).rejects.toThrow(
      /fake error/,
    );
    // The decision row is committed (the idempotency ledger) even though the
    // posterior did not move — and the drift is logged.
    expect(tables.attribution_decisions).toHaveLength(1);
    expect(warn.mock.calls[0]?.[0] as string).toContain("posterior_orphaned");
    warn.mockRestore();
  });
});

describe("recordNoOrderOutcome", () => {
  it("fires order_beta+1 and leaves the sentiment posterior untouched", async () => {
    const { client, tables } = seed([banditRow(ARM_A, [3, 2], [1, 1])]);
    const result = await recordNoOrderOutcome(client, noOrderInput(), { now: FIXED_NOW });
    expect(result).toEqual({ alreadyRecorded: false, posteriorUpdated: true });
    const arm = tables.bandit_state![0]!;
    expect(arm.order_alpha).toBe(1);
    expect(arm.order_beta).toBe(2);
    expect(arm.order_observation_count).toBe(1);
    expect(arm.sentiment_alpha).toBe(3);
    expect(arm.sentiment_beta).toBe(2);
    expect(tables.attribution_decisions![0]!.decision_type).toBe("no_order");
  });

  it("is idempotent per (campaign, customer)", async () => {
    const { client, tables } = seed([banditRow(ARM_A, [1, 1], [1, 1])]);
    await recordNoOrderOutcome(client, noOrderInput(), { now: FIXED_NOW });
    const second = await recordNoOrderOutcome(client, noOrderInput(), { now: FIXED_NOW });
    expect(second.alreadyRecorded).toBe(true);
    expect(tables.bandit_state![0]!.order_beta).toBe(2);
    expect(tables.attribution_decisions).toHaveLength(1);
  });

  it("records the decision but skips the posterior when there is no arm", async () => {
    const { client, tables } = seed([]);
    const result = await recordNoOrderOutcome(client, noOrderInput({ armId: null }), {
      now: FIXED_NOW,
    });
    expect(result).toEqual({ alreadyRecorded: false, posteriorUpdated: false });
    expect(tables.attribution_decisions).toHaveLength(1);
  });

  it("treats a unique-violation on the decision insert as already-recorded", async () => {
    const { client, tables } = seed([banditRow(ARM_A, [1, 1], [1, 1])], {
      failOn: [{ table: "attribution_decisions", op: "insert", code: "23505" }],
    });
    const result = await recordNoOrderOutcome(client, noOrderInput(), { now: FIXED_NOW });
    expect(result).toEqual({ alreadyRecorded: true, posteriorUpdated: false });
    expect(tables.bandit_state![0]!.order_beta).toBe(1);
  });

  it("rejects a campaign that belongs to a different merchant (tenancy)", async () => {
    const { client } = seed([banditRow(ARM_A, [1, 1], [1, 1])]);
    await expect(
      recordNoOrderOutcome(client, noOrderInput({ merchantId: OTHER_MERCHANT }), { now: FIXED_NOW }),
    ).rejects.toThrow(/does not belong to merchant/);
  });

  it("propagates a query error from the posterior read", async () => {
    const { client } = seed([banditRow(ARM_A, [1, 1], [1, 1])], {
      failOn: [{ table: "bandit_state", op: "select" }],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(recordNoOrderOutcome(client, noOrderInput(), { now: FIXED_NOW })).rejects.toThrow(
      /fake error/,
    );
    warn.mockRestore();
  });
});

describe("selectArm — dual-signal threshold (decision 22)", () => {
  it("routes an arm with ≥30 order observations to the order posterior, else sentiment", async () => {
    const { client } = makeFakeSupabase({
      bandit_state: [
        banditRow(ARM_A, [5, 5], [25, 7], 30),
        banditRow(ARM_B, [8, 2], [4, 1], 29),
      ],
    });
    const selection = await selectArm(client, CAMPAIGN, { seed: 12345 });
    const byArm = new Map(selection.perArm.map((a) => [a.armId, a]));

    expect(byArm.get(ARM_A)!.posteriorSource).toBe("order");
    expect(byArm.get(ARM_A)!.alpha).toBe(25);
    expect(byArm.get(ARM_A)!.beta).toBe(7);

    expect(byArm.get(ARM_B)!.posteriorSource).toBe("sentiment");
    expect(byArm.get(ARM_B)!.alpha).toBe(8);
    expect(byArm.get(ARM_B)!.beta).toBe(2);

    expect([ARM_A, ARM_B]).toContain(selection.selectedArmId);
  });

  it("is exactly threshold-gated at ORDER_POSTERIOR_MIN_OBSERVATIONS", async () => {
    expect(ORDER_POSTERIOR_MIN_OBSERVATIONS).toBe(30);
    const { client } = makeFakeSupabase({
      bandit_state: [banditRow(ARM_A, [1, 1], [50, 50], ORDER_POSTERIOR_MIN_OBSERVATIONS)],
    });
    const selection = await selectArm(client, CAMPAIGN, { seed: 1 });
    expect(selection.perArm[0]!.posteriorSource).toBe("order");
  });

  it("is deterministic given a seed", async () => {
    const rows = [banditRow(ARM_A, [3, 2], [1, 1], 0), banditRow(ARM_B, [9, 1], [1, 1], 0)];
    const a = await selectArm(makeFakeSupabase({ bandit_state: rows }).client, CAMPAIGN, {
      seed: 999,
    });
    const b = await selectArm(makeFakeSupabase({ bandit_state: rows }).client, CAMPAIGN, {
      seed: 999,
    });
    expect(a.selectedArmId).toBe(b.selectedArmId);
  });

  it("throws when the campaign has no bandit arms", async () => {
    const { client } = makeFakeSupabase({ bandit_state: [] });
    await expect(selectArm(client, CAMPAIGN)).rejects.toThrow(/no bandit_state arms/);
  });

  it("rejects a non-UUID campaignId", async () => {
    const { client } = makeFakeSupabase({ bandit_state: [] });
    await expect(selectArm(client, "nope")).rejects.toThrow(/campaignId/);
  });

  it("propagates a query error from the bandit_state fetch", async () => {
    const { client } = makeFakeSupabase(
      { bandit_state: [banditRow(ARM_A, [1, 1], [1, 1])] },
      { failOn: [{ table: "bandit_state", op: "select" }] },
    );
    await expect(selectArm(client, CAMPAIGN)).rejects.toThrow(/fake error/);
  });
});
