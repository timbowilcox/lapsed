import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  designCampaign,
  parseCampaignProposal,
  CampaignDesignError,
  CampaignProposalSchema,
  OFFER_TYPE_TAXONOMY,
  SEND_TIME_WINDOWS,
  PROMPT_VERSION,
  SYSTEM_PROMPT_TEMPLATE,
  type CampaignVariant,
  type GroupSummary,
  type DesignCampaignInput,
} from "../src/campaign-designer";
import type { VoiceProfile } from "../src/voice-synthesizer";

const VOICE_PROFILE: VoiceProfile = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "medium",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: [],
  signature_phrases: ["small batch"],
  sample_sentences: ["s1", "s2", "s3", "s4", "s5"],
};

const GROUP_SUMMARY: GroupSummary = {
  customerCount: 120,
  lifecycleCounts: { lapsed: 90, at_risk: 30 },
  medianAovCents: 6400,
  medianRecencyDays: 140,
  avgOrderCount: 2.4,
};

function variant(overrides: Partial<CampaignVariant> = {}): CampaignVariant {
  return {
    offer_type: "percent_discount",
    offer_value: "10%",
    message_draft: "We saved your spot — here's 10% to come back.",
    send_time_window: "evening",
    tone: "warm",
    expected_impact: { estimated_response_rate: 0.12, estimated_recovered_revenue: 900 },
    ...overrides,
  };
}

/** Three mutually-distinct variants that satisfy the schema refine. */
function validVariants(): CampaignVariant[] {
  return [
    variant({ offer_type: "percent_discount", send_time_window: "evening", tone: "warm" }),
    variant({ offer_type: "free_shipping", send_time_window: "morning", tone: "direct" }),
    variant({ offer_type: "bundle", send_time_window: "weekend_morning", tone: "playful" }),
  ];
}

