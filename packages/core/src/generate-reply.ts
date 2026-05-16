// Reply generator — one Sonnet 4.6 call per inbound SMS that produces the
// agent's contextual reply. Implements Sprint 07 chunk 5.
//
// Inputs: the classified inbound (sentiment + intent from chunk 4), the
// conversation history (last 10 messages — decision 16 keeps the thread
// per-customer, so history spans every campaign), the merchant's active
// brand voice profile (Sprint 05 voice_versions), and lightweight customer
// context (lifecycle stage, last order, propensity).
//
// Decision 9: structured output via tool_choice, bounded retries, token
// accounting. Decision 10 (PII): assertNoPii gates the assembled input AND
// the generated output — the output gate catches a hallucinated phone number
// or email address Sonnet might invent, which is the defense-in-depth case
// SPRINT.md chunk 5 calls out explicitly.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { assertNoPii } from "./pii-redactor";
import { SONNET_MODEL_DEFAULT, type VoiceProfile } from "./voice-synthesizer";
import type { ReplyClassification } from "./classify-reply";

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/** Total generation attempts (one try + one retry). Bounded for decision 17. */
export const MAX_GENERATE_ATTEMPTS = 2;
const MAX_OUTPUT_TOKENS = 512;
const BACKOFF_BASE_MS = 150;
const BACKOFF_MAX_MS = 1000;

/** Last N messages of the thread fed to the model as context (SPRINT.md). */
export const REPLY_HISTORY_LIMIT = 10;

/**
 * Hard cap on a generated reply — 2 SMS segments (SPRINT.md chunk 5). 320
 * assumes GSM-7 encoding (160 chars/segment). A reply containing emoji or
 * other non-GSM-7 characters encodes as UCS-2 (70 chars/segment), so 320
 * code units could exceed 2 segments — acceptable for v1 because the brand
 * voice `emoji_policy` is usually "never"/"rare"; revisit if emoji-heavy
 * voices appear.
 */
export const REPLY_BODY_MAX_CHARS = 320;

// ─────────────────────────────────────────────────────────────────────────────
// Reply shape
// ─────────────────────────────────────────────────────────────────────────────

export const NEXT_ACTIONS = ["continue", "offer", "wait", "hand_off"] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

export interface GeneratedReply {
  body: string;
  /** Whether the merchant's sign-off should be appended. Defaults to false. */
  include_signature: boolean;
  /** The agent's recommended next step. Defaults to "continue". */
  suggested_next_action: NextAction;
}

