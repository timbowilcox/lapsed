/**
 * Unit tests for DB query helpers (getLapsedCustomers, getCustomer, getMerchantSummary).
 *
 * Uses mocked Supabase clients — no network or real DB involved.
 */

import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "../src/index";
import { getLapsedCustomers, getCustomer, getMerchantSummary } from "../src/queries";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440001";

// ─────────────────────────────────────────────────────────────────────────────
// getLapsedCustomers
// ─────────────────────────────────────────────────────────────────────────────

function makeLapsedCustomersClient(
  rows: Record<string, unknown>[],
  error?: { message: string } | null,
) {
  const rangeResolvedValue = error ? { data: null, error, count: null } : { data: rows, error: null, count: rows.length };

  const chain = {
    select: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockResolvedValue(rangeResolvedValue),
  };

  return {
    from: vi.fn(() => chain),
  } as unknown as LapsedSupabaseClient;
}

describe("getLapsedCustomers", () => {
  const mockRows = [
    { id: "a", shopify_customer_gid: "gid://shopify/Customer/1", lapsed_at: "2024-01-01T00:00:00Z" },
    { id: "b", shopify_customer_gid: "gid://shopify/Customer/2", lapsed_at: "2024-02-01T00:00:00Z" },
  ];

  it("returns data and null nextCursor when fewer rows than limit", async () => {
    const client = makeLapsedCustomersClient(mockRows);
    const result = await getLapsedCustomers(client, { limit: 10 });

    expect(result.data).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it("returns nextCursor = offset + limit when exactly limit rows returned", async () => {
    const client = makeLapsedCustomersClient(mockRows);
    const result = await getLapsedCustomers(client, { limit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.nextCursor).toBe(2);
  });

  it("returns null nextCursor on empty result set", async () => {
    const client = makeLapsedCustomersClient([]);
    const result = await getLapsedCustomers(client, { limit: 10 });

    expect(result.data).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("uses cursor=0 by default (first page)", async () => {
    const rangeCall = vi.fn().mockResolvedValue({ data: [], error: null });
    const chain = {
      select: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: rangeCall,
    };
    const client = { from: vi.fn(() => chain) } as unknown as LapsedSupabaseClient;

    await getLapsedCustomers(client, { limit: 20 });

    expect(rangeCall).toHaveBeenCalledWith(0, 19);
  });

  it("passes cursor offset to range correctly", async () => {
    const rangeCall = vi.fn().mockResolvedValue({ data: [], error: null });
    const chain = {
      select: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      range: rangeCall,
    };
    const client = { from: vi.fn(() => chain) } as unknown as LapsedSupabaseClient;

    await getLapsedCustomers(client, { limit: 20, cursor: 40 });

    expect(rangeCall).toHaveBeenCalledWith(40, 59);
  });

  it("throws when Supabase returns an error", async () => {
    const client = makeLapsedCustomersClient([], { message: "query failed" });

    await expect(getLapsedCustomers(client, { limit: 10 })).rejects.toMatchObject({
      message: "query failed",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCustomer
// ─────────────────────────────────────────────────────────────────────────────

function makeGetCustomerClient(
  row: Record<string, unknown> | null,
  error?: { message: string } | null,
) {
  const maybeSingleResolvedValue = error
    ? { data: null, error }
    : { data: row, error: null };

  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(maybeSingleResolvedValue),
    })),
  } as unknown as LapsedSupabaseClient;
}

describe("getCustomer", () => {
  it("returns the customer row when found", async () => {
    const mockRow = { id: "cust-1", shopify_customer_gid: "gid://shopify/Customer/1", merchant_id: MERCHANT_ID };
    const client = makeGetCustomerClient(mockRow);

    const result = await getCustomer(client, MERCHANT_ID, "gid://shopify/Customer/1");

    expect(result).toEqual(mockRow);
  });

  it("returns null when customer is not found", async () => {
    const client = makeGetCustomerClient(null);

    const result = await getCustomer(client, MERCHANT_ID, "gid://shopify/Customer/9999");

    expect(result).toBeNull();
  });

  it("filters by both merchant_id and shopify_customer_gid", async () => {
    const eqCall = vi.fn().mockReturnThis();
    const client = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: eqCall,
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    } as unknown as LapsedSupabaseClient;

    await getCustomer(client, MERCHANT_ID, "gid://shopify/Customer/42");

    const calls = eqCall.mock.calls;
    expect(calls.some((c) => c[0] === "merchant_id" && c[1] === MERCHANT_ID)).toBe(true);
    expect(calls.some((c) => c[0] === "shopify_customer_gid" && c[1] === "gid://shopify/Customer/42")).toBe(true);
  });

  it("throws when Supabase returns an error", async () => {
    const client = makeGetCustomerClient(null, { message: "DB error" });

    await expect(getCustomer(client, MERCHANT_ID, "gid://shopify/Customer/1")).rejects.toMatchObject({
      message: "DB error",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMerchantSummary
// ─────────────────────────────────────────────────────────────────────────────

interface MakeSummaryClientOpts {
  count?: number | null;
  countError?: { message: string } | null;
  merchant?: { last_backfill_at: string | null; updated_at: string } | null;
  merchantError?: { message: string } | null;
}

function makeMerchantSummaryClient(opts: MakeSummaryClientOpts = {}) {
  const { count = 0, countError = null, merchant = null, merchantError = null } = opts;

  return {
    from: vi.fn((table: string) => {
      if (table === "customers") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          not: vi.fn().mockResolvedValue(
            countError ? { data: null, error: countError, count: null } : { data: null, error: null, count },
          ),
        };
      }
      if (table === "merchants") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue(
            merchantError ? { data: null, error: merchantError } : { data: merchant, error: null },
          ),
        };
      }
      return {};
    }),
  } as unknown as LapsedSupabaseClient;
}

describe("getMerchantSummary", () => {
  it("returns total_lapsed_count from count query", async () => {
    const client = makeMerchantSummaryClient({ count: 42 });
    const result = await getMerchantSummary(client, MERCHANT_ID);

    expect(result.total_lapsed_count).toBe(42);
  });

  it("defaults total_lapsed_count to 0 when count is null", async () => {
    const client = makeMerchantSummaryClient({ count: null });
    const result = await getMerchantSummary(client, MERCHANT_ID);

    expect(result.total_lapsed_count).toBe(0);
  });

  it("returns last_backfill_at as last_synced_at when available", async () => {
    const client = makeMerchantSummaryClient({
      merchant: { last_backfill_at: "2024-06-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
    });
    const result = await getMerchantSummary(client, MERCHANT_ID);

    expect(result.last_synced_at).toBe("2024-06-01T00:00:00Z");
  });

  it("returns null last_synced_at when last_backfill_at is null (updated_at is not a sync signal)", async () => {
    const client = makeMerchantSummaryClient({
      merchant: { last_backfill_at: null, updated_at: "2024-01-15T00:00:00Z" },
    });
    const result = await getMerchantSummary(client, MERCHANT_ID);

    expect(result.last_synced_at).toBeNull();
  });

  it("returns null last_synced_at when merchant row is not found", async () => {
    const client = makeMerchantSummaryClient({ merchant: null });
    const result = await getMerchantSummary(client, MERCHANT_ID);

    expect(result.last_synced_at).toBeNull();
  });

  it("throws when customers count query returns an error", async () => {
    const client = makeMerchantSummaryClient({ countError: { message: "count failed" } });

    await expect(getMerchantSummary(client, MERCHANT_ID)).rejects.toMatchObject({
      message: "count failed",
    });
  });

  it("throws when merchants query returns an error", async () => {
    const client = makeMerchantSummaryClient({ merchantError: { message: "merchant fetch failed" } });

    await expect(getMerchantSummary(client, MERCHANT_ID)).rejects.toMatchObject({
      message: "merchant fetch failed",
    });
  });
});
