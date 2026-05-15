import { describe, it, expect, vi } from "vitest";
import { scoreBatch, BATCH_SIZE, MAX_RETRIES } from "../src/customer-scoring";
import type { CustomerScoringInput } from "../src/customer-scoring";
import type Anthropic from "@anthropic-ai/sdk";

const CUSTOMER: CustomerScoringInput = {
  shopifyCustomerGid: "gid://shopify/Customer/1",
  totalOrderCount: 3,
  lastOrderDaysAgo: 120,
  firstOrderDaysAgo: 400,
  totalLtvCents: 30000,
  ordersInPast12Months: 1,
  engagementEventsInPast90Days: 2,
  lifecycleStage: "lapsed",
  avgOrderValueCents: 10000,
};

const VALID_INPUT = {
  scores: [
    {
      customer_id: "gid://shopify/Customer/1",
      propensity_30d: 0.12,
      propensity_60d: 0.25,
      propensity_90d: 0.38,
      predicted_residual_ltv_cents: 15000,
      top_signal: "3 orders, last 120 days ago, moderate engagement",
    },
  ],
};

function makeToolUseResponse(input: unknown, usage = { input_tokens: 100, output_tokens: 50 }) {
  return {
    content: [{ type: "tool_use", id: "tu_test", name: "score_customers", input }],
    usage,
  };
}

