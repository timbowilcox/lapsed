import { describe, it, expect, vi, afterEach } from "vitest";
import { scoreCustomers } from "../src/score-customers";
import { HAIKU_MODEL } from "../src/customer-scoring";
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
  rfmStates?: object[];
  rfmStatesError?: Error;
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
    // Today's UTC date — the cap logic resets tokens_used_today when
    // period_start < today, so a hardcoded date makes the fixture stale
    // (and tokensUsedToday silently ignored) once the calendar advances.
    period_start: new Date().toISOString().slice(0, 10),
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
        // 1. Enrichment: .select().eq().in().not() — terminal (no 90d filter; we
        //    aggregate count-within-90d and MAX(occurred_at) in code).
        // 2. appendCustomerEvent: .upsert()
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockReturnValue({
                not: vi.fn().mockResolvedValue({
                  data: opts.engagementEventsError ? null : (opts.engagementEvents ?? []),
                  error: opts.engagementEventsError ?? null,
                }),
              }),
            }),
          }),
          upsert: vi.fn().mockResolvedValue({ error: null }),
        };
      }

      if (table === "customer_rfm") {
        // .select().eq().in() — batch RFM lifecycle fetch in findScorable
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: opts.rfmStatesError ? null : (opts.rfmStates ?? []),
                error: opts.rfmStatesError ?? null,
              }),
            }),
          }),
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
    // Must also provide matching rfmStates and current score_model_version so the
    // lifecycle-change and model-version checks do not independently force a rescore.
    const alreadyScoredState = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "lapsed",
        last_scored_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
        last_engagement_event_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
        score_model_version: HAIKU_MODEL, // current model — prevents auto-rescore
      },
    ];
    const rfmStates = [{ shopify_customer_gid: GID, lifecycle_stage: "lapsed" }]; // matches state
    const serviceClient = makeServiceClient({ inferredStates: alreadyScoredState, rfmStates });

    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  it("skips a customer with no RFM row when scored recently (< 25h) and engagement is stale", async () => {
    // No RFM row, but scored 1h ago — the RFM batch will materialise the row within the next cycle.
    // Skip to avoid rescoring on every run during the brief materialization window.
    const recentlyScoredState = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "lapsed",
        last_scored_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
        last_engagement_event_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
        score_model_version: HAIKU_MODEL,
      },
    ];
    const serviceClient = makeServiceClient({ inferredStates: recentlyScoredState, rfmStates: [] });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  it("rescores a customer with no RFM row when score is stale (> 25h)", async () => {
    // No RFM row AND last_scored_at is 48h ago — the RFM batch should have run by now.
    // Rescore so lifecycle-drift detection is not permanently bypassed.
    const staleNoRfmState = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "lapsed",
        last_scored_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
        last_engagement_event_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(), // 72h ago
        score_model_version: HAIKU_MODEL,
      },
    ];
    const serviceClient = makeServiceClient({ inferredStates: staleNoRfmState, rfmStates: [] });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(1);
    expect(anthropicClient.messages.create).toHaveBeenCalledOnce();
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
      { shopify_customer_gid: GID, occurred_at: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString() },
      { shopify_customer_gid: GID, occurred_at: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString() },
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

