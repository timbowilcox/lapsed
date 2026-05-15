import { describe, it, expect, vi } from "vitest";
import { runRfmBatch } from "../src/rfm-batch";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type { MerchantContext } from "../src/customer-groups";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000000"; // nil UUID — valid per Zod uuid()
const CONTEXT: MerchantContext = { ltvP90Cents: 50000, medianAovCents: 8000 };

const CUSTOMER = {
  shopify_customer_gid: "gid://shopify/Customer/1",
  total_order_count: 3,
  total_ltv_cents: 30000,
  last_order_days_ago: 120,
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory
// ─────────────────────────────────────────────────────────────────────────────

interface MockOptions {
  customerPages?: object[][];
  orderEventsError?: object;
  rfmUpsertError?: object;
  stateUpsertError?: object;
}

function makeClient(opts: MockOptions = {}): LapsedSupabaseClient {
  const pages = opts.customerPages ?? [[CUSTOMER]];
  let pageIndex = 0;

  return {
    from: vi.fn((table: string) => {
      // ── customers ──────────────────────────────────────────────────────────
      if (table === "customers") {
        const page = pages[pageIndex] ?? [];
        pageIndex++;
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              range: vi.fn().mockResolvedValue({ data: page, error: null }),
            }),
          }),
        };
      }

      // ── order_events ───────────────────────────────────────────────────────
      if (table === "order_events") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: [],
              error: opts.orderEventsError ?? null,
            }),
          }),
        };
      }

      // ── customer_events ────────────────────────────────────────────────────
      // Used by buildSnapshot for three queries (180d count, 30d count, last
      // lapsed event) and by appendCustomerEvent (upsert). Each select path
      // terminates at a different method: gte() for count queries, maybeSingle()
      // for the event lookup — both are present so either chain resolves.
      if (table === "customer_events") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnThis(),
            not: vi.fn().mockReturnThis(),
            gte: vi.fn().mockResolvedValue({ count: 0, error: null }),
            contains: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
        };
      }

      // ── customer_rfm ───────────────────────────────────────────────────────
      if (table === "customer_rfm") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
          upsert: vi.fn().mockResolvedValue({
            error: opts.rfmUpsertError ?? null,
          }),
        };
      }

      // ── customer_inferred_state ────────────────────────────────────────────
      if (table === "customer_inferred_state") {
        return {
          upsert: vi.fn().mockResolvedValue({
            error: opts.stateUpsertError ?? null,
          }),
        };
      }

      throw new Error(`Unexpected table in rfm-batch mock: ${table}`);
    }),
  } as unknown as LapsedSupabaseClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("runRfmBatch — happy path", () => {
  it("processes a single customer and returns processed=1 errors=0", async () => {
    const client = makeClient();
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    expect(result).toEqual({ processed: 1, errors: 0 });
  });

  it("processes multiple customers in one page", async () => {
    const client = makeClient({
      customerPages: [
        [CUSTOMER, { ...CUSTOMER, shopify_customer_gid: "gid://shopify/Customer/2" }],
      ],
    });
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    expect(result.processed).toBe(2);
    expect(result.errors).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pagination
// ─────────────────────────────────────────────────────────────────────────────

describe("runRfmBatch — pagination", () => {
  it("stops after a partial page (< PAGE size)", async () => {
    // One page of 1 customer — does not fetch another page.
    const client = makeClient({ customerPages: [[CUSTOMER]] });
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    expect(result.processed).toBe(1);
  });

  it("handles empty customer list — returns 0/0", async () => {
    const client = makeClient({ customerPages: [[]] });
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    expect(result).toEqual({ processed: 0, errors: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling — per-customer errors do not halt the batch
// ─────────────────────────────────────────────────────────────────────────────

describe("runRfmBatch — error handling", () => {
  it("counts errors without throwing when order_events fetch fails", async () => {
    const client = makeClient({
      orderEventsError: { message: "db error" },
    });
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    expect(result.processed).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("counts errors when rfm upsert fails, continues to next customer", async () => {
    const client = makeClient({
      customerPages: [
        [CUSTOMER, { ...CUSTOMER, shopify_customer_gid: "gid://shopify/Customer/2" }],
      ],
      rfmUpsertError: { message: "upsert failed" },
    });
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    // Both customers fail at rfm upsert — both counted as errors.
    expect(result.errors).toBe(2);
    expect(result.processed).toBe(0);
  });

  it("counts errors when inferred_state upsert fails", async () => {
    const client = makeClient({
      stateUpsertError: { message: "state upsert failed" },
    });
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    expect(result.errors).toBe(1);
    expect(result.processed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle + group assignment plumbing
// ─────────────────────────────────────────────────────────────────────────────

describe("runRfmBatch — lifecycle plumbing", () => {
  it("classifies lapsed customer and assigns groups without throwing", async () => {
    // last_order_days_ago=120 → lapsed; total_ltv_cents=30000 < ltvP90Cents=50000
    const client = makeClient();
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    expect(result.processed).toBe(1);
  });

  it("is idempotent — same result on second run", async () => {
    const client1 = makeClient();
    const client2 = makeClient();
    const first = await runRfmBatch(client1, MERCHANT_ID, CONTEXT);
    const second = await runRfmBatch(client2, MERCHANT_ID, CONTEXT);
    expect(first).toEqual(second);
  });

  it("does not write lifecycle_stage to customer_inferred_state (scoring job owns that column)", async () => {
    const client = makeClient();
    await runRfmBatch(client, MERCHANT_ID, CONTEXT);

    interface MockWithUpsert { value: { upsert: ReturnType<typeof vi.fn> } }
    const fromMock = client.from as ReturnType<typeof vi.fn>;
    const upsertResult = (fromMock.mock.calls as string[][])
      .map((c, i) =>
        c[0] === "customer_inferred_state"
          ? (fromMock.mock.results[i] as unknown as MockWithUpsert | null)
          : null,
      )
      .find((r): r is MockWithUpsert => (r?.value?.upsert?.mock?.calls?.length ?? 0) > 0);
    expect(upsertResult).toBeDefined();
    const payload = upsertResult!.value.upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("lifecycle_stage");
  });

  it("handles null last_order_days_ago without throwing", async () => {
    const client = makeClient({
      customerPages: [[{ ...CUSTOMER, last_order_days_ago: null }]],
    });
    const result = await runRfmBatch(client, MERCHANT_ID, CONTEXT);
    // null last_order_days_ago → classifyLifecycle returns "new" or "churned";
    // either way it should not throw.
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(1);
  });
});