function mockAnthropicClient(input: unknown, usage = { input_tokens: 100, output_tokens: 50 }): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue(makeToolUseResponse(input, usage)),
    },
  } as unknown as Anthropic;
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreBatch — happy path", () => {
  it("returns structured scores for a single customer", async () => {
    const client = mockAnthropicClient(VALID_INPUT);
    const result = await scoreBatch(client, [CUSTOMER], 8000);

    expect(result.scores).toHaveLength(1);
    const score = result.scores[0];
    expect(score.shopifyCustomerGid).toBe(CUSTOMER.shopifyCustomerGid);
    expect(score.propensity30d).toBeCloseTo(0.12);
    expect(score.propensity60d).toBeCloseTo(0.25);
    expect(score.propensity90d).toBeCloseTo(0.38);
    expect(score.predictedResidualLtvCents).toBe(15000);
    expect(score.topSignal.length).toBeLessThanOrEqual(100);
  });

  it("returns correct token counts and cost", async () => {
    const client = mockAnthropicClient(VALID_INPUT, { input_tokens: 1000, output_tokens: 200 });
    const result = await scoreBatch(client, [CUSTOMER], 8000);
    expect(result.tokensInput).toBe(1000);
    expect(result.tokensOutput).toBe(200);
    expect(result.costCents).toBeGreaterThan(0);
  });

  it("returns empty result for empty customer list without calling API", async () => {
    const client = mockAnthropicClient(VALID_INPUT);
    const result = await scoreBatch(client, [], 8000);
    expect(result.scores).toHaveLength(0);
    expect(result.tokensInput).toBe(0);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Structured output (tool_choice enforcement)
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreBatch — structured output via tool_choice", () => {
  it("passes tools and tool_choice to the API call", async () => {
    const client = mockAnthropicClient(VALID_INPUT);
    await scoreBatch(client, [CUSTOMER], 8000);
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools.length).toBeGreaterThan(0);
    expect(callArgs.tools[0].name).toBe("score_customers");
    expect(callArgs.tool_choice).toMatchObject({ type: "tool", name: "score_customers" });
  });

  it("truncates top_signal to 100 chars if model returns longer string", async () => {
    const longSignal = "A".repeat(150);
    const input = { scores: [{ ...VALID_INPUT.scores[0], top_signal: longSignal }] };
    const client = mockAnthropicClient(input);
    const result = await scoreBatch(client, [CUSTOMER], 8000);
    expect(result.scores[0].topSignal.length).toBe(100);
  });

  it("returns conservative defaults when model omits a customer", async () => {
    const client = mockAnthropicClient({ scores: [] });
    const result = await scoreBatch(client, [CUSTOMER], 8000);
    expect(result.scores).toHaveLength(1);
    const score = result.scores[0];
    expect(score.propensity30d).toBe(0);
    expect(score.propensity60d).toBe(0);
    expect(score.propensity90d).toBe(0);
    expect(score.predictedResidualLtvCents).toBe(0);
    expect(score.topSignal).toBe("no score returned");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry logic
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreBatch — retry logic", () => {
  it(`retries up to ${MAX_RETRIES} times and succeeds on second attempt`, async () => {
    const badInput = { scores: [{ ...VALID_INPUT.scores[0], propensity_30d: 2.5 }] }; // fails Zod
    const create = vi.fn()
      .mockResolvedValueOnce(makeToolUseResponse(badInput))
      .mockResolvedValue(makeToolUseResponse(VALID_INPUT));

    const client = { messages: { create } } as unknown as Anthropic;
    const result = await scoreBatch(client, [CUSTOMER], 8000);

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.scores[0].propensity30d).toBeCloseTo(0.12);
  });

  it("accumulates tokens from all attempts including failed ones", async () => {
    // Failed attempt (bad schema) costs 200 input + 80 output; successful attempt costs 100+50.
    // Total must be 300+130 so failed-attempt spend counts toward the daily token cap.
    const badInput = { scores: [{ ...VALID_INPUT.scores[0], propensity_30d: 2.5 }] };
    const create = vi.fn()
      .mockResolvedValueOnce(makeToolUseResponse(badInput, { input_tokens: 200, output_tokens: 80 }))
      .mockResolvedValue(makeToolUseResponse(VALID_INPUT, { input_tokens: 100, output_tokens: 50 }));

    const client = { messages: { create } } as unknown as Anthropic;
    const result = await scoreBatch(client, [CUSTOMER], 8000);

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.tokensInput).toBe(300);  // 200 + 100
    expect(result.tokensOutput).toBe(130); // 80 + 50
  });

  it(`throws after ${MAX_RETRIES} consecutive schema validation failures`, async () => {
    const badInput = { scores: [{ ...VALID_INPUT.scores[0], propensity_30d: 2.5 }] };
    const create = vi.fn().mockResolvedValue(makeToolUseResponse(badInput));

    const client = { messages: { create } } as unknown as Anthropic;
    await expect(scoreBatch(client, [CUSTOMER], 8000)).rejects.toThrow(
      `failed after ${MAX_RETRIES} attempts`,
    );
    expect(create).toHaveBeenCalledTimes(MAX_RETRIES);
  });

  it("throws after three consecutive API errors", async () => {
    const create = vi.fn().mockRejectedValue(new Error("network timeout"));
    const client = { messages: { create } } as unknown as Anthropic;
    await expect(scoreBatch(client, [CUSTOMER], 8000)).rejects.toThrow("failed after");
    expect(create).toHaveBeenCalledTimes(MAX_RETRIES);
  });

  it("throws when tool_use block is missing from response", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "sorry, no tool" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const client = { messages: { create } } as unknown as Anthropic;
    await expect(scoreBatch(client, [CUSTOMER], 8000)).rejects.toThrow("failed after");
    expect(create).toHaveBeenCalledTimes(MAX_RETRIES);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard: batch size limit
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreBatch — batch size guard", () => {
  it(`throws if more than ${BATCH_SIZE} customers are passed`, async () => {
    const tooMany = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => ({
      ...CUSTOMER,
      shopifyCustomerGid: `gid://shopify/Customer/${i}`,
    }));
    const client = mockAnthropicClient(VALID_INPUT);
    await expect(scoreBatch(client, tooMany, 8000)).rejects.toThrow("cannot score more than");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt determinism
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreBatch — prompt determinism", () => {
  it("calls the Haiku model with the expected model ID", async () => {
    const client = mockAnthropicClient(VALID_INPUT);
    await scoreBatch(client, [CUSTOMER], 8000);
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
  });

  it("produces identical prompts for identical inputs (deterministic)", async () => {
    const client1 = mockAnthropicClient(VALID_INPUT);
    const client2 = mockAnthropicClient(VALID_INPUT);
    await scoreBatch(client1, [CUSTOMER], 8000);
    await scoreBatch(client2, [CUSTOMER], 8000);
    const call1 = (client1.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call2 = (client2.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call1.messages[0].content).toBe(call2.messages[0].content);
    expect(call1.system).toBe(call2.system);
  });
});
