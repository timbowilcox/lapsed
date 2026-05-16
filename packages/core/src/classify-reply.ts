// Inbound reply classifier — one Sonnet 4.6 call per inbound SMS.
// Implements Sprint 07 chunk 4. Classifies a customer's inbound reply into a
// structured { sentiment, intent, confidence } shape via tool_choice. The
// inbound webhook (chunk 7) feeds the result into two decisions:
//   - intent === "opt_out" with confidence > OPT_OUT_CONFIDENCE_THRESHOLD
//     triggers a Sonnet-classified opt-out (decision 18)
//   - sentiment + intent drive the bandit posterior update (decision 19)
//
// Mirrors voice-synthesizer.ts (decision 9 — structured output, bounded
// retries, token accounting) but with a TIGHTER retry budget: classification
// runs inside the inbound webhook's 5s p99 latency budget (decision 17), so
// MAX_CLASSIFY_ATTEMPTS is 2, not the voice pipeline's 3.
//
// Decision 10 (PII redaction before any LLM call): classifyReply asserts no
// PII patterns survive in the input at its own boundary — the caller passes
// the ALREADY-redacted inbound body, and assertNoPii is the defense-in-depth
// gate so the classifier can never be misused to ship raw PII to Sonnet.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { assertNoPii } from "./pii-redactor";
import { SONNET_MODEL_DEFAULT } from "./voice-synthesizer";

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Total classification attempts (NOT retries — the loop runs `attempt` from 0
 * to this bound). 2 means one initial try plus one retry — "≤2 attempts" per
 * SPRINT.md chunk 4. Tighter than the voice pipeline's 3 because classification
 * runs inside the inbound webhook's 5s p99 budget (decision 17).
 */
export const MAX_CLASSIFY_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 512;
const BACKOFF_BASE_MS = 150;
const BACKOFF_MAX_MS = 1000;

/**
 * Confidence floor for acting on a Sonnet-classified `opt_out` intent. The
 * inbound webhook records a non-keyword opt-out only when intent is `opt_out`
 * AND confidence exceeds this threshold — a low-confidence opt_out guess does
 * not silently suppress a customer. STOP-keyword opt-outs bypass the
 * classifier entirely and are not subject to this threshold.
 */
export const OPT_OUT_CONFIDENCE_THRESHOLD = 0.7;

// ─────────────────────────────────────────────────────────────────────────────
// Classification shape
// ─────────────────────────────────────────────────────────────────────────────

export const REPLY_SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type ReplySentiment = (typeof REPLY_SENTIMENTS)[number];

