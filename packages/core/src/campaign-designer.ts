// AI Campaign Designer — a single Sonnet 4.6 call that proposes three
// win-back campaign variants for a scored customer group. Mirrors the
// voice-synthesizer pattern (decision 9): tool_choice structured output,
// SDK retries disabled so this loop owns retry policy, token usage
// accumulated across attempts, permanent API errors short-circuit.
//
// Decision 10 (PII redaction mandatory before any LLM call) is enforced at
// this module's entry boundary: assertNoPii runs on the serialized group
// summary before the first Anthropic call. The group summary is RFM /
// lifecycle COUNTS only by construction — no customer rows, no names, no
// contact details — and the pre-flight assertion fails the call loudly if a
// regression ever lets PII through.
//
// The three variants are required to be mutually distinct across
// (offer_type, send_time_window, tone) so a proposal always offers the
// merchant a genuine spread of choices, not three near-identical drafts.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertNoPii } from "./pii-redactor";
import { TONE_TAXONOMY, SONNET_MODEL_DEFAULT, type VoiceProfile } from "./voice-synthesizer";

export const MAX_RETRIES = 3;
// 2048 comfortably fits a 3-variant tool call: 3 × (~160-char message_draft +
// short offer/enum fields + a small expected_impact object) as JSON is well
// under 1k tokens. Headroom is ~2× worst case; a truncated tool_use block
// would simply trigger a retry rather than corrupt output.
export const MAX_OUTPUT_TOKENS = 2048;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 4000;

// ─────────────────────────────────────────────────────────────────────────────
// Closed taxonomies (decision 11 — closed enums, no freeform values)
// ─────────────────────────────────────────────────────────────────────────────

/** Offer types the designer may propose. ~8 values, closed enum. */
export const OFFER_TYPE_TAXONOMY = [
  "percent_discount",
  "fixed_amount_discount",
  "free_shipping",
  "free_gift",
  "bundle",
  "exclusive_access",
  "early_access",
  "loyalty_points",
] as const;
export type OfferType = (typeof OFFER_TYPE_TAXONOMY)[number];

/** Send-time windows. The conversation engine (Sprint 07) resolves these to
 *  concrete local times per customer. */
export const SEND_TIME_WINDOWS = [
  "morning",
  "midday",
  "evening",
  "weekend_morning",
  "weekend_evening",
] as const;
export type SendTimeWindow = (typeof SEND_TIME_WINDOWS)[number];

// Tone reuses the Sprint 05 voice taxonomy so a proposal's tone is always a
// value the merchant's voice profile can also express.
export type CampaignTone = (typeof TONE_TAXONOMY)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Variant + proposal shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectedImpact {
  /** Estimated fraction of the group that responds (0–1). */
  estimated_response_rate: number;
  /** Estimated restored revenue in whole currency units (>= 0). */
  estimated_recovered_revenue: number;
}

export interface CampaignVariant {
  offer_type: OfferType;
  offer_value: string;
  message_draft: string;
  send_time_window: SendTimeWindow;
  tone: CampaignTone;
  expected_impact: ExpectedImpact;
}

const ExpectedImpactSchema = z
  .object({
    estimated_response_rate: z.number().min(0).max(1),
    estimated_recovered_revenue: z.number().min(0),
  })
  .strict();

const CampaignVariantSchema = z
  .object({
    offer_type: z.enum(OFFER_TYPE_TAXONOMY),
    offer_value: z.string().min(1).max(64),
    message_draft: z.string().min(1).max(160),
    send_time_window: z.enum(SEND_TIME_WINDOWS),
    tone: z.enum(TONE_TAXONOMY),
    expected_impact: ExpectedImpactSchema,
  })
  .strict();

/**
 * A proposal is exactly three variants that span at least two distinct values
 * on EACH of offer type, send-time window, and tone — the acceptance
 * criterion's "offers/timing/tone diversity", enforced per-axis so a proposal
 * always explores every bandit hypothesis dimension (decision 4) rather than
 * varying one axis while holding the other two fixed. A model response with
 * three near-identical variants fails this and triggers a retry.
 */
export const CampaignProposalSchema = z
  .object({
    variants: z.array(CampaignVariantSchema).length(3),
  })
  .strict()
  .refine(
    (p) => {
      const offers = new Set(p.variants.map((v) => v.offer_type));
      const windows = new Set(p.variants.map((v) => v.send_time_window));
      const tones = new Set(p.variants.map((v) => v.tone));
      return offers.size >= 2 && windows.size >= 2 && tones.size >= 2;
    },
    {
      message:
        "the three variants must span at least two distinct offer types, send windows, and tones",
    },
  );