const GeneratedReplySchema = z.object({
  body: z.string().min(1).max(REPLY_BODY_MAX_CHARS),
  include_signature: z.boolean().default(false),
  suggested_next_action: z.enum(NEXT_ACTIONS).default("continue"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic structured-output tool (decision 9 — strict schema)
// ─────────────────────────────────────────────────────────────────────────────

const GENERATE_TOOL_NAME = "generate_reply";

const GENERATE_TOOL = {
  name: GENERATE_TOOL_NAME,
  description:
    "Write the agent's next SMS reply in the merchant's brand voice, given the conversation so far.",
  input_schema: {
    type: "object" as const,
    required: ["body"],
    additionalProperties: false,
    properties: {
      body: { type: "string", maxLength: REPLY_BODY_MAX_CHARS },
      include_signature: { type: "boolean" },
      suggested_next_action: { type: "string", enum: [...NEXT_ACTIONS] },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

/** One prior message in the thread. `redactedBody` is PII-redacted (decision 10). */
export interface ReplyHistoryMessage {
  direction: "inbound" | "outbound";
  redactedBody: string;
}

/** Lightweight customer context — no PII (lifecycle/dates/score only). */
export interface CustomerReplyContext {
  lifecycleStage: string;
  /** ISO date of the customer's last order, or null if unknown. */
  lastOrderAt?: string | null;
  /** 90-day repurchase propensity in [0, 1], or null if unscored. */
  propensity?: number | null;
}

export interface GenerateReplyInput {
  /** The chunk-4 classification of the inbound that triggered this reply. */
  classification: ReplyClassification;
  /**
   * Conversation history, oldest-first. Only the last REPLY_HISTORY_LIMIT are
   * used. Every `redactedBody` MUST already be PII-redacted by the caller;
   * generateReply asserts this at its boundary (decision 10).
   */
  conversationHistory: ReplyHistoryMessage[];
  /** The merchant's active brand voice profile (Sprint 05 voice_versions). */
  voiceProfile: VoiceProfile;
  customerContext: CustomerReplyContext;
  /** Optional model override; defaults to SONNET_MODEL_DEFAULT. */
  model?: string;
}

export interface GenerateReplyResult {
  reply: GeneratedReply;
  modelVersion: string;
  tokensInput: number;
  tokensOutput: number;
  retries: number;
}

export type GenerateReplyReason =
  | "no_tool_use_block"
  | "schema_validation"
  | "output_pii_leak"
  | "exhausted_retries"
  | "transient_api"
  | "permanent_api"
  | "input_pii_leak"
  | "empty_history";

export class GenerateReplyError extends Error {
  readonly reason: GenerateReplyReason;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  override readonly cause: unknown;
  constructor(
    reason: GenerateReplyReason,
    message: string,
    opts: { tokensInput?: number; tokensOutput?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "GenerateReplyError";
    this.reason = reason;
    this.tokensInput = opts.tokensInput ?? 0;
    this.tokensOutput = opts.tokensOutput ?? 0;
    this.cause = opts.cause;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client factory
// ─────────────────────────────────────────────────────────────────────────────

export interface GenerateClientOptions {
  apiKey: string;
  /** Per-request timeout. Defaults to 15s; the webhook also races a budget. */
  timeoutMs?: number;
}

export function createGenerateClient(opts: GenerateClientOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 15_000,
    maxRetries: 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// generateReply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates the agent's next SMS reply. Retries up to MAX_GENERATE_ATTEMPTS on
 * schema-validation failures, missing-tool_use responses, OUTPUT PII leaks
 * (a retry may produce a clean reply), and transient Anthropic errors.
 * Permanent errors short-circuit. Token usage accumulates across attempts.
 *
 * Decision 10 — two PII gates:
 *   - INPUT: every conversation-history `redactedBody` is asserted clean
 *     before the first Anthropic call. Throws GenerateReplyError("input_pii_leak").
 *   - OUTPUT: the generated `body` is asserted clean after parsing. A leak
 *     (e.g. a hallucinated phone number) fails the attempt; on exhaustion the
 *     final throw carries reason "output_pii_leak".
 */
export async function generateReply(
  client: Anthropic,
  input: GenerateReplyInput,
): Promise<GenerateReplyResult> {
  // Use only the most recent REPLY_HISTORY_LIMIT messages (oldest-first input).
  const history = input.conversationHistory.slice(-REPLY_HISTORY_LIMIT);
  if (history.length === 0) {
    throw new GenerateReplyError("empty_history", "conversation history is empty");
  }

  // Decision-10 INPUT gate — every history body must already be redacted.
  for (const msg of history) {
    try {
      assertNoPii(msg.redactedBody);
    } catch (err) {
      throw new GenerateReplyError(
        "input_pii_leak",
        "PII detected in conversation history before LLM call",
        { cause: err },
      );
    }
  }

  const model = input.model ?? SONNET_MODEL_DEFAULT;
  const systemPrompt = buildSystemPrompt(input.voiceProfile, input.customerContext);
  const userPrompt = buildUserPrompt(input.classification, history);

  let tokensInput = 0;
  let tokensOutput = 0;
  let lastError: Error | null = null;
  let lastReason: GenerateReplyReason = "exhausted_retries";

  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(computeBackoffMs(attempt));
    try {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        tools: [GENERATE_TOOL],
        tool_choice: { type: "tool", name: GENERATE_TOOL_NAME },
      });

      tokensInput += response.usage.input_tokens;
      tokensOutput += response.usage.output_tokens;

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        lastError = new Error("Sonnet response did not contain a tool_use block");
        lastReason = recordReason(lastReason, "no_tool_use_block");
        continue;
      }

      const parsed = GeneratedReplySchema.safeParse(toolBlock.input);
      if (!parsed.success) {
        lastError = parsed.error;
        lastReason = recordReason(lastReason, "schema_validation");
        continue;
      }

      // Decision-10 OUTPUT gate — catch hallucinated PII (fake phone/email).
      try {
        assertNoPii(parsed.data.body);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        lastReason = recordReason(lastReason, "output_pii_leak");
        continue;
      }

      return {
        reply: parsed.data,
        modelVersion: model,
        tokensInput,
        tokensOutput,
        retries: attempt,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      if (isPermanentAnthropicError(e)) {
        throw new GenerateReplyError("permanent_api", `Permanent Anthropic error: ${e.message}`, {
          tokensInput,
          tokensOutput,
          cause: e,
        });
      }
      lastReason = recordReason(lastReason, "transient_api");
    }
  }

  throw new GenerateReplyError(
    lastReason,
    `Reply generation failed after ${MAX_GENERATE_ATTEMPTS} attempts: ${lastError?.message ?? "unknown"}`,
    { tokensInput, tokensOutput, cause: lastError },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the system prompt from the merchant's brand voice profile + customer
 * context. The voice profile shapes tone; the customer context lets the model
 * tailor without ever seeing PII (lifecycle stage / dates / a score only).
 */
export function buildSystemPrompt(
  voice: VoiceProfile,
  context: CustomerReplyContext,
): string {
  const forbidden =
    voice.forbidden_phrases.length > 0
      ? voice.forbidden_phrases.map((p) => `"${p}"`).join(", ")
      : "(none)";
  const signature =
    voice.signature_phrases.length > 0
      ? voice.signature_phrases.map((p) => `"${p}"`).join(", ")
      : "(none)";
  return `You are an SMS win-back agent replying on behalf of a Shopify merchant. Write the merchant's next reply in their brand voice via the generate_reply tool.

BRAND VOICE:
- tone: ${voice.tone_descriptors.join(", ")}
- sentence length: ${voice.sentence_length}
- register: ${voice.register}
- emoji policy: ${voice.emoji_policy}
- signature phrases (use naturally, do not force): ${signature}
- forbidden phrases (never use): ${forbidden}

CUSTOMER CONTEXT (for tailoring only — never quote it back):
- lifecycle stage: ${context.lifecycleStage}
- last order: ${context.lastOrderAt ?? "unknown"}
- repurchase propensity: ${context.propensity ?? "unscored"}

RULES:
- The reply body must be at most ${REPLY_BODY_MAX_CHARS} characters (2 SMS segments).
- Match the brand voice exactly. Honor the emoji policy.
- Do NOT invent phone numbers, email addresses, URLs, discount codes, names, or order details. If you do not have a concrete fact, do not state one.
- Be helpful and human. Do not be pushy. Calm, never urgent.
- Set include_signature true only if a sign-off fits this turn.
- suggested_next_action: "continue" to keep the conversation, "offer" if a discount/offer is the natural next step, "wait" if the customer needs space, "hand_off" if a human should take over (a complaint you cannot resolve).
- The conversation history has had PII redacted to [email]/[phone]/[name] placeholders. Never restore or guess redacted values.`;
}

/** Builds the user prompt: the classification summary + the thread transcript. */
export function buildUserPrompt(
  classification: ReplyClassification,
  history: ReplyHistoryMessage[],
): string {
  const transcript = history
    .map((m) => `${m.direction === "inbound" ? "CUSTOMER" : "AGENT"}: ${m.redactedBody}`)
    .join("\n");
  return `The customer's latest reply was classified as sentiment="${classification.sentiment}", intent="${classification.intent}" (confidence ${classification.confidence.toFixed(2)}).

Conversation so far (oldest first):
${transcript}

Write the agent's next reply.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parses a candidate reply object via the Zod schema. Pure. */
export function parseGeneratedReply(input: unknown): GeneratedReply {
  return GeneratedReplySchema.parse(input);
}

function isPermanentAnthropicError(err: Error): boolean {
  const anyErr = err as unknown as { status?: number; name?: string };
  if (typeof anyErr.status === "number") {
    // Every 4xx EXCEPT 429 (rate limit) is permanent — retrying a 4xx within
    // the decision-17 latency budget burns the one retry for nothing.
    if (anyErr.status >= 400 && anyErr.status < 500 && anyErr.status !== 429) {
      return true;
    }
  }
  const name = anyErr.name ?? "";
  return (
    name === "AuthenticationError" ||
    name === "PermissionDeniedError" ||
    name === "BadRequestError" ||
    name === "NotFoundError"
  );
}

/**
 * Folds a new failure reason into the running `lastReason` for the final
 * exhaustion throw. A PII leak is the load-bearing safety signal: once an
 * attempt leaks PII, that reason STICKS — a later transient/schema failure on
 * a different attempt must not mask it, because the caller (the inbound
 * webhook) branches on `reason` to distinguish a safety failure from an
 * outage. Any non-PII reason is overwritable by a newer non-PII reason.
 */
function recordReason(
  current: GenerateReplyReason,
  next: GenerateReplyReason,
): GenerateReplyReason {
  if (current === "output_pii_leak" || current === "input_pii_leak") return current;
  return next;
}

function computeBackoffMs(attempt: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * BACKOFF_BASE_MS);
  return Math.min(raw + jitter, BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
