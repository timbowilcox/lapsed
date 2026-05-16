import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyReply,
  parseReplyClassification,
  ClassifyReplyError,
  createClassifyClient,
  MAX_CLASSIFY_ATTEMPTS,
  OPT_OUT_CONFIDENCE_THRESHOLD,
} from "../src/classify-reply";
import { SONNET_MODEL_DEFAULT } from "../src/voice-synthesizer";
import type Anthropic from "@anthropic-ai/sdk";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Run `fn` and advance fake timers until it resolves. */
async function runWithTimers<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  promise.then(
    () => undefined,
    () => undefined,
  );
  await vi.runAllTimersAsync();
  return promise;
}

function makeToolUseResponse(input: unknown, usage = { input_tokens: 80, output_tokens: 40 }) {
  return {
    content: [{ type: "tool_use", id: "tu_test", name: "classify_reply", input }],
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
          return { content: [{ type: "text", text: "no tool here" }], usage: { input_tokens: 10, output_tokens: 5 } };
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
// Happy path — the six intent values + the three sentiments
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReply — happy path", () => {
  it("classifies a positive engagement reply", async () => {
    const client = mockClient([
      { input: { sentiment: "positive", intent: "engagement", confidence: 0.9, reasoning: "wants to hear more" } },
    ]);
    const result = await runWithTimers(() =>
      classifyReply(client, { redactedBody: "ooh tell me more about that" }),
    );
    expect(result.classification.sentiment).toBe("positive");
    expect(result.classification.intent).toBe("engagement");
    expect(result.classification.confidence).toBe(0.9);
    expect(result.retries).toBe(0);
    expect(result.modelVersion).toBe(SONNET_MODEL_DEFAULT);
    expect(result.tokensInput).toBe(80);
    expect(result.tokensOutput).toBe(40);
  });

  it("classifies a positive purchase-intent reply", async () => {
    const client = mockClient([
      { input: { sentiment: "positive", intent: "purchase", confidence: 0.95 } },
    ]);
    const result = await runWithTimers(() =>
      classifyReply(client, { redactedBody: "yes! how do I order" }),
    );
    expect(result.classification.intent).toBe("purchase");
  });

  it("classifies a high-confidence opt-out intent", async () => {
    const client = mockClient([
      { input: { sentiment: "negative", intent: "opt_out", confidence: 0.92 } },
    ]);
    const result = await runWithTimers(() =>
      classifyReply(client, { redactedBody: "please leave me alone" }),
    );
    expect(result.classification.intent).toBe("opt_out");
    expect(result.classification.confidence).toBeGreaterThan(OPT_OUT_CONFIDENCE_THRESHOLD);
  });

  it("classifies a negative complaint", async () => {
    const client = mockClient([
      { input: { sentiment: "negative", intent: "complaint", confidence: 0.85 } },
    ]);
    const result = await runWithTimers(() =>
      classifyReply(client, { redactedBody: "my last order never arrived and nobody helped" }),
    );
    expect(result.classification.sentiment).toBe("negative");
    expect(result.classification.intent).toBe("complaint");
  });

  it("classifies an ambiguous neutral reply with low confidence", async () => {
    const client = mockClient([
      { input: { sentiment: "neutral", intent: "other", confidence: 0.42, reasoning: "ambiguous" } },
    ]);
    const result = await runWithTimers(() =>
      classifyReply(client, { redactedBody: "hmm" }),
    );
    expect(result.classification.sentiment).toBe("neutral");
    expect(result.classification.confidence).toBeLessThan(OPT_OUT_CONFIDENCE_THRESHOLD);
  });

  it("classifies a question intent", async () => {
    const client = mockClient([
      { input: { sentiment: "neutral", intent: "question", confidence: 0.8 } },
    ]);
    const result = await runWithTimers(() =>
      classifyReply(client, { redactedBody: "how much is shipping" }),
    );
    expect(result.classification.intent).toBe("question");
  });

  it("passes tools + tool_choice to the API (decision 9 — structured output)", async () => {
    const client = mockClient([{ input: { sentiment: "neutral", intent: "other", confidence: 0.5 } }]);
    await runWithTimers(() => classifyReply(client, { redactedBody: "ok" }));
    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.tools[0].name).toBe("classify_reply");
    expect(callArgs.tool_choice).toMatchObject({ type: "tool", name: "classify_reply" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Retry behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReply — retries", () => {
  it("retries a schema-invalid response and accumulates tokens", async () => {
    const client = mockClient([
      { input: { sentiment: "ecstatic", intent: "purchase", confidence: 0.9 }, usage: { input_tokens: 80, output_tokens: 40 } },
      { input: { sentiment: "positive", intent: "purchase", confidence: 0.9 }, usage: { input_tokens: 81, output_tokens: 41 } },
    ]);
    const result = await runWithTimers(() => classifyReply(client, { redactedBody: "yes please" }));
    expect(result.classification.sentiment).toBe("positive");
    expect(result.retries).toBe(1);
    expect(result.tokensInput).toBe(161);
    expect(result.tokensOutput).toBe(81);
  });

  it("retries a missing-tool_use response", async () => {
    const client = mockClient([
      { noTool: true },
      { input: { sentiment: "neutral", intent: "other", confidence: 0.5 } },
    ]);
    const result = await runWithTimers(() => classifyReply(client, { redactedBody: "ok" }));
    expect(result.retries).toBe(1);
  });

  it("makes at most MAX_CLASSIFY_ATTEMPTS attempts then throws", async () => {
    const client = mockClient([{ noTool: true }, { noTool: true }, { noTool: true }]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "ok" })),
    ).rejects.toBeInstanceOf(ClassifyReplyError);
    expect((client.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      MAX_CLASSIFY_ATTEMPTS,
    );
  });

  it("exhausts retries on persistent schema failures with reason schema_validation", async () => {
    const client = mockClient([
      { input: { sentiment: "x", intent: "y", confidence: 2 } },
      { input: { sentiment: "x", intent: "y", confidence: 2 } },
    ]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "ok" })),
    ).rejects.toMatchObject({ name: "ClassifyReplyError", reason: "schema_validation" });
  });

  it("retries a transient API error then succeeds", async () => {
    const client = mockClient([
      { throws: anthropicError(503, "service unavailable") },
      { input: { sentiment: "positive", intent: "engagement", confidence: 0.7 } },
    ]);
    const result = await runWithTimers(() => classifyReply(client, { redactedBody: "sure" }));
    expect(result.classification.sentiment).toBe("positive");
    expect(result.retries).toBe(1);
  });

  it("retries a 429 rate-limit error then succeeds", async () => {
    const client = mockClient([
      { throws: anthropicError(429, "rate limited") },
      { input: { sentiment: "neutral", intent: "other", confidence: 0.5 } },
    ]);
    const result = await runWithTimers(() => classifyReply(client, { redactedBody: "ok" }));
    expect(result.classification.intent).toBe("other");
  });

  it("exhausts retries on a persistent transient API error with reason transient_api", async () => {
    const client = mockClient([
      { throws: anthropicError(503) },
      { throws: anthropicError(503) },
    ]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "ok" })),
    ).rejects.toMatchObject({ name: "ClassifyReplyError", reason: "transient_api" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Permanent errors
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReply — permanent errors", () => {
  it("short-circuits on a 400 with reason permanent_api", async () => {
    const client = mockClient([{ throws: anthropicError(400, "bad request") }]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "ok" })),
    ).rejects.toMatchObject({ name: "ClassifyReplyError", reason: "permanent_api" });
    // permanent error stops after the first attempt — no retry
    expect((client.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("short-circuits on a 401 auth error", async () => {
    const client = mockClient([{ throws: anthropicError(401) }]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "ok" })),
    ).rejects.toMatchObject({ reason: "permanent_api" });
  });

  it("short-circuits on a name-based permanent error with no HTTP status", async () => {
    const named = new Error("auth failed");
    named.name = "AuthenticationError";
    const client = mockClient([{ throws: named }]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "ok" })),
    ).rejects.toMatchObject({ reason: "permanent_api" });
  });

  it("carries tokens accumulated before a permanent error into the thrown error", async () => {
    // A transient failure (no tokens) then a permanent error: the permanent
    // error itself contributes no usage, so accumulated tokens stay 0 — but
    // the error must still carry the token fields rather than be undefined.
    const client = mockClient([{ throws: anthropicError(400, "bad request") }]);
    try {
      await runWithTimers(() => classifyReply(client, { redactedBody: "ok" }));
      throw new Error("expected classifyReply to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifyReplyError);
      const e = err as ClassifyReplyError;
      expect(typeof e.tokensInput).toBe("number");
      expect(typeof e.tokensOutput).toBe("number");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation + PII gate (decision 10)
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReply — input validation", () => {
  it("throws empty_body for an empty string", async () => {
    const client = mockClient([]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "" })),
    ).rejects.toMatchObject({ reason: "empty_body" });
  });

  it("throws empty_body for whitespace only", async () => {
    const client = mockClient([]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "   \n\t " })),
    ).rejects.toMatchObject({ reason: "empty_body" });
  });

  it("throws pii_leak when the body still contains an un-redacted phone number", async () => {
    const client = mockClient([]);
    await expect(
      runWithTimers(() =>
        classifyReply(client, { redactedBody: "call me on +1 415 555 9876" }),
      ),
    ).rejects.toMatchObject({ name: "ClassifyReplyError", reason: "pii_leak" });
  });

  it("throws pii_leak when the body still contains an un-redacted email", async () => {
    const client = mockClient([]);
    await expect(
      runWithTimers(() =>
        classifyReply(client, { redactedBody: "email me at jane@example.com" }),
      ),
    ).rejects.toMatchObject({ reason: "pii_leak" });
  });

  it("does not call the API when the PII gate fails", async () => {
    const client = mockClient([]);
    await expect(
      runWithTimers(() => classifyReply(client, { redactedBody: "ring +1 415 555 9876" })),
    ).rejects.toBeInstanceOf(ClassifyReplyError);
    expect((client.messages.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("accepts a body with redaction placeholders", async () => {
    const client = mockClient([
      { input: { sentiment: "neutral", intent: "question", confidence: 0.6 } },
    ]);
    const result = await runWithTimers(() =>
      classifyReply(client, { redactedBody: "you can reach [name] at [phone]" }),
    );
    expect(result.classification.intent).toBe("question");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseReplyClassification + exported constants
// ─────────────────────────────────────────────────────────────────────────────

describe("parseReplyClassification", () => {
  it("parses a valid classification", () => {
    const c = parseReplyClassification({ sentiment: "positive", intent: "purchase", confidence: 0.8 });
    expect(c.intent).toBe("purchase");
  });

  it("rejects an out-of-range confidence", () => {
    expect(() =>
      parseReplyClassification({ sentiment: "positive", intent: "purchase", confidence: 1.5 }),
    ).toThrow();
  });

  it("rejects an unknown sentiment", () => {
    expect(() =>
      parseReplyClassification({ sentiment: "elated", intent: "purchase", confidence: 0.5 }),
    ).toThrow();
  });

  it("rejects reasoning longer than 200 characters", () => {
    expect(() =>
      parseReplyClassification({
        sentiment: "positive",
        intent: "purchase",
        confidence: 0.5,
        reasoning: "x".repeat(201),
      }),
    ).toThrow();
  });
});

describe("classify-reply constants", () => {
  it("MAX_CLASSIFY_ATTEMPTS is 2 — tighter than the voice pipeline (decision 17)", () => {
    expect(MAX_CLASSIFY_ATTEMPTS).toBe(2);
  });

  it("OPT_OUT_CONFIDENCE_THRESHOLD is 0.7", () => {
    expect(OPT_OUT_CONFIDENCE_THRESHOLD).toBe(0.7);
  });

  it("createClassifyClient builds a client without throwing", () => {
    expect(() => createClassifyClient({ apiKey: "sk-test" })).not.toThrow();
  });
});
