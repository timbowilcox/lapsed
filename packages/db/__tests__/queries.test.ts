/**
 * Unit tests for DB query helpers (getLapsedCustomers, getCustomer, getMerchantSummary).
 *
 * Uses mocked Supabase clients — no network or real DB involved.
 */

import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "../src/index";
import {
  getLapsedCustomers,
  getLapsedCustomersWithSignals,
  getCustomer,
  getCustomerInferredState,
  getReadyToReactivateCount,
  getLatestScoringRun,
  getMerchantSummary,
  getExtractionStatus,
} from "../src/queries";

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

// ─────────────────────────────────────────────────────────────────────────────
// getCustomerInferredState
// ─────────────────────────────────────────────────────────────────────────────

function makeInferredStateClient(
  row: Record<string, unknown> | null,
  error?: { message: string } | null,
) {
  const maybeSingleResolvedValue = error ? { data: null, error } : { data: row, error: null };
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(maybeSingleResolvedValue),
    })),
  } as unknown as LapsedSupabaseClient;
}

describe("getCustomerInferredState", () => {
  const mockState = {
    id: "state-1",
    merchant_id: MERCHANT_ID,
    shopify_customer_gid: "gid://shopify/Customer/1",
    propensity_30d: "0.8500",
    propensity_90d: "0.7200",
    lifecycle_stage: "lapsed",
    group_memberships: ["lapsed_vips"],
  };

  it("returns the inferred state row when found", async () => {
    const client = makeInferredStateClient(mockState);
    const result = await getCustomerInferredState(client, MERCHANT_ID, "gid://shopify/Customer/1");
    expect(result).toEqual(mockState);
  });

  it("returns null when no inferred state exists", async () => {
    const client = makeInferredStateClient(null);
    const result = await getCustomerInferredState(client, MERCHANT_ID, "gid://shopify/Customer/99");
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

    await getCustomerInferredState(client, MERCHANT_ID, "gid://shopify/Customer/42");

    const calls = eqCall.mock.calls;
    expect(calls.some((c) => c[0] === "merchant_id" && c[1] === MERCHANT_ID)).toBe(true);
    expect(calls.some((c) => c[0] === "shopify_customer_gid" && c[1] === "gid://shopify/Customer/42")).toBe(true);
  });

  it("throws when Supabase returns an error", async () => {
    const client = makeInferredStateClient(null, { message: "state fetch failed" });
    await expect(
      getCustomerInferredState(client, MERCHANT_ID, "gid://shopify/Customer/1"),
    ).rejects.toMatchObject({ message: "state fetch failed" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getReadyToReactivateCount
// ─────────────────────────────────────────────────────────────────────────────

function makeReadyToReactivateClient(count: number | null, error?: { message: string } | null) {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gte: vi.fn().mockResolvedValue(
        error ? { count: null, error } : { count, error: null },
      ),
    })),
  } as unknown as LapsedSupabaseClient;
}

describe("getReadyToReactivateCount", () => {
  it("returns the count of customers above the threshold", async () => {
    const client = makeReadyToReactivateClient(17);
    const result = await getReadyToReactivateCount(client, MERCHANT_ID, 0.5);
    expect(result).toBe(17);
  });

  it("returns 0 when count is null", async () => {
    const client = makeReadyToReactivateClient(null);
    const result = await getReadyToReactivateCount(client, MERCHANT_ID, 0.5);
    expect(result).toBe(0);
  });

  it("passes the threshold to gte filter", async () => {
    const gteCall = vi.fn().mockResolvedValue({ count: 0, error: null });
    const client = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        gte: gteCall,
      })),
    } as unknown as LapsedSupabaseClient;

    await getReadyToReactivateCount(client, MERCHANT_ID, 0.7);
    expect(gteCall).toHaveBeenCalledWith("propensity_30d", 0.7);
  });

  it("throws when Supabase returns an error", async () => {
    const client = makeReadyToReactivateClient(null, { message: "count error" });
    await expect(
      getReadyToReactivateCount(client, MERCHANT_ID, 0.5),
    ).rejects.toMatchObject({ message: "count error" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getLatestScoringRun
// ─────────────────────────────────────────────────────────────────────────────

function makeLatestScoringRunClient(
  row: Record<string, unknown> | null,
  error?: { message: string } | null,
) {
  const maybeSingleResolvedValue = error ? { data: null, error } : { data: row, error: null };
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue(maybeSingleResolvedValue),
    })),
  } as unknown as LapsedSupabaseClient;
}

