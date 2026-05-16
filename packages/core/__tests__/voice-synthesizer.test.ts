import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  synthesizeVoice,
  parseVoiceProfile,
  VoiceSynthesisError,
  PROMPT_VERSION,
  SONNET_MODEL_DEFAULT,
  TONE_TAXONOMY,
  createVoiceClient,
  MAX_OUTPUT_TOKENS,
} from "../src/voice-synthesizer";
import type Anthropic from "@anthropic-ai/sdk";

// Stub timers so retry backoff doesn't slow the suite.
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run `fn` and advance fake timers until it resolves. Suppresses spurious
 *  unhandled-rejection warnings when `fn` rejects synchronously before any
 *  timer fires (the caller still awaits and catches via the returned promise). */
async function runWithTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  // Attach a noop handler so vitest's unhandled-rejection watcher doesn't
  // see the rejection before our final await catches it.
  promise.then(
    () => undefined,
    () => undefined,
  );
  await vi.runAllTimersAsync();
  return promise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const VALID_PROFILE = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "medium",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: ["act now"],
  signature_phrases: ["small batch"],
  sample_sentences: [
    "Miss you — fancy giving our new flavour a try?",
    "It's been a minute. Anything we can sort out for you?",
    "Quiet round here without you. Pop back any time.",
    "We thought of you when this batch landed.",
    "No pressure — just a hello and a 10% link if you want it.",
  ],
};

function makeToolUseResponse(input: unknown, usage = { input_tokens: 1200, output_tokens: 350 }) {
  return {
    content: [{ type: "tool_use", id: "tu_test", name: "extract_brand_voice", input }],
    usage,
  };
}