export const REPLY_INTENTS = [
  "engagement",
  "purchase",
  "question",
  "complaint",
  "opt_out",
  "other",
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export interface ReplyClassification {
  sentiment: ReplySentiment;
  intent: ReplyIntent;
  /** Model's self-reported confidence in [0, 1]. */
  confidence: number;
  /** Short rationale (<= 200 chars). Optional — for the audit trail / UI. */
  reasoning?: string;
}

const ReplyClassificationSchema = z.object({
  sentiment: z.enum(REPLY_SENTIMENTS),
  intent: z.enum(REPLY_INTENTS),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic structured-output tool (decision 9 — strict schema)
// ─────────────────────────────────────────────────────────────────────────────

const CLASSIFY_TOOL_NAME = "classify_reply";

const CLASSIFY_TOOL = {
  name: CLASSIFY_TOOL_NAME,
  description:
    "Classify the sentiment and intent of a customer's inbound SMS reply to a win-back message.",
  input_schema: {
    type: "object" as const,
    required: ["sentiment", "intent", "confidence"],
    additionalProperties: false,
    properties: {
      sentiment: { type: "string", enum: [...REPLY_SENTIMENTS] },
      intent: { type: "string", enum: [...REPLY_INTENTS] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reasoning: { type: "string", maxLength: 200 },
    },
  },
};

export const CLASSIFY_SYSTEM_PROMPT = `You classify a single inbound SMS reply from a customer who received a win-back message from a Shopify merchant. Return your answer via the classify_reply tool.

sentiment:
- positive: the customer is receptive, interested, pleased, or thankful
- neutral: factual, ambiguous, or non-committal with no clear emotional valence
- negative: annoyed, frustrated, dismissive, or complaining

intent (pick the single best fit):
- engagement: wants to keep talking, asks to hear more, expresses interest without a concrete buy
- purchase: signals readiness to buy, asks how to order, or accepts an offer
- question: asks a specific question (product, shipping, the offer terms)
- complaint: raises a problem, grievance, or dissatisfaction
- opt_out: asks to stop being contacted, in any phrasing (e.g. "leave me alone", "stop texting me", "remove me"). The literal keyword STOP is handled elsewhere — classify intent-based opt-out requests here.
- other: greetings, wrong-number replies, gibberish, or anything that fits none of the above

confidence: your calibrated confidence in [0, 1] for the sentiment+intent pair. Use a value below 0.7 when the reply is genuinely ambiguous.

reasoning: at most 200 characters, plain language, no customer PII.

The reply has had emails / phone numbers / personal names redacted to [email] / [phone] / [name] placeholders — classify the redacted text as-is; do not speculate about what was redacted.`;

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifyReplyInput {
  /**
   * The PII-REDACTED inbound message body. The caller MUST redact before
   * calling; classifyReply runs assertNoPii on it as a defense-in-depth gate
   * (decision 10) and throws ClassifyReplyError("pii_leak") if PII survives.
   */
  redactedBody: string;
  /** Optional model override; defaults to SONNET_MODEL_DEFAULT. */
  model?: string;
}

export interface ClassifyReplyResult {
  classification: ReplyClassification;
  modelVersion: string;
  tokensInput: number;
  tokensOutput: number;
  retries: number;
}

export type ClassifyReplyReason =
  | "no_tool_use_block"
  | "schema_validation"
  | "exhausted_retries"
  | "transient_api"
  | "permanent_api"
  | "pii_leak"
  | "empty_body";

export class ClassifyReplyError extends Error {
  readonly reason: ClassifyReplyReason;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  override readonly cause: unknown;
  constructor(
    reason: ClassifyReplyReason,
    message: string,
    opts: { tokensInput?: number; tokensOutput?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ClassifyReplyError";
    this.reason = reason;
    this.tokensInput = opts.tokensInput ?? 0;
    this.tokensOutput = opts.tokensOutput ?? 0;
    this.cause = opts.cause;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client factory
// ─────────────────────────────────────────────────────────────────────────────

export interface ClassifyClientOptions {
  apiKey: string;
  /** Per-request timeout. Defaults to 15s; the webhook also races a 4s budget. */
  timeoutMs?: number;
}

export function createClassifyClient(opts: ClassifyClientOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 15_000,
    // Retries owned by the loop below so token usage accumulates across them.
    maxRetries: 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// classifyReply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies one inbound reply. Retries up to MAX_CLASSIFY_ATTEMPTS on
 * schema-validation failures, missing-tool_use responses, and transient
 * Anthropic errors (5xx / rate-limit / network). Permanent errors (auth /
 * bad-request / not-found) short-circuit immediately. Token usage accumulates
 * across attempts (decision 9). Throws ClassifyReplyError on final failure.
 *
 * Decision 10 gate: asserts no PII patterns are detectable in
 * `input.redactedBody` before the first Anthropic call.
 */
export async function classifyReply(
  client: Anthropic,
  input: ClassifyReplyInput,
): Promise<ClassifyReplyResult> {
  const body = input.redactedBody.trim();
  if (body.length === 0) {
    throw new ClassifyReplyError("empty_body", "inbound body is empty after trim");
  }

  // Decision-10 defense-in-depth gate.
  try {
    assertNoPii(body);
  } catch (err) {
    throw new ClassifyReplyError("pii_leak", "PII detected in inbound body before LLM call", {
      cause: err,
    });
  }

  const model = input.model ?? SONNET_MODEL_DEFAULT;
  let tokensInput = 0;
  let tokensOutput = 0;
  let lastError: Error | null = null;
  let lastReason: ClassifyReplyReason = "exhausted_retries";

  for (let attempt = 0; attempt < MAX_CLASSIFY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(computeBackoffMs(attempt));
    try {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: body }],
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: "tool", name: CLASSIFY_TOOL_NAME },
      });

      tokensInput += response.usage.input_tokens;
      tokensOutput += response.usage.output_tokens;

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        lastError = new Error("Sonnet response did not contain a tool_use block");
        lastReason = "no_tool_use_block";
        continue;
      }

      const parsed = ReplyClassificationSchema.safeParse(toolBlock.input);
      if (!parsed.success) {
        lastError = parsed.error;
        lastReason = "schema_validation";
        continue;
      }

      return {
        classification: parsed.data,
        modelVersion: model,
        tokensInput,
        tokensOutput,
        retries: attempt,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      if (isPermanentAnthropicError(e)) {
        throw new ClassifyReplyError("permanent_api", `Permanent Anthropic error: ${e.message}`, {
          tokensInput,
          tokensOutput,
          cause: e,
        });
      }
      lastReason = "transient_api";
    }
  }

  throw new ClassifyReplyError(
    lastReason,
    `Reply classification failed after ${MAX_CLASSIFY_ATTEMPTS} attempts: ${lastError?.message ?? "unknown"}`,
    { tokensInput, tokensOutput, cause: lastError },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parses a candidate classification object via the Zod schema. Pure. */
export function parseReplyClassification(input: unknown): ReplyClassification {
  return ReplyClassificationSchema.parse(input);
}

function isPermanentAnthropicError(err: Error): boolean {
  const anyErr = err as unknown as { status?: number; name?: string };
  if (typeof anyErr.status === "number") {
    if (anyErr.status === 401 || anyErr.status === 403 || anyErr.status === 404) return true;
    if (anyErr.status === 400) return true;
  }
  const name = anyErr.name ?? "";
  return (
    name === "AuthenticationError" ||
    name === "PermissionDeniedError" ||
    name === "BadRequestError" ||
    name === "NotFoundError"
  );
}

function computeBackoffMs(attempt: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * BACKOFF_BASE_MS);
  return Math.min(raw + jitter, BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