describe("getLatestScoringRun", () => {
  const mockRun = {
    id: "run-1",
    merchant_id: MERCHANT_ID,
    started_at: "2024-06-01T02:00:00Z",
    finished_at: "2024-06-01T02:05:00Z",
    model_version: "claude-haiku-4-5-20251001",
    customers_scored: 150,
    tokens_input: 45000,
    tokens_output: 15000,
    cost_cents: 12,
    status: "succeeded",
    error_message: null,
    created_at: "2024-06-01T02:00:00Z",
  };

  it("returns the latest scoring run row when found", async () => {
    const client = makeLatestScoringRunClient(mockRun);
    const result = await getLatestScoringRun(client, MERCHANT_ID);
    expect(result).toEqual(mockRun);
  });

  it("returns null when no scoring run exists", async () => {
    const client = makeLatestScoringRunClient(null);
    const result = await getLatestScoringRun(client, MERCHANT_ID);
    expect(result).toBeNull();
  });

  it("queries only succeeded and failed statuses (not running)", async () => {
    const inCall = vi.fn().mockReturnThis();
    const client = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: inCall,
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    } as unknown as LapsedSupabaseClient;

    await getLatestScoringRun(client, MERCHANT_ID);
    expect(inCall).toHaveBeenCalledWith("status", ["succeeded", "failed"]);
  });

  it("throws when Supabase returns an error", async () => {
    const client = makeLatestScoringRunClient(null, { message: "scoring run fetch failed" });
    await expect(
      getLatestScoringRun(client, MERCHANT_ID),
    ).rejects.toMatchObject({ message: "scoring run fetch failed" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getLapsedCustomersWithSignals
// ─────────────────────────────────────────────────────────────────────────────

function makeWithSignalsClient(opts: {
  stateRows?: Record<string, unknown>[];
  stateCount?: number | null;
  stateError?: { message: string } | null;
  customerRows?: Record<string, unknown>[];
  customerCount?: number | null;
  customerError?: { message: string } | null;
}) {
  const {
    stateRows = [],
    stateCount = null,
    stateError = null,
    customerRows = [],
    customerCount = null,
    customerError = null,
  } = opts;

  return {
    from: vi.fn((table: string) => {
      if (table === "customer_inferred_state") {
        // Handles:
        //   propensity path:  select().order().range()
        //   group-filter:     select().overlaps().order().range()
        //   ltv/date hydrate: select().eq().in()  → resolves
        const stateRangeValue = stateError
          ? { data: null, error: stateError, count: null }
          : { data: stateRows, error: null, count: stateCount };
        const stateInValue = stateError
          ? { data: null, error: stateError }
          : { data: stateRows, error: null };
        return {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          overlaps: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: vi.fn().mockResolvedValue(stateInValue),
          range: vi.fn().mockResolvedValue(stateRangeValue),
        };
      }

      // customers table handles two distinct call chains:
      //   direct:    select().not().order().range()               → custRangeValue
      //   hydration: select().eq("merchant_id").in().not()        → custHydrateValue
      const custRangeValue = customerError
        ? { data: null, error: customerError, count: null }
        : { data: customerRows, error: null, count: customerCount };
      const custHydrateValue = customerError
        ? { data: null, error: customerError }
        : { data: customerRows, error: null };

      return {
        select: vi.fn().mockReturnThis(),
        not: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockResolvedValue(custRangeValue),
        // eq("merchant_id", ...) returns chain for hydration path
        eq: vi.fn().mockReturnValue({
          in: vi.fn().mockReturnValue({
            not: vi.fn().mockResolvedValue(custHydrateValue),
          }),
        }),
      };
    }),
  } as unknown as LapsedSupabaseClient;
}

const mockCustomerA = {
  id: "c1",
  shopify_customer_gid: "gid://shopify/Customer/1",
  merchant_id: MERCHANT_ID,
  lapsed_at: "2024-01-01T00:00:00Z",
  lapsed_score: 80,
};

const mockStateA = {
  id: "s1",
  shopify_customer_gid: "gid://shopify/Customer/1",
  merchant_id: MERCHANT_ID,
  propensity_90d: "0.7500",
  lifecycle_stage: "lapsed",
  group_memberships: ["lapsed_vips"],
};

describe("getLapsedCustomersWithSignals", () => {
  it("returns merged customer + inferred_state rows for propensity_90d sort", async () => {
    const client = makeWithSignalsClient({
      stateRows: [mockStateA],
      stateCount: 1,
      customerRows: [mockCustomerA],
    });

    const result = await getLapsedCustomersWithSignals(client, { merchantId: MERCHANT_ID, limit: 10 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.inferred_state).toEqual(mockStateA);
    expect(result.data[0]?.id).toBe("c1");
  });

  it("falls back to lapsed_score order when no inferred state rows exist", async () => {
    const client = makeWithSignalsClient({
      stateRows: [],
      stateCount: 0,
      customerRows: [mockCustomerA],
      customerCount: 1,
    });

    const result = await getLapsedCustomersWithSignals(client, { merchantId: MERCHANT_ID, limit: 10 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.inferred_state).toBeNull();
  });

  it("returns empty data and null nextCursor when no customers exist", async () => {
    const client = makeWithSignalsClient({ stateRows: [], stateCount: 0, customerRows: [] });
    const result = await getLapsedCustomersWithSignals(client, { merchantId: MERCHANT_ID, limit: 10 });
    expect(result.data).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("returns nextCursor when exactly limit rows returned (propensity_90d path)", async () => {
    const client = makeWithSignalsClient({
      stateRows: [mockStateA],
      stateCount: 1,
      customerRows: [mockCustomerA],
    });

    const result = await getLapsedCustomersWithSignals(client, { merchantId: MERCHANT_ID, limit: 1 });
    expect(result.nextCursor).toBe(1);
  });

  it("returns null nextCursor when fewer than limit rows returned", async () => {
    const client = makeWithSignalsClient({
      stateRows: [mockStateA],
      stateCount: 1,
      customerRows: [mockCustomerA],
    });

    const result = await getLapsedCustomersWithSignals(client, { merchantId: MERCHANT_ID, limit: 10 });
    expect(result.nextCursor).toBeNull();
  });

  it("exposes totalCount from the scored population", async () => {
    const client = makeWithSignalsClient({
      stateRows: [mockStateA],
      stateCount: 42,
      customerRows: [mockCustomerA],
    });

    const result = await getLapsedCustomersWithSignals(client, { merchantId: MERCHANT_ID, limit: 10 });
    expect(result.totalCount).toBe(42);
  });

  it("throws when the inferred_state query errors", async () => {
    const client = makeWithSignalsClient({ stateError: { message: "state query failed" } });
    await expect(
      getLapsedCustomersWithSignals(client, { merchantId: MERCHANT_ID, limit: 10 }),
    ).rejects.toMatchObject({ message: "state query failed" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getExtractionStatus
// ─────────────────────────────────────────────────────────────────────────────

const VOICE_VERSION_ID = "99999999-9999-4999-8999-999999999999";

/** Builds a client whose voice_events query resolves to `events` (newest-first). */
function makeExtractionStatusClient(
  events: Record<string, unknown>[] | null,
  error?: { message: string } | null,
) {
  const eqCall = vi.fn().mockReturnThis();
  const limitCall = vi
    .fn()
    .mockResolvedValue(error ? { data: null, error } : { data: events, error: null });
  const client = {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: eqCall,
      order: vi.fn().mockReturnThis(),
      limit: limitCall,
    })),
  } as unknown as LapsedSupabaseClient;
  return { client, eqCall, limitCall };
}

describe("getExtractionStatus", () => {
  it("returns analyzing with null fields when no voice events exist", async () => {
    const { client } = makeExtractionStatusClient([]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result).toEqual({
      phase: "analyzing",
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      voiceVersionId: null,
    });
  });

  it("derives analyzing from a lone extraction_started event", async () => {
    const { client } = makeExtractionStatusClient([
      { event_type: "extraction_started", occurred_at: "2026-05-16T10:00:00.000Z", payload: {} },
    ]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result.phase).toBe("analyzing");
    expect(result.startedAt).toBe("2026-05-16T10:00:00.000Z");
    expect(result.completedAt).toBeNull();
    expect(result.voiceVersionId).toBeNull();
  });

  it("derives extracting from a storefront_fetched latest event", async () => {
    const { client } = makeExtractionStatusClient([
      { event_type: "storefront_fetched", occurred_at: "2026-05-16T10:00:05.000Z", payload: {} },
      { event_type: "extraction_started", occurred_at: "2026-05-16T10:00:00.000Z", payload: {} },
    ]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result.phase).toBe("extracting");
    expect(result.startedAt).toBe("2026-05-16T10:00:00.000Z");
  });

  it("derives extracting from a pii_redacted latest event", async () => {
    const { client } = makeExtractionStatusClient([
      { event_type: "pii_redacted", occurred_at: "2026-05-16T10:00:06.000Z", payload: {} },
      { event_type: "storefront_fetched", occurred_at: "2026-05-16T10:00:05.000Z", payload: {} },
      { event_type: "extraction_started", occurred_at: "2026-05-16T10:00:00.000Z", payload: {} },
    ]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result.phase).toBe("extracting");
  });

  it("derives generating from a voice_extracted latest event and exposes the version id", async () => {
    const { client } = makeExtractionStatusClient([
      {
        event_type: "voice_extracted",
        occurred_at: "2026-05-16T10:00:10.000Z",
        payload: { version_id: VOICE_VERSION_ID },
      },
      { event_type: "extraction_started", occurred_at: "2026-05-16T10:00:00.000Z", payload: {} },
    ]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result.phase).toBe("generating");
    expect(result.voiceVersionId).toBe(VOICE_VERSION_ID);
    expect(result.completedAt).toBeNull();
  });

  it("derives ready from voice_activated, with completedAt from its occurred_at", async () => {
    const { client } = makeExtractionStatusClient([
      {
        event_type: "voice_activated",
        occurred_at: "2026-05-16T10:00:11.000Z",
        payload: { version_id: VOICE_VERSION_ID, previous_version_id: null },
      },
      {
        event_type: "voice_extracted",
        occurred_at: "2026-05-16T10:00:10.000Z",
        payload: { version_id: VOICE_VERSION_ID },
      },
      { event_type: "extraction_started", occurred_at: "2026-05-16T10:00:00.000Z", payload: {} },
    ]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result.phase).toBe("ready");
    expect(result.completedAt).toBe("2026-05-16T10:00:11.000Z");
    expect(result.voiceVersionId).toBe(VOICE_VERSION_ID);
    expect(result.errorMessage).toBeNull();
  });

  it("derives ready from a voice_edited latest event (Settings edit)", async () => {
    const { client } = makeExtractionStatusClient([
      {
        event_type: "voice_edited",
        occurred_at: "2026-05-16T12:00:00.000Z",
        payload: { version_id: VOICE_VERSION_ID, previous_version_id: VOICE_VERSION_ID, fields_changed: ["register"] },
      },
      { event_type: "extraction_started", occurred_at: "2026-05-16T10:00:00.000Z", payload: {} },
    ]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result.phase).toBe("ready");
    expect(result.voiceVersionId).toBe(VOICE_VERSION_ID);
  });

  it("derives failed from extraction_failed, surfacing the reason as errorMessage", async () => {
    const { client } = makeExtractionStatusClient([
      {
        event_type: "extraction_failed",
        occurred_at: "2026-05-16T10:00:08.000Z",
        payload: { phase: "synthesize", reason: "exhausted_retries" },
      },
      { event_type: "extraction_started", occurred_at: "2026-05-16T10:00:00.000Z", payload: {} },
    ]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result.phase).toBe("failed");
    expect(result.errorMessage).toBe("exhausted_retries");
    expect(result.completedAt).toBe("2026-05-16T10:00:08.000Z");
  });

  it("scopes to the current run — a re-extraction in progress shows no stale version id", async () => {
    // Run 1 completed (started → activated); run 2 just started. Newest-first.
    const { client } = makeExtractionStatusClient([
      { event_type: "extraction_started", occurred_at: "2026-05-16T14:00:00.000Z", payload: {} },
      {
        event_type: "voice_activated",
        occurred_at: "2026-05-16T10:00:11.000Z",
        payload: { version_id: VOICE_VERSION_ID, previous_version_id: null },
      },
      {
        event_type: "voice_extracted",
        occurred_at: "2026-05-16T10:00:10.000Z",
        payload: { version_id: VOICE_VERSION_ID },
      },
      { event_type: "extraction_started", occurred_at: "2026-05-16T10:00:00.000Z", payload: {} },
    ]);
    const result = await getExtractionStatus(client, MERCHANT_ID);
    expect(result.phase).toBe("analyzing");
    // startedAt is run 2's extraction_started, not run 1's.
    expect(result.startedAt).toBe("2026-05-16T14:00:00.000Z");
    // No version id from the prior run leaks into the in-progress run.
    expect(result.voiceVersionId).toBeNull();
  });

  it("filters the query by merchant_id", async () => {
    const { client, eqCall } = makeExtractionStatusClient([]);
    await getExtractionStatus(client, MERCHANT_ID);
    expect(eqCall).toHaveBeenCalledWith("merchant_id", MERCHANT_ID);
  });

  it("throws when Supabase returns an error", async () => {
    const { client } = makeExtractionStatusClient(null, { message: "voice_events query failed" });
    await expect(getExtractionStatus(client, MERCHANT_ID)).rejects.toMatchObject({
      message: "voice_events query failed",
    });
  });
});