function designInput(overrides: Partial<DesignCampaignInput> = {}): DesignCampaignInput {
  return {
    groupSlug: "lapsed_vips",
    voiceProfile: VOICE_PROFILE,
    groupSummary: GROUP_SUMMARY,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Anthropic client
// ─────────────────────────────────────────────────────────────────────────────

type CreateResult =
  | { kind: "tool"; input: unknown; inputTokens?: number; outputTokens?: number }
  | { kind: "no_tool"; inputTokens?: number; outputTokens?: number }
  | { kind: "throw"; error: Error };

function mockClient(results: CreateResult[]) {
  let i = 0;
  const create = vi.fn(async () => {
    const r = results[Math.min(i, results.length - 1)]!;
    i++;
    if (r.kind === "throw") throw r.error;
    const usage = { input_tokens: r.inputTokens ?? 100, output_tokens: r.outputTokens ?? 50 };
    if (r.kind === "no_tool") {
      return { content: [{ type: "text", text: "no tool" }], usage };
    }
    return { content: [{ type: "tool_use", name: "propose_campaign", input: r.input }], usage };
  });
  return { messages: { create } } as unknown as Anthropic;
}

function apiError(status: number, message = "api error"): Error {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Taxonomy constants
// ─────────────────────────────────────────────────────────────────────────────

describe("taxonomy constants", () => {
  it("OFFER_TYPE_TAXONOMY has 8 closed values", () => {
    expect(OFFER_TYPE_TAXONOMY).toHaveLength(8);
    expect(OFFER_TYPE_TAXONOMY).toContain("percent_discount");
    expect(OFFER_TYPE_TAXONOMY).toContain("free_shipping");
  });

  it("SEND_TIME_WINDOWS has the 5 spec'd windows", () => {
    expect([...SEND_TIME_WINDOWS]).toEqual([
      "morning",
      "midday",
      "evening",
      "weekend_morning",
      "weekend_evening",
    ]);
  });

  it("PROMPT_VERSION is a stable 16-char hash of the system prompt", () => {
    expect(PROMPT_VERSION).toHaveLength(16);
    expect(SYSTEM_PROMPT_TEMPLATE.length).toBeGreaterThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CampaignProposalSchema / parseCampaignProposal
// ─────────────────────────────────────────────────────────────────────────────

describe("CampaignProposalSchema", () => {
  it("accepts three mutually-distinct variants", () => {
    const parsed = parseCampaignProposal({ variants: validVariants() });
    expect(parsed.variants).toHaveLength(3);
  });

  it("rejects fewer than three variants", () => {
    expect(() =>
      parseCampaignProposal({ variants: validVariants().slice(0, 2) }),
    ).toThrow();
  });

  it("rejects more than three variants", () => {
    expect(() =>
      parseCampaignProposal({ variants: [...validVariants(), variant()] }),
    ).toThrow();
  });

  it("rejects three variants identical on (offer_type, send_time_window, tone)", () => {
    expect(() =>
      parseCampaignProposal({ variants: [variant(), variant(), variant()] }),
    ).toThrow(/mutually distinct/);
  });

  it("rejects a message_draft longer than 160 characters", () => {
    const long = variant({ message_draft: "x".repeat(161), offer_type: "free_gift" });
    expect(() =>
      parseCampaignProposal({ variants: [validVariants()[0]!, validVariants()[1]!, long] }),
    ).toThrow();
  });

  it("rejects an offer_type outside the taxonomy", () => {
    const bad = { ...variant(), offer_type: "buy_one_get_one" };
    expect(() =>
      parseCampaignProposal({ variants: [validVariants()[0]!, validVariants()[1]!, bad] }),
    ).toThrow();
  });

  it("rejects an estimated_response_rate above 1", () => {
    const bad = variant({
      offer_type: "loyalty_points",
      expected_impact: { estimated_response_rate: 1.4, estimated_recovered_revenue: 10 },
    });
    expect(() =>
      parseCampaignProposal({ variants: [validVariants()[0]!, validVariants()[1]!, bad] }),
    ).toThrow();
  });

  it("rejects a negative estimated_recovered_revenue", () => {
    const bad = variant({
      offer_type: "early_access",
      expected_impact: { estimated_response_rate: 0.1, estimated_recovered_revenue: -5 },
    });
    expect(() =>
      parseCampaignProposal({ variants: [validVariants()[0]!, validVariants()[1]!, bad] }),
    ).toThrow();
  });

  it("rejects an extra field on a variant (.strict())", () => {
    const bad = { ...variant({ offer_type: "exclusive_access" }), leaked: "x" };
    expect(() =>
      parseCampaignProposal({ variants: [validVariants()[0]!, validVariants()[1]!, bad] }),
    ).toThrow();
  });

  it("variants distinct on offer_type alone satisfy the refine", () => {
    // Same send window + tone, different offer types → distinct triples.
    const v = [
      variant({ offer_type: "percent_discount" }),
      variant({ offer_type: "free_shipping" }),
      variant({ offer_type: "bundle" }),
    ];
    expect(() => CampaignProposalSchema.parse({ variants: v })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// designCampaign — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("designCampaign — happy path", () => {
  it("returns three variants on a clean first response", async () => {
    const client = mockClient([{ kind: "tool", input: { variants: validVariants() } }]);
    const result = await designCampaign(client, designInput());
    expect(result.variants).toHaveLength(3);
    expect(result.retries).toBe(0);
    expect(result.promptVersion).toBe(PROMPT_VERSION);
  });

  it("accumulates token usage and reports the model version", async () => {
    const client = mockClient([
      { kind: "tool", input: { variants: validVariants() }, inputTokens: 1200, outputTokens: 640 },
    ]);
    const result = await designCampaign(client, designInput());
    expect(result.tokensInput).toBe(1200);
    expect(result.tokensOutput).toBe(640);
    expect(result.modelVersion).toContain("sonnet");
  });

  it("honours a model override", async () => {
    const client = mockClient([{ kind: "tool", input: { variants: validVariants() } }]);
    const result = await designCampaign(client, designInput({ model: "claude-sonnet-4-6-pinned" }));
    expect(result.modelVersion).toBe("claude-sonnet-4-6-pinned");
  });

  it("calls the Anthropic API with tool_choice forcing the propose_campaign tool", async () => {
    const client = mockClient([{ kind: "tool", input: { variants: validVariants() } }]);
    await designCampaign(client, designInput());
    const createMock = (client.messages.create as unknown as ReturnType<typeof vi.fn>);
    const callArgs = createMock.mock.calls[0]![0];
    expect(callArgs.tool_choice).toEqual({ type: "tool", name: "propose_campaign" });
    expect(callArgs.max_tokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// designCampaign — retries
// ─────────────────────────────────────────────────────────────────────────────

describe("designCampaign — retries", () => {
  it("retries on a schema-invalid response and accumulates tokens across attempts", async () => {
    const client = mockClient([
      { kind: "tool", input: { variants: validVariants().slice(0, 2) }, inputTokens: 100, outputTokens: 40 },
      { kind: "tool", input: { variants: validVariants() }, inputTokens: 110, outputTokens: 60 },
    ]);
    const result = await designCampaign(client, designInput());
    expect(result.retries).toBe(1);
    expect(result.tokensInput).toBe(210);
    expect(result.tokensOutput).toBe(100);
  });

  it("retries when the three variants are not mutually distinct", async () => {
    const client = mockClient([
      { kind: "tool", input: { variants: [variant(), variant(), variant()] } },
      { kind: "tool", input: { variants: validVariants() } },
    ]);
    const result = await designCampaign(client, designInput());
    expect(result.retries).toBe(1);
  });

  it("retries when the response has no tool_use block", async () => {
    const client = mockClient([
      { kind: "no_tool" },
      { kind: "tool", input: { variants: validVariants() } },
    ]);
    const result = await designCampaign(client, designInput());
    expect(result.retries).toBe(1);
  });

  it("retries on a transient API error then succeeds", async () => {
    const client = mockClient([
      { kind: "throw", error: apiError(503, "service unavailable") },
      { kind: "tool", input: { variants: validVariants() } },
    ]);
    const result = await designCampaign(client, designInput());
    expect(result.retries).toBe(1);
  });

  it("throws CampaignDesignError after exhausting retries on persistent schema failure", async () => {
    const client = mockClient([{ kind: "tool", input: { variants: [] } }]);
    await expect(designCampaign(client, designInput())).rejects.toBeInstanceOf(CampaignDesignError);
    await expect(designCampaign(client, designInput())).rejects.toMatchObject({
      reason: "schema_validation",
    });
  });

  it("makes exactly MAX_RETRIES attempts before giving up", async () => {
    const client = mockClient([{ kind: "tool", input: { variants: [] } }]);
    await expect(designCampaign(client, designInput())).rejects.toThrow();
    expect((client.messages.create as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// designCampaign — permanent errors + PII gate
// ─────────────────────────────────────────────────────────────────────────────

describe("designCampaign — permanent errors", () => {
  it("short-circuits on a 401 without retrying", async () => {
    const client = mockClient([{ kind: "throw", error: apiError(401, "bad key") }]);
    await expect(designCampaign(client, designInput())).rejects.toMatchObject({
      reason: "permanent_api",
    });
    expect((client.messages.create as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("short-circuits on a 400 bad request", async () => {
    const client = mockClient([{ kind: "throw", error: apiError(400) }]);
    await expect(designCampaign(client, designInput())).rejects.toMatchObject({
      reason: "permanent_api",
    });
  });
});

describe("designCampaign — PII pre-flight (decision 10)", () => {
  it("throws pii_leak before any API call when the group summary carries PII", async () => {
    const client = mockClient([{ kind: "tool", input: { variants: validVariants() } }]);
    // A regression that put a customer email into a lifecycle-count key.
    const leaky: GroupSummary = {
      ...GROUP_SUMMARY,
      lifecycleCounts: { "jane.doe@example.com": 3, lapsed: 90 },
    };
    await expect(
      designCampaign(client, designInput({ groupSummary: leaky })),
    ).rejects.toMatchObject({ reason: "pii_leak" });
    // The Anthropic API must never have been called.
    expect((client.messages.create as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("rejects a malformed group summary (non-numeric count) before the call", async () => {
    const client = mockClient([{ kind: "tool", input: { variants: validVariants() } }]);
    await expect(
      designCampaign(client, {
        groupSlug: "lapsed_vips",
        voiceProfile: VOICE_PROFILE,
        // @ts-expect-error — customerCount must be a number
        groupSummary: { ...GROUP_SUMMARY, customerCount: "lots" },
      }),
    ).rejects.toThrow();
    expect((client.messages.create as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("accepts a clean counts-only group summary", async () => {
    const client = mockClient([{ kind: "tool", input: { variants: validVariants() } }]);
    const result = await designCampaign(client, designInput());
    expect(result.variants).toHaveLength(3);
  });
});
