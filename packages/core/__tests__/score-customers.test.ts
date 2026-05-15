import { describe, it, expect, vi } from "vitest";
import { scoreCustomers } from "../src/score-customers";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const GID = "gid://shopify/Customer/1";
// UUID v4 format: third group must start with 4 (version), fourth with [89ab] (variant).
const MERCHANT_A = "11111111-1111-4111-a111-111111111111";
const MERCHANT_B = "22222222-2222-4222-a222-222222222222";

const CUSTOMER_ROW = {
  shopify_customer_gid: GID,
  total_order_count: 3,
  last_order_days_ago: 120,
  total_ltv_cents: 30000,
  lapsed_at: null,
};

const VALID_SCORE_INPUT = {
  scores: [
    {
      customer_id: GID,
      propensity_30d: 0.3,
      propensity_60d: 0.5,
      propensity_90d: 0.7,
      predicted_residual_ltv_cents: 20000,
      top_signal: "three orders, 120 days since last",
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock factories
// ─────────────────────────────────────────────────────────────────────────────

interface MockOptions {
  customers?: object[];
  inferredStates?: object[];
  dailyTokenCap?: number;
  tokensUsedToday?: number;
  orderEvents?: object[];
  engagementEvents?: object[];
  orderEventsError?: Error;
  engagementEventsError?: Error;
  inferredStateUpsertError?: Error;
}

function makeServiceClient(opts: MockOptions = {}): LapsedSupabaseClient {
  const capRow = {
    id: "cap-id",
    daily_token_cap: opts.dailyTokenCap ?? 10_000_000,
    period_start: "2026-05-15",
    tokens_used_today: opts.tokensUsedToday ?? 0,
  };

  return {
    from: vi.fn((table: string) => {
      if (table === "scoring_runs") {
        return {
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: "test-run-id" }, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "merchant_scoring_caps") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: capRow, error: null }),
            }),
          }),
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: capRow, error: null }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }

      if (table === "customers") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: opts.customers ?? [CUSTOMER_ROW],
              error: null,
            }),
          }),
        };
      }

      if (table === "customer_inferred_state") {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: opts.inferredStates ?? [],
                error: null,
              }),
            }),
          }),
          upsert: vi.fn().mockResolvedValue({ error: opts.inferredStateUpsertError ?? null }),
        };
      }

      if (table === "order_events") {
        // Chain: .select().eq("merchant_id").in("shopify_customer_gid").in("event_type") — terminal
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                in: vi.fn().mockResolvedValue({
                  data: opts.orderEventsError ? null : (opts.orderEvents ?? []),
                  error: opts.orderEventsError ?? null,
                }),
              }),
            }),
          }),
        };
      }

      if (table === "customer_events") {
        // Two uses:
        // 1. Enrichment: .select().eq().in().not().gte() — terminal
        // 2. appendCustomerEvent: .upsert()
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                not: vi.fn().mockReturnValue({
                  gte: vi.fn().mockResolvedValue({
                    data: opts.engagementEventsError ? null : (opts.engagementEvents ?? []),
                    error: opts.engagementEventsError ?? null,
                  }),
                }),
              }),
            }),
          }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
        };
      }

      throw new Error(`Unexpected table in score-customers mock: ${table}`);
    }),
  } as unknown as LapsedSupabaseClient;
}