function mockClient(
  responses:
    | { input: unknown; usage?: { input_tokens: number; output_tokens: number } }
    | Array<{ input?: unknown; throws?: Error; usage?: { input_tokens: number; output_tokens: number } }>,
): Anthropic {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return {
    messages: {
      create: vi.fn().mockImplementation(async () => {
        const next = queue.shift();
        if (!next) throw new Error("mock exhausted");
        if ("throws" in next && next.throws) throw next.throws;
        return makeToolUseResponse(next.input, next.usage);
      }),
    },
  } as unknown as Anthropic;
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesizeVoice — happy path", () => {
  it("returns a parsed VoiceProfile, token counts, and retries=0", async () => {
    const client = mockClient({ input: VALID_PROFILE });
    const result = await synthesizeVoice(client, {
      redactedCorpus: "About us... we make small batch granola.",
    });
    expect(result.profile.tone_descriptors).toEqual(["warm", "playful", "down_to_earth"]);
    expect(result.profile.sentence_length).toBe("medium");
    expect(result.profile.sample_sentences).toHaveLength(5);
    expect(result.tokensInput).toBe(1200);
    expect(result.tokensOutput).toBe(350);
    expect(result.retries).toBe(0);
    expect(result.modelVersion).toBe(SONNET_MODEL_DEFAULT);
    expect(result.promptVersion).toBe(PROMPT_VERSION);
  });

  it("passes tools + tool_choice to the API call (decision 9 — structured output)", async () => {
    const client = mockClient({ input: VALID_PROFILE });
    await synthesizeVoice(client, { redactedCorpus: "x" });
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools[0].name).toBe("extract_brand_voice");
    expect(callArgs.tool_choice).toMatchObject({ type: "tool", name: "extract_brand_voice" });
  });

  it("uses Sonnet by default (decision 9)", async () => {
    const client = mockClient({ input: VALID_PROFILE });
    await synthesizeVoice(client, { redactedCorpus: "x" });
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe(SONNET_MODEL_DEFAULT);
  });

  it("allows model override for replay scenarios", async () => {
    const client = mockClient({ input: VALID_PROFILE });
    const result = await synthesizeVoice(client, {
      redactedCorpus: "x",
      model: "claude-sonnet-4-6-20251022",
    });
    expect(result.modelVersion).toBe("claude-sonnet-4-6-20251022");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry behaviour (decision 9)
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesizeVoice — retries", () => {
  it("retries on schema validation failure and accumulates tokens across attempts", async () => {
    const badProfile = { ...VALID_PROFILE, tone_descriptors: ["unknown_tone"] };
    const client = mockClient([
      { input: badProfile, usage: { input_tokens: 1200, output_tokens: 80 } },
      { input: VALID_PROFILE, usage: { input_tokens: 1100, output_tokens: 320 } },
    ]);
    const result = await runWithTimers(() =>
      synthesizeVoice(client, { redactedCorpus: "x" }),
    );
    expect(result.retries).toBe(1);
    expect(result.tokensInput).toBe(2300);
    expect(result.tokensOutput).toBe(400);
  });

  it("retries on transient API errors", async () => {
    const client = mockClient([
      { throws: new Error("503 service unavailable") },
      { input: VALID_PROFILE },
    ]);
    const result = await runWithTimers(() =>
      synthesizeVoice(client, { redactedCorpus: "x" }),
    );
    expect(result.retries).toBe(1);
  });

  it("throws VoiceSynthesisError after exhausting MAX_RETRIES schema failures", async () => {
    const bad = { ...VALID_PROFILE, sentence_length: "extra_long" };
    const client = mockClient([
      { input: bad, usage: { input_tokens: 100, output_tokens: 10 } },
      { input: bad, usage: { input_tokens: 100, output_tokens: 10 } },
      { input: bad, usage: { input_tokens: 100, output_tokens: 10 } },
    ]);
    await expect(
      runWithTimers(() => synthesizeVoice(client, { redactedCorpus: "x" })),
    ).rejects.toThrow(VoiceSynthesisError);
  });

  it("propagates `reason: schema_validation` on exhausted schema failures with accumulated usage", async () => {
    const bad = { ...VALID_PROFILE, register: "bogus" };
    const client = mockClient([
      { input: bad, usage: { input_tokens: 100, output_tokens: 10 } },
      { input: bad, usage: { input_tokens: 110, output_tokens: 12 } },
      { input: bad, usage: { input_tokens: 120, output_tokens: 14 } },
    ]);
    try {
      await runWithTimers(() => synthesizeVoice(client, { redactedCorpus: "x" }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceSynthesisError);
      const e = err as VoiceSynthesisError;
      expect(e.reason).toBe("schema_validation");
      expect(e.tokensInput).toBe(330);
      expect(e.tokensOutput).toBe(36);
      // `cause` must surface the underlying Zod failure for orchestrator logging.
      expect(e.cause).toBeInstanceOf(Error);
    }
  });

  it("propagates `reason: no_tool_use_block` and accumulates tokens across all 3 attempts", async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "I cannot help with that." }],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      },
    } as unknown as Anthropic;
    try {
      await runWithTimers(() => synthesizeVoice(client, { redactedCorpus: "x" }));
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as VoiceSynthesisError;
      expect(e.reason).toBe("no_tool_use_block");
      expect(e.tokensInput).toBe(300);
      expect(e.tokensOutput).toBe(60);
    }
    expect(
      (client.messages.create as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(3);
  });

  it("propagates `reason: transient_api` on exhausted transient errors", async () => {
    const client = mockClient([
      { throws: new Error("503 a") },
      { throws: new Error("503 b") },
      { throws: new Error("503 c") },
    ]);
    try {
      await runWithTimers(() => synthesizeVoice(client, { redactedCorpus: "x" }));
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as VoiceSynthesisError;
      expect(e.reason).toBe("transient_api");
      expect((e.cause as Error)?.message).toMatch(/503/);
    }
  });

  it("does NOT retry permanent errors (401 auth) — short-circuits with reason=permanent_api", async () => {
    const authError = Object.assign(new Error("invalid api key"), { status: 401 });
    const client = {
      messages: { create: vi.fn().mockRejectedValue(authError) },
    } as unknown as Anthropic;
    try {
      await runWithTimers(() => synthesizeVoice(client, { redactedCorpus: "x" }));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as VoiceSynthesisError).reason).toBe("permanent_api");
    }
    expect(
      (client.messages.create as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });

  it("does NOT retry permanent errors (400 BadRequest by name) — short-circuits", async () => {
    const badReq = Object.assign(new Error("bad model name"), {
      name: "BadRequestError",
    });
    const client = {
      messages: { create: vi.fn().mockRejectedValue(badReq) },
    } as unknown as Anthropic;
    await expect(
      runWithTimers(() => synthesizeVoice(client, { redactedCorpus: "x" })),
    ).rejects.toMatchObject({ reason: "permanent_api" });
    expect(
      (client.messages.create as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backoff between retries (decision 9 — exponential backoff with jitter)
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesizeVoice — backoff", () => {
  it("delays at least BACKOFF_BASE_MS between retries", async () => {
    const client = mockClient([
      { throws: new Error("503 a") },
      { throws: new Error("503 b") },
      { input: VALID_PROFILE },
    ]);
    const promise = synthesizeVoice(client, { redactedCorpus: "x" });
    // First attempt fires immediately; subsequent attempts wait for the backoff.
    // Without timer advance, the second attempt should NOT have been issued yet.
    await Promise.resolve();
    expect(
      (client.messages.create as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(1);
    await vi.runAllTimersAsync();
    await promise;
    expect(
      (client.messages.create as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decision 10 — PII pre-flight gate is enforced at the synthesizer boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("synthesizeVoice — PII pre-flight gate (decision 10)", () => {
  it("throws VoiceSynthesisError(pii_leak) without calling Anthropic when corpus contains PII", async () => {
    const client = {
      messages: { create: vi.fn() },
    } as unknown as Anthropic;
    try {
      await runWithTimers(() =>
        synthesizeVoice(client, {
          redactedCorpus: "Contact us at leaks@example.com — please.",
        }),
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as VoiceSynthesisError).reason).toBe("pii_leak");
    }
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema validation
// ─────────────────────────────────────────────────────────────────────────────

describe("parseVoiceProfile — schema strictness", () => {
  it("accepts a valid profile", () => {
    expect(() => parseVoiceProfile(VALID_PROFILE)).not.toThrow();
  });

  it("rejects fewer than 3 tone descriptors", () => {
    expect(() =>
      parseVoiceProfile({ ...VALID_PROFILE, tone_descriptors: ["warm", "playful"] }),
    ).toThrow();
  });

  it("rejects more than 5 tone descriptors", () => {
    expect(() =>
      parseVoiceProfile({
        ...VALID_PROFILE,
        tone_descriptors: TONE_TAXONOMY.slice(0, 6) as readonly string[],
      }),
    ).toThrow();
  });

  it("rejects tone descriptors outside the taxonomy enum (decision 11)", () => {
    expect(() =>
      parseVoiceProfile({ ...VALID_PROFILE, tone_descriptors: ["warm", "spicy", "down_to_earth"] }),
    ).toThrow();
  });

  it("rejects sentence_length outside the enum", () => {
    expect(() => parseVoiceProfile({ ...VALID_PROFILE, sentence_length: "tiny" })).toThrow();
  });

  it("rejects register outside the enum", () => {
    expect(() => parseVoiceProfile({ ...VALID_PROFILE, register: "rude" })).toThrow();
  });

  it("rejects emoji_policy outside the enum", () => {
    expect(() => parseVoiceProfile({ ...VALID_PROFILE, emoji_policy: "sometimes" })).toThrow();
  });

  it("rejects fewer than 5 sample sentences", () => {
    expect(() =>
      parseVoiceProfile({ ...VALID_PROFILE, sample_sentences: VALID_PROFILE.sample_sentences.slice(0, 4) }),
    ).toThrow();
  });

  it("rejects more than 5 sample sentences", () => {
    expect(() =>
      parseVoiceProfile({
        ...VALID_PROFILE,
        sample_sentences: [...VALID_PROFILE.sample_sentences, "extra"],
      }),
    ).toThrow();
  });

  it("rejects empty signature_phrases array", () => {
    expect(() => parseVoiceProfile({ ...VALID_PROFILE, signature_phrases: [] })).toThrow();
  });

  it("rejects more than 5 signature_phrases", () => {
    expect(() =>
      parseVoiceProfile({
        ...VALID_PROFILE,
        signature_phrases: ["a", "b", "c", "d", "e", "f"],
      }),
    ).toThrow();
  });

  it("rejects more than 10 forbidden_phrases", () => {
    expect(() =>
      parseVoiceProfile({
        ...VALID_PROFILE,
        forbidden_phrases: Array.from({ length: 11 }, (_, i) => `p${i}`),
      }),
    ).toThrow();
  });

  it("defaults forbidden_phrases to an empty array when omitted", () => {
    const { forbidden_phrases: _omit, ...rest } = VALID_PROFILE;
    const parsed = parseVoiceProfile(rest);
    expect(parsed.forbidden_phrases).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt version stability (decision 8 — replay reproducibility)
// ─────────────────────────────────────────────────────────────────────────────

describe("PROMPT_VERSION", () => {
  it("is a 16-character hex string", () => {
    expect(PROMPT_VERSION).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is pinned to the known literal so prompt edits break CI loudly", () => {
    // If you intentionally edit SYSTEM_PROMPT_TEMPLATE, update this literal too —
    // and document the algorithm change in HANDOFF + open a follow-up to replay
    // any voice_versions that depend on the prior prompt (decision 8).
    expect(PROMPT_VERSION).toBe("57ffb74af71b3063");
  });

  it("is stable across re-import within the process", () => {
    return import("../src/voice-synthesizer").then((reimport) => {
      expect(reimport.PROMPT_VERSION).toBe(PROMPT_VERSION);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createVoiceClient — SDK retries are explicitly disabled so the in-process
// loop is the only retry policy (token usage must accumulate per attempt).
// ─────────────────────────────────────────────────────────────────────────────

describe("createVoiceClient", () => {
  it("constructs an Anthropic SDK client with maxRetries=0", () => {
    const client = createVoiceClient({ apiKey: "sk-test" });
    // The SDK exposes maxRetries on the client instance.
    const maxRetries = (client as unknown as { maxRetries?: number }).maxRetries;
    expect(maxRetries).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decision 9 — strict tool_choice forces structured output, no text fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("decision 9 — structured output is mandatory", () => {
  it("sends tools[0].input_schema with all required fields enumerated", async () => {
    const client = mockClient({ input: VALID_PROFILE });
    await synthesizeVoice(client, { redactedCorpus: "x" });
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const schema = callArgs.tools[0].input_schema;
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "tone_descriptors",
        "sentence_length",
        "register",
        "emoji_policy",
        "signature_phrases",
        "sample_sentences",
      ]),
    );
  });

  it("sends max_tokens=MAX_OUTPUT_TOKENS to bound the response (no runaway cost)", async () => {
    const client = mockClient({ input: VALID_PROFILE });
    await synthesizeVoice(client, { redactedCorpus: "x" });
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });
});
