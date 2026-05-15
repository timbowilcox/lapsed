// Voice synthesizer — single Sonnet 4.6 call per merchant per
// extraction. Implements architectural decisions 9 (structured output
// with retries + exponential backoff + token accounting), 10 (PII
// pre-flight gate at the LLM-call boundary, defense in depth), and 11
// (role descriptor from a closed taxonomy enum — no freeform persona
// names accepted by the type system).
//
// The orchestrator (chunk 7) still owns:
//  - Persisting the storefront snapshot BEFORE calling this module
//  - Writing voice_extracted / extraction_failed events
//  - Materializing the result into voice_versions + agent_profiles
//  - Running PII redaction so the snapshot reaches this function clean
//
// This module enforces decision 10 at its own boundary via
// assertNoPii(input.redactedCorpus) before the first Anthropic call —
// a defense-in-depth gate so a future caller cannot bypass redaction.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertNoPii } from "./pii-redactor";

export const SONNET_MODEL_DEFAULT = "claude-sonnet-4-6-latest";
export const MAX_RETRIES = 3;
export const MAX_OUTPUT_TOKENS = 4096;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 4000;

// ─────────────────────────────────────────────────────────────────────────────
// Tone taxonomy (decision 11 — closed enum, no freeform values)
// ─────────────────────────────────────────────────────────────────────────────

export const TONE_TAXONOMY = [
  "warm",
  "witty",
  "authoritative",
  "playful",
  "aspirational",
  "down_to_earth",
  "irreverent",
  "caring",
  "direct",
  "nostalgic",
  "confident",
  "curious",
  "minimalist",
  "passionate",
  "thoughtful",
  "earnest",
  "wry",
  "polished",
  "scrappy",
  "reassuring",
] as const;

export type ToneDescriptor = (typeof TONE_TAXONOMY)[number];

export const SENTENCE_LENGTHS = ["short", "medium", "long", "varied"] as const;
export type SentenceLength = (typeof SENTENCE_LENGTHS)[number];

export const REGISTERS = ["casual", "conversational", "professional", "formal", "edgy"] as const;
export type Register = (typeof REGISTERS)[number];