export type CampaignProposalDraft = z.infer<typeof CampaignProposalSchema>;

/** Parses a candidate proposal object via the Zod schema. Pure. */
export function parseCampaignProposal(input: unknown): CampaignProposalDraft {
  return CampaignProposalSchema.parse(input);
}

// ─────────────────────────────────────────────────────────────────────────────
// Group summary — RFM / lifecycle COUNTS only (decision 10 — no PII)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate, PII-free description of a customer group. Every field is a count
 * or a money/day scalar — no customer rows, names, emails, or phone numbers.
 * The orchestrator builds this from customer_inferred_state / customer_rfm
 * aggregates; the designer's PII pre-flight asserts it stays PII-free.
 */
export interface GroupSummary {
  customerCount: number;
  /** Lifecycle stage → count, e.g. { lapsed: 40, at_risk: 12 }. */
  lifecycleCounts: Record<string, number>;
  medianAovCents: number;
  medianRecencyDays: number;
  avgOrderCount: number;
}

const GroupSummarySchema = z
  .object({
    customerCount: z.number().int().min(0),
    lifecycleCounts: z.record(z.string(), z.number().int().min(0)),
    medianAovCents: z.number().int().min(0),
    medianRecencyDays: z.number().int().min(0),
    avgOrderCount: z.number().min(0),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic structured-output tool schema (decision 9 — strict)
// ─────────────────────────────────────────────────────────────────────────────

const DESIGNER_TOOL_NAME = "propose_campaign";

const DESIGNER_TOOL = {
  name: DESIGNER_TOOL_NAME,
  description:
    "Propose exactly three diverse win-back SMS campaign variants for a lapsed customer group.",
  input_schema: {
    type: "object" as const,
    required: ["variants"],
    additionalProperties: false,
    properties: {
      variants: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "offer_type",
            "offer_value",
            "message_draft",
            "send_time_window",
            "tone",
            "expected_impact",
          ],
          properties: {
            offer_type: { type: "string", enum: [...OFFER_TYPE_TAXONOMY] },
            offer_value: { type: "string", minLength: 1, maxLength: 64 },
            message_draft: { type: "string", minLength: 1, maxLength: 160 },
            send_time_window: { type: "string", enum: [...SEND_TIME_WINDOWS] },
            tone: { type: "string", enum: [...TONE_TAXONOMY] },
            expected_impact: {
              type: "object",
              additionalProperties: false,
              required: ["estimated_response_rate", "estimated_recovered_revenue"],
              properties: {
                estimated_response_rate: { type: "number", minimum: 0, maximum: 1 },
                estimated_recovered_revenue: { type: "number", minimum: 0 },
              },
            },
          },
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompt + prompt versioning (decision 8 — replay reproducibility)
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT_TEMPLATE = `You are an AI campaign designer for a Shopify dormant-customer recovery tool. Given a merchant's brand voice profile and an aggregate summary of one lapsed customer group, propose exactly three win-back SMS campaign variants via the propose_campaign tool.

Each variant has:
- offer_type: pick from the closed enum. Do NOT invent values.
- offer_value: a short concrete description of the offer (e.g. "10%", "Free over $50", "Free tote with order"). Keep it under 64 characters.
- message_draft: an SMS-length (under 160 characters) message written in the merchant's brand voice. Match the voice profile's tone, register, sentence length, and emoji policy. Do NOT include placeholders, links, customer names, or any personal data.
- send_time_window: pick from the closed enum.
- tone: pick from the closed enum; choose a tone consistent with the voice profile.
- expected_impact: a realistic estimate. estimated_response_rate is a fraction 0-1; estimated_recovered_revenue is in whole currency units and must be non-negative. Base the estimate on the group size and median order value, and be conservative.

The three variants MUST be meaningfully different from each other: use distinct offer types, distinct send-time windows, and distinct tones so the merchant sees a genuine spread of options — never three near-identical drafts.

The group summary contains only aggregate counts and medians — no individual customer data. Do not ask for or infer any personal information.`;

/** Stable hash of the prompt template. Persisted with each proposal. */
export const PROMPT_VERSION = createHash("sha256")
  .update(SYSTEM_PROMPT_TEMPLATE)
  .digest("hex")
  .slice(0, 16);

// ─────────────────────────────────────────────────────────────────────────────
// Client factory + entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export interface CampaignClientOptions {
  apiKey: string;
  timeoutMs?: number;
}

export function createCampaignClient(opts: CampaignClientOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs ?? 30_000,
    // Retries handled explicitly below so token usage accumulates across them.
    maxRetries: 0,
  });
}

export interface DesignCampaignInput {
  /** Owning merchant — carried for traceability; never sent to the LLM. */
  merchantId: string;
  /** The system group identifier (a GroupSlug); doubles as the LLM-visible group id. */
  groupSlug: string;
  /** The merchant's active brand voice profile (from voice_versions). */
  voiceProfile: VoiceProfile;
  /** PII-free aggregate summary of the group's customers. */
  groupSummary: GroupSummary;
  /** Optional model override; defaults to SONNET_MODEL_DEFAULT. */
  model?: string;
}

export interface DesignCampaignResult {
  variants: CampaignVariant[];
  modelVersion: string;
  promptVersion: string;
  tokensInput: number;
  tokensOutput: number;
  retries: number;
}

export type CampaignDesignReason =
  | "no_tool_use_block"
  | "schema_validation"
  | "exhausted_retries"
  | "transient_api"
  | "permanent_api"
  | "pii_leak"
  | "invalid_group_summary";

export class CampaignDesignError extends Error {
  readonly reason: CampaignDesignReason;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  override readonly cause: unknown;

  constructor(
    reason: CampaignDesignReason,
    message: string,
    opts: { tokensInput?: number; tokensOutput?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "CampaignDesignError";
    this.reason = reason;
    this.tokensInput = opts.tokensInput ?? 0;
    this.tokensOutput = opts.tokensOutput ?? 0;
    this.cause = opts.cause;
  }
}

/**
 * Runs the AI Campaign Designer. Retries up to MAX_RETRIES on schema-validation
 * failures (including the three-variants-not-distinct refine), missing-tool_use
 * responses, and transient Anthropic errors; permanent errors short-circuit.
 * Token usage accumulates across every attempt. Backoff is exponential with
 * jitter.
 *
 * Decision 10 gate: assertNoPii runs on the serialized group summary before
 * the first Anthropic call. The summary is counts-only by construction; the
 * assertion is the regression backstop that throws CampaignDesignError
 * ("pii_leak") rather than shipping customer data to Sonnet.
 */
export async function designCampaign(
  client: Anthropic,
  input: DesignCampaignInput,
): Promise<DesignCampaignResult> {
  z.string().uuid("merchantId must be a UUID").parse(input.merchantId);

  // Validate the group summary shape. A malformed summary throws a typed
  // CampaignDesignError (not a raw ZodError) so the chunk-6 orchestrator can
  // record a structured proposal_failed event from a uniform error contract.
  let groupSummary: GroupSummary;
  try {
    groupSummary = GroupSummarySchema.parse(input.groupSummary);
  } catch (err) {
    throw new CampaignDesignError(
      "invalid_group_summary",
      "group summary failed schema validation",
      { cause: err },
    );
  }

  // Decision-10 PII pre-flight on the serialized group summary. The summary is
  // the only customer-derived input; SPRINT.md scopes the pre-flight to it.
  try {
    assertNoPii(JSON.stringify(groupSummary));
  } catch (err) {
    throw new CampaignDesignError(
      "pii_leak",
      "PII detected in the group summary before the LLM call",
      { cause: err },
    );
  }

  const model = input.model ?? SONNET_MODEL_DEFAULT;
  const userContent = JSON.stringify({
    group_slug: input.groupSlug,
    voice_profile: input.voiceProfile,
    group_summary: groupSummary,
  });

  let tokensInput = 0;
  let tokensOutput = 0;
  let lastError: Error | null = null;
  let lastReason: CampaignDesignReason = "exhausted_retries";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(computeBackoffMs(attempt));
    }
    try {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT_TEMPLATE,
        messages: [{ role: "user", content: userContent }],
        tools: [DESIGNER_TOOL],
        tool_choice: { type: "tool", name: DESIGNER_TOOL_NAME },
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
        const proposal = CampaignProposalSchema.parse(toolBlock.input);
        return {
          variants: proposal.variants,
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
      if (isPermanentAnthropicError(e)) {
        throw new CampaignDesignError("permanent_api", `Permanent Anthropic error: ${e.message}`, {
          tokensInput,
          tokensOutput,
          cause: e,
        });
      }
      lastReason = "transient_api";
    }
  }

  throw new CampaignDesignError(
    lastReason,
    `Campaign design failed after ${MAX_RETRIES} attempts: ${lastError?.message ?? "unknown"}`,
    { tokensInput, tokensOutput, cause: lastError },
  );
}

/**
 * Returns true for Anthropic API errors that will not succeed on retry
 * (auth / permission / bad-request / not-found).
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

/** Exponential backoff with jitter, capped at BACKOFF_MAX_MS. Exported for tests. */
export function computeBackoffMs(attempt: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * BACKOFF_BASE_MS);
  return Math.min(raw + jitter, BACKOFF_MAX_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