// ─────────────────────────────────────────────────────────────────────────────
// Incremental skip — lifecycle change forces rescore
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — lifecycle-change rescore", () => {
  it("rescores a customer whose lifecycle changed since last scoring even when engagement is stale", async () => {
    // last_scored_at is more recent than last_engagement_event_at (stale engagement),
    // but customer_rfm.lifecycle_stage = "lapsed" while state.lifecycle_stage = "at_risk".
    // The lifecycle change must force a rescore.
    const stateWithStaleEngagement = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "at_risk",
        last_scored_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        last_engagement_event_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        score_model_version: HAIKU_MODEL,
      },
    ];
    const rfmStates = [{ shopify_customer_gid: GID, lifecycle_stage: "lapsed" }];
    const serviceClient = makeServiceClient({ inferredStates: stateWithStaleEngagement, rfmStates });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(1);
    expect(anthropicClient.messages.create).toHaveBeenCalledOnce();
  });

  it("writes the RFM lifecycle_stage to customer_inferred_state upsert", async () => {
    const stateWithStaleEngagement = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "at_risk",
        last_scored_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        last_engagement_event_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        score_model_version: HAIKU_MODEL,
      },
    ];
    const rfmStates = [{ shopify_customer_gid: GID, lifecycle_stage: "lapsed" }];
    const serviceClient = makeServiceClient({ inferredStates: stateWithStaleEngagement, rfmStates });
    const anthropicClient = makeAnthropicClient();

    await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    interface MockWithUpsert { value: { upsert: ReturnType<typeof vi.fn> } }
    const fromMock = serviceClient.from as ReturnType<typeof vi.fn>;
    const upsertResult = (fromMock.mock.calls as string[][])
      .map((c, i) =>
        c[0] === "customer_inferred_state"
          ? (fromMock.mock.results[i] as unknown as MockWithUpsert | null)
          : null,
      )
      .find((r): r is MockWithUpsert => (r?.value?.upsert?.mock?.calls?.length ?? 0) > 0);
    expect(upsertResult).toBeDefined();
    const payload = upsertResult!.value.upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.lifecycle_stage).toBe("lapsed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Incremental skip — stale model version forces rescore
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — model-version rescore", () => {
  it("rescores a customer whose score_model_version is stale even when engagement and lifecycle are unchanged", async () => {
    const staleVersionState = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "lapsed",
        last_scored_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        last_engagement_event_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        score_model_version: "claude-haiku-4-5-old", // stale
      },
    ];
    const rfmStates = [{ shopify_customer_gid: GID, lifecycle_stage: "lapsed" }]; // unchanged lifecycle
    const serviceClient = makeServiceClient({ inferredStates: staleVersionState, rfmStates });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(1);
    expect(anthropicClient.messages.create).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Observability — per-batch structured success log
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — batch success log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a scoring_batch_complete log after each successful batch", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const serviceClient = makeServiceClient();
    const anthropicClient = makeAnthropicClient();

    await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    // Find the batch-complete log call.
    const batchLog = logSpy.mock.calls
      .map((args) => { try { return JSON.parse(args[0] as string) as Record<string, unknown>; } catch { return null; } })
      .find((obj) => obj?.event === "scoring_batch_complete");

    expect(batchLog).toBeDefined();
    expect(batchLog).toMatchObject({
      event: "scoring_batch_complete",
      batch_size: 1,
      tokens_in: 100,
      tokens_out: 50,
      status: "succeeded",
    });
    expect(typeof batchLog?.latency_ms).toBe("number");
    expect(typeof batchLog?.merchant_id).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Churned exclusion via RFM lifecycle (265c4c5 fix)
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — churned exclusion via RFM lifecycle", () => {
  it("excludes a customer whose customer_rfm lifecycle is churned even if inferred state is stale/non-churned", async () => {
    // customer_rfm says churned; inferred state says lapsed (stale — hasn't been updated yet)
    const staleInferredState = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "lapsed",
        last_scored_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        last_engagement_event_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        score_model_version: HAIKU_MODEL,
      },
    ];
    const rfmStates = [{ shopify_customer_gid: GID, lifecycle_stage: "churned" }];
    const serviceClient = makeServiceClient({ inferredStates: staleInferredState, rfmStates });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  it("excludes a customer whose inferred lifecycle is churned even when no RFM row exists", async () => {
    const churnedInferredState = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "churned",
        last_scored_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        last_engagement_event_at: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
        score_model_version: HAIKU_MODEL,
      },
    ];
    // No RFM row — rfmLifecycle falls back to null, but inferred state is churned
    const serviceClient = makeServiceClient({ inferredStates: churnedInferredState, rfmStates: [] });
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
// last_engagement_event_at write path (regression: column was never written, so
// engagement-freshness rescore was permanently inert before this fix).
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — last_engagement_event_at write path", () => {
  it("rescores when a fresh engagement event is newer than last_scored_at", async () => {
    // last_scored_at is 25h ago; a customer_events row landed 1h ago.
    // Previously: column was never written, so lastEngaged = 0, customer was skipped.
    // After fix: MAX(occurred_at) is captured on the prior run and now drives rescore.
    const now = Date.now();
    const inferredStates = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "lapsed",
        last_scored_at: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
        last_engagement_event_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(), // 1h ago
        score_model_version: HAIKU_MODEL,
      },
    ];
    const rfmStates = [{ shopify_customer_gid: GID, lifecycle_stage: "lapsed" }];
    const serviceClient = makeServiceClient({ inferredStates, rfmStates });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(1);
    expect(anthropicClient.messages.create).toHaveBeenCalledOnce();
  });

  it("skips when last_scored_at is fresher than last_engagement_event_at (column populated)", async () => {
    // Scored 1h ago, last engagement 5h ago — no new signal since score; skip.
    const now = Date.now();
    const inferredStates = [
      {
        shopify_customer_gid: GID,
        lifecycle_stage: "lapsed",
        last_scored_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
        last_engagement_event_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
        score_model_version: HAIKU_MODEL,
      },
    ];
    const rfmStates = [{ shopify_customer_gid: GID, lifecycle_stage: "lapsed" }];
    const serviceClient = makeServiceClient({ inferredStates, rfmStates });
    const anthropicClient = makeAnthropicClient();

    const result = await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    expect(result.customersScored).toBe(0);
    expect(anthropicClient.messages.create).not.toHaveBeenCalled();
  });

  it("writes the MAX(occurred_at) of non-system events to customer_inferred_state.last_engagement_event_at", async () => {
    // Three engagement events; the most recent (2 days ago) must land in the upsert payload.
    const now = Date.now();
    const mostRecent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const engagementEvents = [
      { shopify_customer_gid: GID, occurred_at: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString() },
      { shopify_customer_gid: GID, occurred_at: mostRecent },
      { shopify_customer_gid: GID, occurred_at: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString() },
    ];
    const serviceClient = makeServiceClient({ engagementEvents });
    const anthropicClient = makeAnthropicClient();

    await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    interface MockWithUpsert { value: { upsert: ReturnType<typeof vi.fn> } }
    const fromMock = serviceClient.from as ReturnType<typeof vi.fn>;
    const upsertResult = (fromMock.mock.calls as string[][])
      .map((c, i) =>
        c[0] === "customer_inferred_state"
          ? (fromMock.mock.results[i] as unknown as MockWithUpsert | null)
          : null,
      )
      .find((r): r is MockWithUpsert => (r?.value?.upsert?.mock?.calls?.length ?? 0) > 0);
    expect(upsertResult).toBeDefined();
    const payload = upsertResult!.value.upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.last_engagement_event_at).toBe(mostRecent);
  });

  it("omits last_engagement_event_at from the upsert payload when no non-system events are found (preserves prior value on conflict)", async () => {
    // customer_events is append-only (Decision 1), so a transient empty result
    // must not clobber a previously-written non-null timestamp. The upsert key
    // is omitted, leaving any existing column value intact.
    const serviceClient = makeServiceClient({ engagementEvents: [] });
    const anthropicClient = makeAnthropicClient();

    await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    interface MockWithUpsert { value: { upsert: ReturnType<typeof vi.fn> } }
    const fromMock = serviceClient.from as ReturnType<typeof vi.fn>;
    const upsertResult = (fromMock.mock.calls as string[][])
      .map((c, i) =>
        c[0] === "customer_inferred_state"
          ? (fromMock.mock.results[i] as unknown as MockWithUpsert | null)
          : null,
      )
      .find((r): r is MockWithUpsert => (r?.value?.upsert?.mock?.calls?.length ?? 0) > 0);
    expect(upsertResult).toBeDefined();
    const payload = upsertResult!.value.upsert.mock.calls[0][0] as Record<string, unknown>;
    expect("last_engagement_event_at" in payload).toBe(false);
  });

  it("captures a >90d-old engagement event as the MAX (cutoff removed for last_engagement_event_at)", async () => {
    // The 90d filter was dropped so older events still establish a baseline
    // last_engagement_event_at. Without this behavior, customers whose last
    // engagement is older than 90d would have last_engagement_event_at = null
    // forever, defeating the incremental-skip eligibility comparison.
    const now = Date.now();
    const veryOldEvent = new Date(now - 200 * 24 * 60 * 60 * 1000).toISOString();
    const engagementEvents = [
      { shopify_customer_gid: GID, occurred_at: veryOldEvent },
    ];
    const serviceClient = makeServiceClient({ engagementEvents });
    const anthropicClient = makeAnthropicClient();

    await scoreCustomers(serviceClient, anthropicClient, {
      merchantId: MERCHANT_A,
      medianAovCents: 8000,
    });

    interface MockWithUpsert { value: { upsert: ReturnType<typeof vi.fn> } }
    const fromMock = serviceClient.from as ReturnType<typeof vi.fn>;
    const upsertResult = (fromMock.mock.calls as string[][])
      .map((c, i) =>
        c[0] === "customer_inferred_state"
          ? (fromMock.mock.results[i] as unknown as MockWithUpsert | null)
          : null,
      )
      .find((r): r is MockWithUpsert => (r?.value?.upsert?.mock?.calls?.length ?? 0) > 0);
    expect(upsertResult).toBeDefined();
    const payload = upsertResult!.value.upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.last_engagement_event_at).toBe(veryOldEvent);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// customer_rfm DB error propagation
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreCustomers — customer_rfm error propagation", () => {
  it("returns status:failed when customer_rfm fetch errors", async () => {
    const serviceClient = makeServiceClient({
      rfmStatesError: new Error("customer_rfm db error"),
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
});
