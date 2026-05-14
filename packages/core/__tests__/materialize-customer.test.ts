/**
 * Unit tests for materializeCustomer.
 *
 * Verifies that the profile row is rebuilt correctly from the order event log,
 * including order count, LTV, last_order_at, last_order_days_ago, and
 * profile_version increment.
 */

import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { materializeCustomer } from "../src/materialize-customer";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440001";
const CUSTOMER_GID = "gid://shopify/Customer/123456";

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory
// ─────────────────────────────────────────────────────────────────────────────

interface MockOptions {
  orderEvents?: Array<{ payload: Record<string, unknown>; occurred_at: string }>;
  existingCustomer?: { id: string; profile_version: number } | null;
}

function makeMockClient(opts: MockOptions = {}) {
  const { orderEvents = [], existingCustomer = null } = opts;

  const upsertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];

  const client = {
    from: vi.fn((table: string) => {
      if (table === "order_events") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue({ data: orderEvents, error: null }),
        };
      }
      if (table === "customers") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: existingCustomer, error: null }),
          upsert: vi.fn((row: Record<string, unknown>) => {
            upsertCalls.push({ table, row });
            return {
              select: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: existingCustomer?.id ?? "new-customer-id",
                  merchant_id: MERCHANT_ID,
                  shopify_customer_gid: CUSTOMER_GID,
                  total_order_count: row.total_order_count,
                  total_ltv_cents: row.total_ltv_cents,
                  last_order_at: row.last_order_at,
                  last_order_days_ago: row.last_order_days_ago,
                  profile_version: row.profile_version,
                },
                error: null,
              }),
            };
          }),
        };
      }
      return {};
    }),
  } as unknown as LapsedSupabaseClient;

  return { client, upsertCalls };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("materializeCustomer", () => {
  it("returns zero counts and null last_order_at when no order events exist", async () => {
    const { client } = makeMockClient({ orderEvents: [] });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.total_order_count).toBe(0);
    expect(result?.total_ltv_cents).toBe(0);
    expect(result?.last_order_at).toBeNull();
    expect(result?.last_order_days_ago).toBeNull();
  });

  it("calculates total_order_count and total_ltv_cents from event log", async () => {
    const { client } = makeMockClient({
      orderEvents: [
        { payload: { total_price: "100.00" }, occurred_at: "2024-01-01T00:00:00Z" },
        { payload: { total_price: "50.50" }, occurred_at: "2024-02-01T00:00:00Z" },
        { payload: { total_price: "25.99" }, occurred_at: "2024-03-01T00:00:00Z" },
      ],
    });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.total_order_count).toBe(3);
    expect(result?.total_ltv_cents).toBe(17649); // 10000 + 5050 + 2599
  });

  it("sets last_order_at to the most recent event occurred_at", async () => {
    const { client } = makeMockClient({
      orderEvents: [
        { payload: { total_price: "10.00" }, occurred_at: "2024-01-01T00:00:00Z" },
        { payload: { total_price: "20.00" }, occurred_at: "2024-06-15T00:00:00Z" },
        { payload: { total_price: "15.00" }, occurred_at: "2024-03-01T00:00:00Z" },
      ],
    });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.last_order_at).toBe("2024-06-15T00:00:00Z");
  });

  it("treats missing total_price as 0 cents (no NaN in LTV)", async () => {
    const { client } = makeMockClient({
      orderEvents: [
        { payload: {}, occurred_at: "2024-01-01T00:00:00Z" },
        { payload: { total_price: "50.00" }, occurred_at: "2024-02-01T00:00:00Z" },
      ],
    });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.total_order_count).toBe(2);
    expect(result?.total_ltv_cents).toBe(5000); // 0 + 5000
  });

  it("increments profile_version from existing row", async () => {
    const { client, upsertCalls } = makeMockClient({
      orderEvents: [],
      existingCustomer: { id: "existing-id", profile_version: 5 },
    });
    await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(upsertCalls[0]?.row.profile_version).toBe(6);
  });

  it("sets profile_version to 1 when no existing row", async () => {
    const { client, upsertCalls } = makeMockClient({
      orderEvents: [],
      existingCustomer: null,
    });
    await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(upsertCalls[0]?.row.profile_version).toBe(1);
  });

  it("computes last_order_days_ago as a non-negative integer", async () => {
    // Use a date in the past
    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const { client } = makeMockClient({
      orderEvents: [{ payload: { total_price: "10.00" }, occurred_at: pastDate }],
    });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.last_order_days_ago).toBeGreaterThanOrEqual(9);
    expect(result?.last_order_days_ago).toBeLessThanOrEqual(11);
  });

  it("passes merchant_id and shopify_customer_gid to the upsert", async () => {
    const { client, upsertCalls } = makeMockClient({ orderEvents: [] });
    await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(upsertCalls[0]?.row.merchant_id).toBe(MERCHANT_ID);
    expect(upsertCalls[0]?.row.shopify_customer_gid).toBe(CUSTOMER_GID);
  });
});
