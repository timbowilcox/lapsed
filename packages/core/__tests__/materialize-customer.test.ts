/**
 * Unit tests for materializeCustomer.
 *
 * Verifies that the profile row is rebuilt correctly from the event log,
 * including order financials, identity fields (from customer_events payload),
 * last_order_at, last_order_days_ago, profile_version, and error propagation.
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
  customerIdentityEvents?: Array<{ payload: Record<string, unknown>; occurred_at: string }>;
  existingCustomer?: { id: string; profile_version: number } | null;
  orderEventsError?: { message: string };
  identityEventsError?: { message: string };
  existingCustomerError?: { message: string };
  upsertError?: { message: string };
}

function makeMockClient(opts: MockOptions = {}) {
  const {
    orderEvents = [],
    customerIdentityEvents = [],
    existingCustomer = null,
    orderEventsError,
    identityEventsError,
    existingCustomerError,
    upsertError,
  } = opts;

  const upsertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];

  const client = {
    from: vi.fn((table: string) => {
      if (table === "order_events") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue(
            orderEventsError
              ? { data: null, error: orderEventsError }
              : { data: orderEvents, error: null },
          ),
        };
      }
      if (table === "customer_events") {
        const limitFn = vi.fn().mockResolvedValue(
          identityEventsError
            ? { data: null, error: identityEventsError }
            : { data: customerIdentityEvents, error: null },
        );
        const orderFn = vi.fn(() => ({ limit: limitFn }));
        const inFn = vi.fn(() => ({ order: orderFn }));
        return {
          select: vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            in: inFn,
          })),
        };
      }
      if (table === "customers") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue(
            existingCustomerError
              ? { data: null, error: existingCustomerError }
              : { data: existingCustomer, error: null },
          ),
          upsert: vi.fn((row: Record<string, unknown>) => {
            upsertCalls.push({ table, row });
            return {
              select: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue(
                upsertError
                  ? { data: null, error: upsertError }
                  : {
                      data: {
                        id: existingCustomer?.id ?? "new-customer-id",
                        merchant_id: MERCHANT_ID,
                        shopify_customer_gid: CUSTOMER_GID,
                        ...row,
                      },
                      error: null,
                    },
              ),
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
// Tests — financial fields
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

  it("calculates total_order_count and total_ltv_cents from order event log", async () => {
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
    expect(result?.total_ltv_cents).toBe(5000);
  });

  it("computes last_order_days_ago as a non-negative integer", async () => {
    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const { client } = makeMockClient({
      orderEvents: [{ payload: { total_price: "10.00" }, occurred_at: pastDate }],
    });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.last_order_days_ago).toBeGreaterThanOrEqual(9);
    expect(result?.last_order_days_ago).toBeLessThanOrEqual(11);
  });

  // ─── identity fields ───────────────────────────────────────────────────────

  it("reads email and phone from the most-recent customer event payload", async () => {
    const { client } = makeMockClient({
      customerIdentityEvents: [
        {
          payload: { email: "jane@example.com", phone: "+61400000001" },
          occurred_at: "2024-01-01T00:00:00Z",
        },
      ],
    });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.email).toBe("jane@example.com");
    expect(result?.phone).toBe("+61400000001");
  });

  it("parses comma-separated tags string from customer event payload", async () => {
    const { client } = makeMockClient({
      customerIdentityEvents: [
        {
          payload: { tags: " vip ,  loyal , win-back" },
          occurred_at: "2024-01-01T00:00:00Z",
        },
      ],
    });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.tags).toEqual(["vip", "loyal", "win-back"]);
  });

  it("returns empty tags array when no customer identity event exists", async () => {
    const { client } = makeMockClient({ customerIdentityEvents: [] });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.tags).toEqual([]);
    expect(result?.email).toBeNull();
    expect(result?.first_name).toBeNull();
    expect(result?.last_name).toBeNull();
  });

  it("returns empty tags array when tags field is absent from payload", async () => {
    const { client } = makeMockClient({
      customerIdentityEvents: [
        { payload: { email: "a@b.com" }, occurred_at: "2024-01-01T00:00:00Z" },
      ],
    });
    const result = await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(result?.tags).toEqual([]);
  });

  // ─── profile_version ──────────────────────────────────────────────────────

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

  it("passes merchant_id and shopify_customer_gid to the upsert", async () => {
    const { client, upsertCalls } = makeMockClient({ orderEvents: [] });
    await materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID);

    expect(upsertCalls[0]?.row.merchant_id).toBe(MERCHANT_ID);
    expect(upsertCalls[0]?.row.shopify_customer_gid).toBe(CUSTOMER_GID);
  });

  // ─── error propagation ────────────────────────────────────────────────────

  it("throws when order_events query returns a Supabase error", async () => {
    const { client } = makeMockClient({
      orderEventsError: { message: "order_events read failed" },
    });

    await expect(materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID)).rejects.toMatchObject({
      message: "order_events read failed",
    });
  });

  it("throws when customer_events identity query returns a Supabase error", async () => {
    const { client } = makeMockClient({
      identityEventsError: { message: "customer_events read failed" },
    });

    await expect(materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID)).rejects.toMatchObject({
      message: "customer_events read failed",
    });
  });

  it("throws when customers profile_version read returns a Supabase error", async () => {
    const { client } = makeMockClient({
      existingCustomerError: { message: "customers read failed" },
    });

    await expect(materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID)).rejects.toMatchObject({
      message: "customers read failed",
    });
  });

  it("throws when customers upsert returns a Supabase error", async () => {
    const { client } = makeMockClient({
      upsertError: { message: "customers upsert failed" },
    });

    await expect(materializeCustomer(client, MERCHANT_ID, CUSTOMER_GID)).rejects.toMatchObject({
      message: "customers upsert failed",
    });
  });
});
