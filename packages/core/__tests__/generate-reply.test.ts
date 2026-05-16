import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateReply,
  parseGeneratedReply,
  buildSystemPrompt,
  buildUserPrompt,
  createGenerateClient,
  GenerateReplyError,
  MAX_GENERATE_ATTEMPTS,
  REPLY_HISTORY_LIMIT,
  REPLY_BODY_MAX_CHARS,
  type GenerateReplyInput,
  type ReplyHistoryMessage,
} from "../src/generate-reply";
import { SONNET_MODEL_DEFAULT, type VoiceProfile } from "../src/voice-synthesizer";
import type { ReplyClassification } from "../src/classify-reply";
import type Anthropic from "@anthropic-ai/sdk";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function runWithTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  promise.then(
    () => undefined,
    () => undefined,
  );
  await vi.runAllTimersAsync();
  return promise;
}

function makeToolUseResponse(input: unknown, usage = { input_tokens: 200, output_tokens: 60 }) {
  return {
    content: [{ type: "tool_use", id: "tu_test", name: "generate_reply", input }],
    usage,
  };
}

function mockClient(
  responses: Array<
    | { input: unknown; usage?: { input_tokens: number; output_tokens: number } }
    | { throws: Error }
    | { noTool: true }
  >,
): Anthropic {
  const queue = [...responses];
  return {
    messages: {
      create: vi.fn().mockImplementation(async () => {
        const next = queue.shift();
        if (!next) throw new Error("mock exhausted");
        if ("throws" in next) throw next.throws;
        if ("noTool" in next) {
          return { content: [{ type: "text", text: "nope" }], usage: { input_tokens: 10, output_tokens: 5 } };
        }
        return makeToolUseResponse(next.input, next.usage);
      }),
    },
  } as unknown as Anthropic;
}

function anthropicError(status: number, message = "api error"): Error {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const VOICE: VoiceProfile = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "short",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: ["act now", "hurry"],
  signature_phrases: ["small batch"],
  sample_sentences: ["a", "b", "c", "d", "e"],
};

const CLASSIFICATION: ReplyClassification = {
  sentiment: "positive",
  intent: "engagement",
  confidence: 0.88,
};

const HISTORY: ReplyHistoryMessage[] = [
  { direction: "outbound", redactedBody: "Hey — we miss you. 15% off if you'd like it." },
  { direction: "inbound", redactedBody: "ooh tell me more" },
];

function input(over: Partial<GenerateReplyInput> = {}): GenerateReplyInput {
  return {
    classification: CLASSIFICATION,
    conversationHistory: HISTORY,
    voiceProfile: VOICE,
    customerContext: { lifecycleStage: "lapsed", lastOrderAt: "2026-01-10", propensity: 0.6 },
    ...over,
  };
}

