import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import {
  isHeldOut,
  computeGroupSnapshot,
  snapshotGroup,
  HOLDOUT_RATE_DEFAULT,
  type SnapshotGroupInput,
} from "../src/snapshot-group";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID_2 = "22222222-2222-4222-8222-222222222222";

function makeCustomerIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `gid://shopify/Customer/${i}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock client — records upsert calls
// ─────────────────────────────────────────────────────────────────────────────

type UpsertCall = { table: string; rows: unknown; opts: unknown };

function makeMockClient(upsertError?: { message: string }) {
  const upserts: UpsertCall[] = [];
  const client = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn((rows: unknown, opts: unknown) => {
        upserts.push({ table, rows, opts });
        return Promise.resolve(
          upsertError ? { data: null, error: upsertError } : { data: null, error: null },
        );
      }),
    })),
  } as unknown as LapsedSupabaseClient;
  return { client, upserts };
}

// ─────────────────────────────────────────────────────────────────────────────
// isHeldOut — determinism
// ─────────────────────────────────────────────────────────────────────────────

describe("isHeldOut — determinism", () => {
  it("returns the same verdict for the same (proposalId, customerId)", () => {
    const a = isHeldOut(PROPOSAL_ID, "gid://shopify/Customer/42");
    const b = isHeldOut(PROPOSAL_ID, "gid://shopify/Customer/42");
    expect(a).toBe(b);
  });

  it("is stable across 100 repeated calls", () => {
    const first = isHeldOut(PROPOSAL_ID, "gid://shopify/Customer/7");
    for (let i = 0; i < 100; i++) {
      expect(isHeldOut(PROPOSAL_ID, "gid://shopify/Customer/7")).toBe(first);
    }
  });

  it("a different proposalId can change a customer's holdout verdict", () => {
    // Over a sample, the two proposals must disagree for at least one customer —
    // otherwise the per-proposal seed would be doing nothing.
    const ids = makeCustomerIds(200);
    const disagreements = ids.filter(
      (id) => isHeldOut(PROPOSAL_ID, id) !== isHeldOut(PROPOSAL_ID_2, id),
    );
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it("does not depend on customerId ordering", () => {
    const id = "gid://shopify/Customer/999";
    expect(isHeldOut(PROPOSAL_ID, id)).toBe(isHeldOut(PROPOSAL_ID, id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isHeldOut — rate distribution
// ─────────────────────────────────────────────────────────────────────────────

describe("isHeldOut — rate distribution", () => {
  it("holds out roughly 10% at the default rate over a large sample", () => {
    const ids = makeCustomerIds(5000);
    const heldOut = ids.filter((id) => isHeldOut(PROPOSAL_ID, id)).length;
    const fraction = heldOut / ids.length;
    // SHA-256 distribution; allow a generous band around 0.10.
    expect(fraction).toBeGreaterThan(0.07);
    expect(fraction).toBeLessThan(0.13);
  });

  it("holds out roughly 50% at rate 0.5", () => {
    const ids = makeCustomerIds(5000);
    const heldOut = ids.filter((id) => isHeldOut(PROPOSAL_ID, id, 0.5)).length;
    const fraction = heldOut / ids.length;
    expect(fraction).toBeGreaterThan(0.44);
    expect(fraction).toBeLessThan(0.56);
  });

  it("holds out roughly 20% at rate 0.2", () => {
    const ids = makeCustomerIds(5000);
    const heldOut = ids.filter((id) => isHeldOut(PROPOSAL_ID, id, 0.2)).length;
    const fraction = heldOut / ids.length;
    expect(fraction).toBeGreaterThan(0.16);
    expect(fraction).toBeLessThan(0.24);
  });

  it("HOLDOUT_RATE_DEFAULT is 0.1", () => {
    expect(HOLDOUT_RATE_DEFAULT).toBe(0.1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeGroupSnapshot — pure partition
// ─────────────────────────────────────────────────────────────────────────────

describe("computeGroupSnapshot", () => {
  it("returns every input customer in customerIds", () => {
    const ids = makeCustomerIds(50);
    const { customerIds } = computeGroupSnapshot(PROPOSAL_ID, ids);
    expect(customerIds.sort()).toEqual([...ids].sort());
  });

  it("holdoutIds is a strict subset of customerIds", () => {
    const ids = makeCustomerIds(300);
    const { customerIds, holdoutIds } = computeGroupSnapshot(PROPOSAL_ID, ids);
    const full = new Set(customerIds);
    expect(holdoutIds.every((id) => full.has(id))).toBe(true);
    expect(holdoutIds.length).toBeLessThan(customerIds.length);
  });

  it("deduplicates repeated customer IDs", () => {
    const { customerIds } = computeGroupSnapshot(PROPOSAL_ID, [
      "gid://a",
      "gid://a",
      "gid://b",
      "gid://b",
      "gid://b",
    ]);
    expect(customerIds).toEqual(["gid://a", "gid://b"]);
  });

  it("preserves first-seen order of customer IDs", () => {
    const { customerIds } = computeGroupSnapshot(PROPOSAL_ID, [
      "gid://z",
      "gid://m",
      "gid://a",
    ]);
    expect(customerIds).toEqual(["gid://z", "gid://m", "gid://a"]);
  });

  it("returns empty arrays for an empty customer list", () => {
    expect(computeGroupSnapshot(PROPOSAL_ID, [])).toEqual({
      customerIds: [],
      holdoutIds: [],
    });
  });

  it("is deterministic across repeated calls", () => {
    const ids = makeCustomerIds(120);
    const a = computeGroupSnapshot(PROPOSAL_ID, ids);
    const b = computeGroupSnapshot(PROPOSAL_ID, ids);
    expect(a).toEqual(b);
  });

  it("each holdout member individually satisfies isHeldOut", () => {
    const ids = makeCustomerIds(200);
    const { holdoutIds } = computeGroupSnapshot(PROPOSAL_ID, ids);
    expect(holdoutIds.every((id) => isHeldOut(PROPOSAL_ID, id))).toBe(true);
  });

  it("non-holdout members individually fail isHeldOut", () => {
    const ids = makeCustomerIds(200);
    const { customerIds, holdoutIds } = computeGroupSnapshot(PROPOSAL_ID, ids);
    const holdoutSet = new Set(holdoutIds);
    const nonHoldout = customerIds.filter((id) => !holdoutSet.has(id));
    expect(nonHoldout.every((id) => !isHeldOut(PROPOSAL_ID, id))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// snapshotGroup — persistence
// ─────────────────────────────────────────────────────────────────────────────

describe("snapshotGroup — happy path", () => {
  function validInput(overrides: Partial<SnapshotGroupInput> = {}): SnapshotGroupInput {
    return {
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      groupSlug: "lapsed_vips",
      customerIds: makeCustomerIds(100),
      ...overrides,
    };
  }

  it("writes one campaign_group_snapshots row per unique customer", async () => {
    const { client, upserts } = makeMockClient();
    await snapshotGroup(client, validInput());
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.table).toBe("campaign_group_snapshots");
    expect((upserts[0]!.rows as unknown[]).length).toBe(100);
  });

  it("marks included_in_holdout exactly for the deterministic holdout subset", async () => {
    const { client, upserts } = makeMockClient();
    const input = validInput();
    const result = await snapshotGroup(client, input);
    const rows = upserts[0]!.rows as Array<{
      customer_id: string;
      included_in_holdout: boolean;
    }>;
    const holdoutSet = new Set(result.holdoutIds);
    for (const row of rows) {
      expect(row.included_in_holdout).toBe(holdoutSet.has(row.customer_id));
    }
  });

  it("each row carries the proposal_id and merchant_id", async () => {
    const { client, upserts } = makeMockClient();
    await snapshotGroup(client, validInput());
    const rows = upserts[0]!.rows as Array<{ proposal_id: string; merchant_id: string }>;
    expect(rows.every((r) => r.proposal_id === PROPOSAL_ID)).toBe(true);
    expect(rows.every((r) => r.merchant_id === MERCHANT_ID)).toBe(true);
  });

  it("uses ON CONFLICT DO NOTHING on the composite PK for idempotency", async () => {
    const { client, upserts } = makeMockClient();
    await snapshotGroup(client, validInput());
    expect(upserts[0]!.opts).toEqual({
      onConflict: "proposal_id,customer_id",
      ignoreDuplicates: true,
    });
  });

  it("returns the full customer set and the holdout subset", async () => {
    const { client } = makeMockClient();
    const result = await snapshotGroup(client, validInput());
    expect(result.customerIds).toHaveLength(100);
    expect(result.holdoutIds.length).toBeGreaterThan(0);
    expect(result.holdoutIds.length).toBeLessThan(100);
  });

  it("holds out ~10% of a 1000-customer group", async () => {
    const { client } = makeMockClient();
    const result = await snapshotGroup(client, validInput({ customerIds: makeCustomerIds(1000) }));
    const fraction = result.holdoutIds.length / result.customerIds.length;
    expect(fraction).toBeGreaterThan(0.07);
    expect(fraction).toBeLessThan(0.13);
  });

  it("respects a custom holdoutRate of 0.5", async () => {
    const { client } = makeMockClient();
    const result = await snapshotGroup(
      client,
      validInput({ customerIds: makeCustomerIds(1000), holdoutRate: 0.5 }),
    );
    const fraction = result.holdoutIds.length / result.customerIds.length;
    expect(fraction).toBeGreaterThan(0.44);
    expect(fraction).toBeLessThan(0.56);
  });

  it("deduplicates customer IDs before writing", async () => {
    const { client, upserts } = makeMockClient();
    const result = await snapshotGroup(
      client,
      validInput({ customerIds: ["gid://a", "gid://a", "gid://b"] }),
    );
    expect(result.customerIds).toEqual(["gid://a", "gid://b"]);
    expect((upserts[0]!.rows as unknown[]).length).toBe(2);
  });

  it("does not write when the customer list is empty", async () => {
    const { client, upserts } = makeMockClient();
    const result = await snapshotGroup(client, validInput({ customerIds: [] }));
    expect(upserts).toHaveLength(0);
    expect(result).toEqual({ customerIds: [], holdoutIds: [] });
  });

  it("produces an identical result when called twice (idempotent)", async () => {
    const { client: c1 } = makeMockClient();
    const { client: c2 } = makeMockClient();
    const input = validInput();
    const a = await snapshotGroup(c1, input);
    const b = await snapshotGroup(c2, input);
    expect(a).toEqual(b);
  });
});

describe("snapshotGroup — validation + errors", () => {
  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeMockClient();
    await expect(
      snapshotGroup(client, {
        merchantId: "not-a-uuid",
        proposalId: PROPOSAL_ID,
        groupSlug: "lapsed_vips",
        customerIds: ["gid://a"],
      }),
    ).rejects.toThrow(/merchantId/);
  });

  it("rejects a non-UUID proposalId", async () => {
    const { client } = makeMockClient();
    await expect(
      snapshotGroup(client, {
        merchantId: MERCHANT_ID,
        proposalId: "nope",
        groupSlug: "lapsed_vips",
        customerIds: ["gid://a"],
      }),
    ).rejects.toThrow(/proposalId/);
  });

  it("rejects an empty groupSlug", async () => {
    const { client } = makeMockClient();
    await expect(
      snapshotGroup(client, {
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        groupSlug: "",
        customerIds: ["gid://a"],
      }),
    ).rejects.toThrow(/groupSlug/);
  });

  it("rejects an empty-string customerId", async () => {
    const { client } = makeMockClient();
    await expect(
      snapshotGroup(client, {
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        groupSlug: "lapsed_vips",
        customerIds: ["gid://a", ""],
      }),
    ).rejects.toThrow();
  });

  it("rejects a holdoutRate of 0", async () => {
    const { client } = makeMockClient();
    await expect(
      snapshotGroup(client, {
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        groupSlug: "lapsed_vips",
        customerIds: ["gid://a"],
        holdoutRate: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects a holdoutRate above 1", async () => {
    const { client } = makeMockClient();
    await expect(
      snapshotGroup(client, {
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        groupSlug: "lapsed_vips",
        customerIds: ["gid://a"],
        holdoutRate: 1.5,
      }),
    ).rejects.toThrow();
  });

  it("propagates a Postgres write error", async () => {
    const { client } = makeMockClient({ message: "insert failed" });
    await expect(
      snapshotGroup(client, {
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        groupSlug: "lapsed_vips",
        customerIds: ["gid://a"],
      }),
    ).rejects.toThrow(/insert failed/);
  });
});
