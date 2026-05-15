import { describe, it, expect, vi } from "vitest";
import { scoreBatch, BATCH_SIZE } from "../src/customer-scoring";
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

const VALID_RESPONSE = JSON.stringify({
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
});

function mockAnthropicClient(responseText: string, usage = { input_tokens: 100, output_tokens: 50 }): Anthropic {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: responseText }],
        usage,
      }),
    },
  } as unknown as Anthropic;
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreBatch — happy path", () => {
  it("returns structured scores for a single customer", async () => {
    const client = mockAnthropicClient(VALID_RESPONSE);
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
    const client = mockAnthropicClient(VALID_RESPONSE, { input_tokens: 1000, output_tokens: 200 });
    const result = await scoreBatch(client, [CUSTOMER], 8000);
    expect(result.tokensInput).toBe(1000);
    expect(result.tokensOutput).toBe(200);
    expect(result.costCents).toBeGreaterThan(0);
  });

  it("returns empty result for empty customer list without calling API", async () => {
    const client = mockAnthropicClient(VALID_RESPONSE);
    const result = await scoreBatch(client, [], 8000);
    expect(result.scores).toHaveLength(0);
    expect(result.tokensInput).toBe(0);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response parsing
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreBatch — response parsing", () => {
  it("truncates top_signal to 100 chars if model returns longer string", async () => {
    const longSignal = "A".repeat(150);
    const overflowResponse = JSON.stringify({
      scores: [{ ...JSON.parse(VALID_RESPONSE).scores[0], top_signal: longSignal }],
    });
    const client = mockAnthropicClient(overflowResponse);
    const result = await scoreBatch(client, [CUSTOMER], 8000);
    expect(result.scores[0].topSignal.length).toBe(100);
  });

  it("returns conservative defaults when model omits a customer", async () => {
    const emptyScoresResponse = JSON.stringify({ scores: [] });
    const client = mockAnthropicClient(emptyScoresResponse);
    const result = await scoreBatch(client, [CUSTOMER], 8000);
    expect(result.scores).toHaveLength(1);
    const score = result.scores[0];
    expect(score.propensity30d).toBe(0);
    expect(score.propensity60d).toBe(0);
    expect(score.propensity90d).toBe(0);
    expect(score.predictedResidualLtvCents).toBe(0);
    expect(score.topSignal).toBe("no score returned");
  });

  it("throws on malformed JSON from model", async () => {
    const client = mockAnthropicClient("not json");
    await expect(scoreBatch(client, [CUSTOMER], 8000)).rejects.toThrow("failed to parse");
  });

  it("throws on schema validation failure (propensity out of range)", async () => {
    const badResponse = JSON.stringify({
      scores: [{ ...JSON.parse(VALID_RESPONSE).scores[0], propensity_30d: 2.5 }],
    });
    const client = mockAnthropicClient(badResponse);
    await expect(scoreBatch(client, [CUSTOMER], 8000)).rejects.toThrow("failed to parse");
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
    const client = mockAnthropicClient(VALID_RESPONSE);
    await expect(scoreBatch(client, tooMany, 8000)).rejects.toThrow("cannot score more than");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt determinism
// ─────────────────────────────────────────────────────────────────────────────

describe("scoreBatch — prompt determinism", () => {
  it("calls the Haiku model with the expected model ID", async () => {
    const client = mockAnthropicClient(VALID_RESPONSE);
    await scoreBatch(client, [CUSTOMER], 8000);
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe("claude-haiku-4-5-20251001");
  });

  it("produces identical prompts for identical inputs (deterministic)", async () => {
    const client1 = mockAnthropicClient(VALID_RESPONSE);
    const client2 = mockAnthropicClient(VALID_RESPONSE);
    await scoreBatch(client1, [CUSTOMER], 8000);
    await scoreBatch(client2, [CUSTOMER], 8000);
    const call1 = (client1.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call2 = (client2.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call1.messages[0].content).toBe(call2.messages[0].content);
    expect(call1.system).toBe(call2.system);
  });
});