const VALID_REPLY = {
  body: "So glad you asked! The 15% link is yours whenever you're ready — no rush at all.",
  include_signature: true,
  suggested_next_action: "offer",
};

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("generateReply — happy path", () => {
  it("returns a parsed reply, token counts, and retries=0", async () => {
    const client = mockClient([{ input: VALID_REPLY }]);
    const result = await runWithTimers(() => generateReply(client, input()));
    expect(result.reply.body).toBe(VALID_REPLY.body);
    expect(result.reply.include_signature).toBe(true);
    expect(result.reply.suggested_next_action).toBe("offer");
    expect(result.retries).toBe(0);
    expect(result.modelVersion).toBe(SONNET_MODEL_DEFAULT);
    expect(result.tokensInput).toBe(200);
    expect(result.tokensOutput).toBe(60);
  });

  it("defaults include_signature to false and suggested_next_action to continue", async () => {
    const client = mockClient([{ input: { body: "Lovely to hear from you." } }]);
    const result = await runWithTimers(() => generateReply(client, input()));
    expect(result.reply.include_signature).toBe(false);
    expect(result.reply.suggested_next_action).toBe("continue");
  });

  it("passes tools + tool_choice to the API (decision 9 — structured output)", async () => {
    const client = mockClient([{ input: VALID_REPLY }]);
    await runWithTimers(() => generateReply(client, input()));
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.tools[0].name).toBe("generate_reply");
    expect(callArgs.tool_choice).toMatchObject({ type: "tool", name: "generate_reply" });
  });

  it("uses only the last REPLY_HISTORY_LIMIT messages of a long thread", async () => {
    const longHistory: ReplyHistoryMessage[] = Array.from({ length: 14 }, (_, i) => ({
      direction: i % 2 === 0 ? "outbound" : "inbound",
      redactedBody: `message ${i}`,
    }));
    const client = mockClient([{ input: VALID_REPLY }]);
    await runWithTimers(() => generateReply(client, input({ conversationHistory: longHistory })));
    const userPrompt = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .messages[0].content as string;
    // Oldest 4 dropped; messages 4..13 kept.
    expect(userPrompt).not.toContain("message 3");
    expect(userPrompt).toContain("message 4");
    expect(userPrompt).toContain("message 13");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("generateReply — retries", () => {
  it("retries a schema-invalid response and accumulates tokens", async () => {
    const client = mockClient([
      { input: { body: "x".repeat(REPLY_BODY_MAX_CHARS + 50) }, usage: { input_tokens: 200, output_tokens: 60 } },
      { input: VALID_REPLY, usage: { input_tokens: 210, output_tokens: 65 } },
    ]);
    const result = await runWithTimers(() => generateReply(client, input()));
    expect(result.retries).toBe(1);
    expect(result.tokensInput).toBe(410);
    expect(result.tokensOutput).toBe(125);
  });

  it("retries a missing-tool_use response", async () => {
    const client = mockClient([{ noTool: true }, { input: VALID_REPLY }]);
    const result = await runWithTimers(() => generateReply(client, input()));
    expect(result.retries).toBe(1);
  });

  it("makes at most MAX_GENERATE_ATTEMPTS attempts then throws", async () => {
    const client = mockClient([{ noTool: true }, { noTool: true }, { noTool: true }]);
    await expect(
      runWithTimers(() => generateReply(client, input())),
    ).rejects.toBeInstanceOf(GenerateReplyError);
    expect((client.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      MAX_GENERATE_ATTEMPTS,
    );
  });

  it("retries a transient API error then succeeds", async () => {
    const client = mockClient([{ throws: anthropicError(503) }, { input: VALID_REPLY }]);
    const result = await runWithTimers(() => generateReply(client, input()));
    expect(result.retries).toBe(1);
  });

  it("exhausts retries on a persistent transient error with reason transient_api", async () => {
    const client = mockClient([{ throws: anthropicError(502) }, { throws: anthropicError(502) }]);
    await expect(
      runWithTimers(() => generateReply(client, input())),
    ).rejects.toMatchObject({ name: "GenerateReplyError", reason: "transient_api" });
  });

  it("short-circuits on a permanent API error", async () => {
    const client = mockClient([{ throws: anthropicError(400) }]);
    await expect(
      runWithTimers(() => generateReply(client, input())),
    ).rejects.toMatchObject({ reason: "permanent_api" });
    expect((client.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("treats a 422 as permanent (no retry within the latency budget)", async () => {
    const client = mockClient([{ throws: anthropicError(422, "unprocessable") }]);
    await expect(
      runWithTimers(() => generateReply(client, input())),
    ).rejects.toMatchObject({ reason: "permanent_api" });
    expect((client.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PII gates (decision 10) — input AND output
// ─────────────────────────────────────────────────────────────────────────────

describe("generateReply — PII gates", () => {
  it("throws input_pii_leak when conversation history contains an un-redacted phone", async () => {
    const client = mockClient([]);
    const dirty: ReplyHistoryMessage[] = [
      { direction: "inbound", redactedBody: "call me on +1 415 555 9876" },
    ];
    await expect(
      runWithTimers(() => generateReply(client, input({ conversationHistory: dirty }))),
    ).rejects.toMatchObject({ name: "GenerateReplyError", reason: "input_pii_leak" });
  });

  it("does not call the API when the input PII gate fails", async () => {
    const client = mockClient([]);
    const dirty: ReplyHistoryMessage[] = [
      { direction: "inbound", redactedBody: "my email is jane@example.com" },
    ];
    await expect(
      runWithTimers(() => generateReply(client, input({ conversationHistory: dirty }))),
    ).rejects.toBeInstanceOf(GenerateReplyError);
    expect((client.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("retries when the generated body contains a hallucinated phone number, then succeeds", async () => {
    const client = mockClient([
      { input: { body: "Call us on +1 415 555 0000 to claim it." } },
      { input: VALID_REPLY },
    ]);
    const result = await runWithTimers(() => generateReply(client, input()));
    expect(result.retries).toBe(1);
    expect(result.reply.body).toBe(VALID_REPLY.body);
  });

  it("throws output_pii_leak when every attempt hallucinates PII", async () => {
    const client = mockClient([
      { input: { body: "Reach us at +1 415 555 0000 anytime." } },
      { input: { body: "Or email help@brand-example.com instead." } },
    ]);
    await expect(
      runWithTimers(() => generateReply(client, input())),
    ).rejects.toMatchObject({ name: "GenerateReplyError", reason: "output_pii_leak" });
  });

  it("the output_pii_leak exhaustion error carries accumulated token counts", async () => {
    const client = mockClient([
      { input: { body: "Call +1 415 555 0000." }, usage: { input_tokens: 200, output_tokens: 60 } },
      { input: { body: "Email a@b-example.com." }, usage: { input_tokens: 210, output_tokens: 65 } },
    ]);
    try {
      await runWithTimers(() => generateReply(client, input()));
      throw new Error("expected generateReply to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GenerateReplyError);
      const e = err as GenerateReplyError;
      expect(e.reason).toBe("output_pii_leak");
      expect(e.tokensInput).toBe(410);
      expect(e.tokensOutput).toBe(125);
    }
  });

  it("keeps the output_pii_leak reason even when a later attempt fails transiently", async () => {
    // Attempt 1 hallucinates PII; attempt 2 throws a transient error. The
    // safety signal must not be masked by the outage on the final throw.
    const client = mockClient([
      { input: { body: "Call +1 415 555 0000 now." } },
      { throws: anthropicError(503) },
    ]);
    await expect(
      runWithTimers(() => generateReply(client, input())),
    ).rejects.toMatchObject({ reason: "output_pii_leak" });
  });

  it("throws empty_history when no prior messages are supplied", async () => {
    const client = mockClient([]);
    await expect(
      runWithTimers(() => generateReply(client, input({ conversationHistory: [] }))),
    ).rejects.toMatchObject({ reason: "empty_history" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("embeds the brand voice tone descriptors", () => {
    const prompt = buildSystemPrompt(VOICE, { lifecycleStage: "lapsed" });
    expect(prompt).toContain("warm, playful, down_to_earth");
    expect(prompt).toContain("emoji policy: rare");
  });

  it("lists forbidden phrases so the model avoids them", () => {
    const prompt = buildSystemPrompt(VOICE, { lifecycleStage: "lapsed" });
    expect(prompt).toContain('"act now"');
    expect(prompt).toContain('"hurry"');
  });

  it("includes the signature phrases", () => {
    const prompt = buildSystemPrompt(VOICE, { lifecycleStage: "lapsed" });
    expect(prompt).toContain('"small batch"');
  });

  it("renders customer context without crashing on null fields", () => {
    const prompt = buildSystemPrompt(VOICE, { lifecycleStage: "dormant", lastOrderAt: null, propensity: null });
    expect(prompt).toContain("lifecycle stage: dormant");
    expect(prompt).toContain("last order: unknown");
    expect(prompt).toContain("repurchase propensity: unscored");
  });

  it("forbids inventing PII / order details", () => {
    const prompt = buildSystemPrompt(VOICE, { lifecycleStage: "lapsed" });
    expect(prompt).toMatch(/Do NOT invent/i);
  });
});

describe("buildUserPrompt", () => {
  it("includes the classification summary and a labelled transcript", () => {
    const prompt = buildUserPrompt(CLASSIFICATION, HISTORY);
    expect(prompt).toContain('sentiment="positive"');
    expect(prompt).toContain('intent="engagement"');
    expect(prompt).toContain("CUSTOMER: ooh tell me more");
    expect(prompt).toContain("AGENT: Hey — we miss you.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseGeneratedReply + exported constants
// ─────────────────────────────────────────────────────────────────────────────

describe("parseGeneratedReply", () => {
  it("parses a valid reply and applies defaults", () => {
    const r = parseGeneratedReply({ body: "hello there" });
    expect(r.include_signature).toBe(false);
    expect(r.suggested_next_action).toBe("continue");
  });

  it("rejects a body over the SMS-segment cap", () => {
    expect(() => parseGeneratedReply({ body: "x".repeat(REPLY_BODY_MAX_CHARS + 1) })).toThrow();
  });

  it("rejects an empty body", () => {
    expect(() => parseGeneratedReply({ body: "" })).toThrow();
  });

  it("rejects an unknown suggested_next_action", () => {
    expect(() =>
      parseGeneratedReply({ body: "hi", suggested_next_action: "escalate" }),
    ).toThrow();
  });
});

describe("generate-reply constants", () => {
  it("MAX_GENERATE_ATTEMPTS is 2", () => {
    expect(MAX_GENERATE_ATTEMPTS).toBe(2);
  });

  it("REPLY_HISTORY_LIMIT is 10", () => {
    expect(REPLY_HISTORY_LIMIT).toBe(10);
  });

  it("REPLY_BODY_MAX_CHARS is 320 (2 SMS segments)", () => {
    expect(REPLY_BODY_MAX_CHARS).toBe(320);
  });

  it("createGenerateClient builds a client without throwing", () => {
    expect(() => createGenerateClient({ apiKey: "sk-test" })).not.toThrow();
  });
});