export const EMOJI_POLICIES = ["never", "rare", "frequent"] as const;
export type EmojiPolicy = (typeof EMOJI_POLICIES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// VoiceProfile — the structured output shape (also the type shipped to UI)
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceProfile {
  tone_descriptors: ToneDescriptor[];
  sentence_length: SentenceLength;
  register: Register;
  emoji_policy: EmojiPolicy;
  forbidden_phrases: string[];
  signature_phrases: string[];
  sample_sentences: string[];
}

const VoiceProfileSchema = z.object({
  tone_descriptors: z.array(z.enum(TONE_TAXONOMY)).min(3).max(5),
  sentence_length: z.enum(SENTENCE_LENGTHS),
  register: z.enum(REGISTERS),
  emoji_policy: z.enum(EMOJI_POLICIES),
  forbidden_phrases: z.array(z.string()).max(10).default([]),
  signature_phrases: z.array(z.string()).min(1).max(5),
  sample_sentences: z.array(z.string()).length(5),
});

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic structured-output tool schema (decision 9 — strict)
// ─────────────────────────────────────────────────────────────────────────────

const VOICE_TOOL_NAME = "extract_brand_voice";

const VOICE_TOOL = {
  name: VOICE_TOOL_NAME,
  description: "Extract a structured brand voice profile from the merchant storefront corpus.",
  input_schema: {
    type: "object" as const,
    required: [
      "tone_descriptors",
      "sentence_length",
      "register",
      "emoji_policy",
      "signature_phrases",
      "sample_sentences",
    ],
    properties: {
      tone_descriptors: {
        type: "array",
        items: { type: "string", enum: [...TONE_TAXONOMY] },
        minItems: 3,
        maxItems: 5,
      },
      sentence_length: { type: "string", enum: [...SENTENCE_LENGTHS] },
      register: { type: "string", enum: [...REGISTERS] },
      emoji_policy: { type: "string", enum: [...EMOJI_POLICIES] },
      forbidden_phrases: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
      },
      signature_phrases: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 5,
      },
      sample_sentences: {
        type: "array",
        items: { type: "string" },
        minItems: 5,
        maxItems: 5,
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompt + prompt versioning (decision 8 — replay reproducibility)
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT_TEMPLATE = `You are a brand voice analyst for an AI customer-recovery agent. The agent will send win-back SMS messages on behalf of this Shopify merchant, and the messages must sound like the brand wrote them.

Read the merchant's storefront corpus (about page, product descriptions, blog articles, store policies, footer) and produce a structured voice profile via the extract_brand_voice tool.

Constraints:
- tone_descriptors: pick 3-5 from the closed enum. Do NOT invent new descriptors.
- sentence_length: pick the most common pattern observed in the corpus.
- register: pick the closest match to the corpus's overall formality level.
- emoji_policy: "never" if the corpus uses zero emoji; "rare" if 1-3; "frequent" if 4+.
- forbidden_phrases: include up to 10 short phrases the brand visibly avoids (e.g. "act now", "hurry", "deal"). Empty array is acceptable.
- signature_phrases: 1-5 short phrases the brand uses repeatedly across the corpus.
- sample_sentences: exactly 5 SMS-length (under 160 characters each) sentences this brand might plausibly send to win back a lapsed customer. Match tone, register, sentence_length, and emoji_policy. Do not include placeholders, names, or merchant-specific PII.

The redacted corpus you see has had emails / phones / personal names removed; do not invent or restore them. If the corpus is sparse or empty, return a conservative profile (warm / conversational / rare emoji / generic phrasing) rather than guessing.`;

/** Stable hash of the prompt template used. Persisted on each voice_versions row. */
export const PROMPT_VERSION = createHash("sha256")
  .update(SYSTEM_PROMPT_TEMPLATE)
  .digest("hex")
  .slice(0, 16);

// ─────────────────────────────────────────────────────────────────────────────
// Input / output types
// ─────────────────────────────────────────────────────────────────────────────

export interface SynthesizeVoiceInput {
  /**
   * The PII-redacted snapshot. Caller MUST run assertNoPii on the
   * stringified corpus before calling this function (defends decision 10).
   */
  redactedCorpus: string;
  /** Optional override; defaults to SONNET_MODEL_DEFAULT. */
  model?: string;
}

export interface SynthesizeVoiceResult {
  profile: VoiceProfile;
  modelVersion: string;
  promptVersion: string;
  tokensInput: number;
  tokensOutput: number;
  retries: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Client factory + main entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceClientOptions {
  apiKey: string;
  timeoutMs?: number;
}

export function createVoiceClient(opts: VoiceClientOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 30_000,
    // We handle retries explicitly so we can accumulate token usage across them.
    maxRetries: 0,
  });
}

/**
 * Runs voice extraction. Retries up to MAX_RETRIES on schema-validation
 * failures, missing-tool_use responses, and transient Anthropic errors
 * (5xx, rate-limit, network/timeout). Permanent errors (auth, permission,
 * bad-request, not-found) short-circuit immediately with reason
 * "permanent_api". Backoff is exponential with jitter between attempts.
 * Accumulates token usage across every attempt that returned usage info
 * (decision 9). Throws VoiceSynthesisError on final failure, propagating
 * the originating reason so the orchestrator can write structured
 * extraction_failed event payloads.
 *
 * Defense-in-depth (decision 10): asserts no PII patterns are detectable
 * in the input corpus before the first Anthropic call. Throws
 * VoiceSynthesisError("pii_leak") if a leak is detected — the function
 * cannot be misused to ship un-redacted content to Sonnet.
 */
export async function synthesizeVoice(
  client: Anthropic,
  input: SynthesizeVoiceInput,
): Promise<SynthesizeVoiceResult> {
  // Belt-and-braces decision-10 gate.
  try {
    assertNoPii(input.redactedCorpus);
  } catch (err) {
    throw new VoiceSynthesisError("pii_leak", "PII detected in corpus before LLM call", {
      cause: err,
    });
  }

  const model = input.model ?? SONNET_MODEL_DEFAULT;
  let tokensInput = 0;
  let tokensOutput = 0;
  let lastError: Error | null = null;
  let lastReason: VoiceSynthesisReason = "exhausted_retries";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(computeBackoffMs(attempt));
    }
    try {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT_TEMPLATE,
        messages: [{ role: "user", content: input.redactedCorpus }],
        tools: [VOICE_TOOL],
        tool_choice: { type: "tool", name: VOICE_TOOL_NAME },
      });

      tokensInput += response.usage.input_tokens;
      tokensOutput += response.usage.output_tokens;

      const toolBlock = response.content.find((b) => b.type === "tool_use");
      if (!toolBlock || toolBlock.type !== "tool_use") {
        lastError = new Error("Sonnet response did not contain a tool_use block");
        lastReason = "no_tool_use_block";
        continue;
      }

      try {
        const profile = VoiceProfileSchema.parse(toolBlock.input);
        return {
          profile,
          modelVersion: model,
          promptVersion: PROMPT_VERSION,
          tokensInput,
          tokensOutput,
          retries: attempt,
        };
      } catch (parseErr) {
        lastError = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
        lastReason = "schema_validation";
        continue;
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      // Permanent errors short-circuit immediately. Any further retries waste
      // an Anthropic credential lookup and cannot succeed.
      if (isPermanentAnthropicError(e)) {
        throw new VoiceSynthesisError("permanent_api", `Permanent Anthropic error: ${e.message}`, {
          tokensInput,
          tokensOutput,
          cause: e,
        });
      }
      lastReason = "transient_api";
    }
  }

  throw new VoiceSynthesisError(
    lastReason,
    `Voice synthesis failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? "unknown"}`,
    { tokensInput, tokensOutput, cause: lastError },
  );
}

/**
 * Returns true if the error is a class of Anthropic API failure that will
 * not succeed on retry (auth / permission / bad-request / not-found). The
 * SDK throws typed subclasses; we also defensively match on status codes
 * + error names for runtime safety.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Error
// ─────────────────────────────────────────────────────────────────────────────

export type VoiceSynthesisReason =
  | "no_tool_use_block"
  | "schema_validation"
  | "exhausted_retries"
  | "transient_api"
  | "permanent_api"
  | "pii_leak";

export class VoiceSynthesisError extends Error {
  readonly reason: VoiceSynthesisReason;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  override readonly cause: unknown;

  constructor(
    reason: VoiceSynthesisReason,
    message: string,
    opts: { tokensInput?: number; tokensOutput?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "VoiceSynthesisError";
    this.reason = reason;
    this.tokensInput = opts.tokensInput ?? 0;
    this.tokensOutput = opts.tokensOutput ?? 0;
    this.cause = opts.cause;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers exported for the orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/** Parses a candidate profile object via the Zod schema. Pure. */
export function parseVoiceProfile(input: unknown): VoiceProfile {
  return VoiceProfileSchema.parse(input);
}