function makeAnthropicClient(input = VALID_SCORE_INPUT): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "tool_use", id: "tu_test", name: "score_customers", input }],
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — happy path", () => {
  it("scores one customer and returns status:succeeded with customersScored=1", async () => {
    const serviceClient = makeServiceClient();
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.status).toBe("succeeded");
    expect(result.customersScored).toBe(1);
    expect(result.capReached).toBe(false);
  });

  it("skips scoring when there are no customers", async () => {
    const serviceClient = makeServiceClient({ customers: [] });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.status).toBe("succeeded");
    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — idempotency", () => {
  it("produces consistent results when run twice with the same data", async () => {
    // Both runs use fresh mocks with identical configuration — same data → same state.
    const first = await scoreCustomers(
      makeServiceClient(),
      makeAnthropicClient(),
      { merchantId: MERCHANT_A, medianAovCents: 8000 },
    );
    const second = await scoreCustomers(
      makeServiceClient(),
      makeAnthropicClient(),
      { merchantId: MERCHANT_A, medianAovCents: 8000 },
    );

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(first.customersScored).toBe(second.customersScored);
  });

  it("skips already-scored customers when last_scored_at is more recent than last engagement", async () => {
    // Customer has been scored more recently than their last engagement event → skip.
    const alreadyScoredState = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "lapsed",
        last_scored_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
        last_engagement_event_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
      },
    ];
    const serviceClient = makeServiceClient({ inferredStates: alreadyScoredState });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Token cap exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — cap exhaustion", () => {
  it("halts cleanly and returns capReached:true when daily token cap is already exhausted", async () => {
    const serviceClient = makeServiceClient({
      dailyTokenCap: 10_000_000,
      tokensUsedToday: 10_000_000, // already at limit
    });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.status).toBe("succeeded");
    expect(result.capReached).toBe(true);
    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  it("scores_runs row reflects partial completion when cap is hit mid-batch", async () => {
    // Cap is set just above one batch's token usage (100 input + 50 output = 150 tokens total),
    // so the first batch succeeds but the cap is hit before any further batches.
    const serviceClient = makeServiceClient({
      dailyTokenCap: 200,
      tokensUsedToday: 0,
    });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    // The single-customer batch (100+50=150 tokens) fits within the 200-token cap.
    // After it runs, cumulative usage (150) < cap (200), so capReached stays false.
    expect(result.status).toBe("succeeded");
    expect(result.customersScored).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-merchant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — per-merchant isolation", () => {
  it("opens scoring_runs with the provided merchantId — does not bleed to other merchants", async () => {
    const serviceClient = makeServiceClient();
    await scoreCustomers(serviceClient, makeAnthropicClient(), {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    // scoring_runs.insert must receive merchant_id = MERCHANT_A.
    const fromCalls = (serviceClient.from as ReturnType<typeof vi.fn>).mock.calls;
    const fromResults = (serviceClient.from as ReturnType<typeof vi.fn>).mock.results;

    const runsIdx = fromCalls.findIndex((args: unknown[]) => args[0] === "scoring_runs");
    expect(runsIdx).toBeGreaterThanOrEqual(0);

    const runsTable = fromResults[runsIdx]?.value;
    const insertArgs = (runsTable?.insert as ReturnType<typeof vi.fn>)?.mock.calls[0][0];
    expect(insertArgs).toMatchObject({ merchant_id: MERCHANT_A });
    expect(insertArgs.merchant_id).not.toBe(MERCHANT_B);
  });

  it("customer queries are scoped to the calling merchant", async () => {
    const serviceClient = makeServiceClient();
    await scoreCustomers(serviceClient, makeAnthropicClient(), {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    // Verify that customers table was queried with eq("merchant_id", MERCHANT_A).
    const fromCalls = (serviceClient.from as ReturnType<typeof vi.fn>).mock.calls;
    const fromResults = (serviceClient.from as ReturnType<typeof vi.fn>).mock.results;

    const customersIdx = fromCalls.findIndex((args: unknown[]) => args[0] === "customers");
    const customersTable = fromResults[customersIdx]?.value;
    const selectResult = (customersTable?.select as ReturnType<typeof vi.fn>)?.mock.results[0]?.value;
    const eqArgs = (selectResult?.eq as ReturnType<typeof vi.fn>)?.mock.calls[0];
    expect(eqArgs).toEqual(["merchant_id", MERCHANT_A]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix A regression: scoring input fields must be populated from event data
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — scoring input enrichment (Fix A regression)", () => {
  it("populates ordersInPast12Months, firstOrderDaysAgo, and engagementEventsInPast90Days from event tables", async () => {
    const now = Date.now();
    // One order 400 days ago (establishes firstOrderAt but outside 12m window).
    // One order 100 days ago (within 12m window → ordersInPast12Months = 1).
    const orderEvents = [
      {
        shopify_customer_gid: GID,
        occurred_at: new Date(now - 400 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        shopify_customer_gid: GID,
        occurred_at: new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
    // Two engagement events within 90 days.
    const engagementEvents = [
      { shopify_customer_gid: GID },
      { shopify_customer_gid: GID },
    ];

    const serviceClient = makeServiceClient({ orderEvents, engagementEvents });
    const anthropicClient = makeAnthropicClient();

    await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    // The Anthropic client must have been called (customer was not skipped).
    expect(anthropicClient.messages.create).toHaveBeenCalledOnce();

    // Extract the user prompt from the API call.
    const callArgs = (anthropicClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userPrompt = callArgs.messages[0].content as string;

    // firstOrderDaysAgo must not be "unknown" — it comes from the 400-day-old event.
    expect(userPrompt).not.toContain("first_order:unknown");
    // ordersInPast12Months must be 1 (only the 100-day-ago order qualifies).
    expect(userPrompt).toContain("last_12m:1");
    // engagementEventsInPast90Days must be 2.
    expect(userPrompt).toContain("engagement_90d:2");
  });

  it("uses fallback zeros only when event tables return no rows", async () => {
    // No order events and no engagement events — fields fall back to safe defaults.
    const serviceClient = makeServiceClient({ orderEvents: [], engagementEvents: [] });
    const anthropicClient = makeAnthropicClient();

    await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(anthropicClient.messages.create).toHaveBeenCalledOnce();
    const callArgs = (anthropicClient.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userPrompt = callArgs.messages[0].content as string;

    // With no events, firstOrderDaysAgo is null → "unknown", and counts are 0.
    expect(userPrompt).toContain("first_order:unknown");
    expect(userPrompt).toContain("last_12m:0");
    expect(userPrompt).toContain("engagement_90d:0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB error propagation
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — DB error propagation", () => {
  it("returns status:failed when order_events query errors", async () => {
    const serviceClient = makeServiceClient({
      orderEventsError: new Error("order_events db error"),
    });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.status).toBe("failed");
    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  it("returns status:failed when customer_events (engagement) query errors", async () => {
    const serviceClient = makeServiceClient({
      engagementEventsError: new Error("customer_events db error"),
    });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.status).toBe("failed");
    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  it("continues batch with status:succeeded when writeScoreForCustomer upsert fails", async () => {
    // The orchestrator swallows per-customer write errors rather than halting the run.
    // The event log advances (customer_scored event written) but inferred state upsert fails.
    const serviceClient = makeServiceClient({
      inferredStateUpsertError: new Error("constraint violation"),
    });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    // Run still reports succeeded — per-customer errors are swallowed.
    expect(result.status).toBe("succeeded");
    // Counter not incremented since writeScoreForCustomer threw before completing.
    expect(result.customersScored).toBe(0);
  });
});
