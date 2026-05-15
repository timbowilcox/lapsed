// Voice event helpers — canonical append + materializer for the brand
// voice lifecycle. Mirrors the customer_events / order_events pattern
// from Sprint 03. Implements architectural decisions 7, 8, 11, and 12.

import { z } from "zod";
import type { LapsedSupabaseClient, Json } from "@lapsed/db";
import type { VoiceProfile } from "./voice-synthesizer";
import { parseVoiceProfile } from "./voice-synthesizer";

// ─────────────────────────────────────────────────────────────────────────────
// Event taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export const VoiceEventType = z.enum([
  "storefront_fetched",
  "pii_redacted",
  "voice_extracted",
  "voice_edited",
  "voice_activated",
  "extraction_failed",
]);
export type VoiceEventType = z.infer<typeof VoiceEventType>;

export const VoiceEventSource = z.enum([
  "install_orchestrator",
  "settings_reextract",
  "settings_edit",
  "settings_activate",
]);
export type VoiceEventSource = z.infer<typeof VoiceEventSource>;

// ─────────────────────────────────────────────────────────────────────────────
// Per-event-type payload shapes
//
// Payloads NEVER contain raw storefront text or LLM-generated content.
// They reference IDs and counts only. This is the contract that decision
// 10 (no PII in event payload) relies on.
// ─────────────────────────────────────────────────────────────────────────────

// All payload schemas are `.strict()` so an extra field carrying PII (e.g.
// a stray `raw_email` key) is rejected at parse time, not silently
// persisted. Combined with the "write the parsed value" pattern in
// appendVoiceEvent, this guarantees voice_events.payload contains only
// fields enumerated below (decision 10).

const StorefrontFetchedPayload = z.object({
  snapshot_id: z.string().uuid(),
  byte_count: z.number().int().min(0),
  source_hash: z.string().min(16).max(128),
}).strict();

const PiiRedactedPayload = z.object({
  snapshot_id: z.string().uuid(),
  pii_match_summary: z.object({
    email: z.number().int().min(0),
    phone: z.number().int().min(0),
    name: z.number().int().min(0),
    social: z.number().int().min(0),
  }).strict(),
}).strict();

const VoiceExtractedPayload = z.object({
  version_id: z.string().uuid(),
  snapshot_id: z.string().uuid(),
  model_version: z.string().min(1),
  prompt_version: z.string().min(1),
  tokens_input: z.number().int().min(0),
  tokens_output: z.number().int().min(0),
  retries: z.number().int().min(0),
}).strict();

const VoiceEditedPayload = z.object({
  version_id: z.string().uuid(),
  previous_version_id: z.string().uuid(),
  fields_changed: z.array(z.string()).min(0),
}).strict();

const VoiceActivatedPayload = z.object({
  version_id: z.string().uuid(),
  previous_version_id: z.string().uuid().nullable(),
}).strict();

export const VoiceFailurePhase = z.enum([
  "fetch",
  "redact",
  "synthesize",
  "materialize",
  "cap_check",
]);
export type VoiceFailurePhase = z.infer<typeof VoiceFailurePhase>;

const ExtractionFailedPayload = z.object({
  phase: VoiceFailurePhase,
  reason: z.string().min(1).max(64),
  attempt: z.number().int().min(0).optional(),
  error_class: z.string().min(1).max(64).optional(),
}).strict();

// Discriminated union — each event type carries its own payload shape.
export type VoiceEventInput =
  | { eventType: "storefront_fetched"; source: VoiceEventSource; merchantId: string; occurredAt: string; payload: z.infer<typeof StorefrontFetchedPayload> }
  | { eventType: "pii_redacted"; source: VoiceEventSource; merchantId: string; occurredAt: string; payload: z.infer<typeof PiiRedactedPayload> }
  | { eventType: "voice_extracted"; source: VoiceEventSource; merchantId: string; occurredAt: string; payload: z.infer<typeof VoiceExtractedPayload> }
  | { eventType: "voice_edited"; source: VoiceEventSource; merchantId: string; occurredAt: string; payload: z.infer<typeof VoiceEditedPayload> }
  | { eventType: "voice_activated"; source: VoiceEventSource; merchantId: string; occurredAt: string; payload: z.infer<typeof VoiceActivatedPayload> }
  | { eventType: "extraction_failed"; source: VoiceEventSource; merchantId: string; occurredAt: string; payload: z.infer<typeof ExtractionFailedPayload> };

// ─────────────────────────────────────────────────────────────────────────────
// Append helper — Zod-validated, ON CONFLICT DO NOTHING for idempotency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the input against the per-event-type payload schema and inserts
 * into `voice_events`. The unique constraint on (merchant_id, event_type,
 * source, occurred_at) makes the write idempotent — duplicate appends
 * silently no-op.
 *
 * The Zod validation is the only place we type-check payload shape. The DB
 * schema is intentionally loose (jsonb). Application-layer validation
 * means we can evolve payload shape without a migration.
 */
export async function appendVoiceEvent(
  serviceClient: LapsedSupabaseClient,
  event: VoiceEventInput,
): Promise<void> {
  // Validate the merchantId + occurredAt + source upfront.
  z.string().uuid("merchantId must be a UUID").parse(event.merchantId);
  z.string().datetime("occurredAt must be an ISO-8601 datetime").parse(event.occurredAt);
  VoiceEventSource.parse(event.source);

  // Per-event-type payload validation. We persist the PARSED value, not the
  // caller-supplied object — `.strict()` on each schema rejects extra fields,
  // so the persisted row contains only the enumerated keys (decision 10).
  let parsedPayload: unknown;
  switch (event.eventType) {
    case "storefront_fetched":
      parsedPayload = StorefrontFetchedPayload.parse(event.payload);
      break;
    case "pii_redacted":
      parsedPayload = PiiRedactedPayload.parse(event.payload);
      break;
    case "voice_extracted":
      parsedPayload = VoiceExtractedPayload.parse(event.payload);
      break;
    case "voice_edited":
      parsedPayload = VoiceEditedPayload.parse(event.payload);
      break;
    case "voice_activated":
      parsedPayload = VoiceActivatedPayload.parse(event.payload);
      break;
    case "extraction_failed":
      parsedPayload = ExtractionFailedPayload.parse(event.payload);
      break;
  }

  const { error } = await serviceClient.from("voice_events").upsert(
    {
      merchant_id: event.merchantId,
      event_type: event.eventType,
      source: event.source,
      payload: parsedPayload as Json,
      occurred_at: event.occurredAt,
    },
    {
      onConflict: "merchant_id,event_type,source,occurred_at",
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Materializer — replays voice_events to (re)build the active voice state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the latest voice extraction events for `merchantId` and atomically
 * updates `agent_profiles.active_voice_version_id` to point at the
 * currently-active voice version. The latest `voice_activated` event wins;
 * if none exists, the latest `voice_extracted` event's version is taken
 * as active.
 *
 * Idempotent: running this twice in succession with no new events leaves
 * the materialized state identical.
 *
 * KNOWN RACE (acceptable per decision 12 — agent_profiles is a regeneratable
 * cache): two concurrent materialize calls reading different latest events
 * can produce stale state. The state is self-healing on the next replay.
 * Chunk 7's install orchestrator serializes materialize per merchant so
 * this window does not surface to merchant-facing reads. Tracked in
 * HANDOFF.md as a known-deferred concern that chunk 7's evaluator must
 * verify the orchestrator actually serializes.
 *
 * Returns the version_id now marked active (or null if no extracted
 * version exists yet — e.g. the merchant just installed but extraction
 * is still in flight).
 */
export async function materializeVoice(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
): Promise<{ activeVoiceVersionId: string | null }> {
  z.string().uuid().parse(merchantId);

  // Most-recent voice_activated event (if any) determines the active version.
  // If no voice_activated has been emitted, fall back to the most-recent
  // voice_extracted event.
  const { data: activated, error: actErr } = await serviceClient
    .from("voice_events")
    .select("payload, occurred_at")
    .eq("merchant_id", merchantId)
    .eq("event_type", "voice_activated")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (actErr) throw actErr;

  let activeVersionId: string | null = null;
  if (activated && activated.payload) {
    const parsed = VoiceActivatedPayload.safeParse(activated.payload);
    if (parsed.success) activeVersionId = parsed.data.version_id;
  }

  if (activeVersionId === null) {
    const { data: extracted, error: extErr } = await serviceClient
      .from("voice_events")
      .select("payload, occurred_at")
      .eq("merchant_id", merchantId)
      .eq("event_type", "voice_extracted")
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (extErr) throw extErr;
    if (extracted && extracted.payload) {
      const parsed = VoiceExtractedPayload.safeParse(extracted.payload);
      if (parsed.success) activeVersionId = parsed.data.version_id;
    }
  }

  if (activeVersionId === null) {
    return { activeVoiceVersionId: null };
  }

  // Verify the version actually exists for this merchant — defends against a
  // stale event referencing a version_id that has been deleted (decision 8
  // RESTRICT FK keeps this from happening in practice; this is the runtime
  // backstop).
  const { data: version, error: vErr } = await serviceClient
    .from("voice_versions")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("id", activeVersionId)
    .maybeSingle();
  if (vErr) throw vErr;
  if (!version) {
    return { activeVoiceVersionId: null };
  }

  // Atomic upsert: update active_voice_version_id only; preserve any
  // existing role_descriptor / channel_prefs / fallback_criteria the
  // merchant has already configured. agent_profiles.merchant_id is the PK.
  const { error: upErr } = await serviceClient
    .from("agent_profiles")
    .upsert(
      {
        merchant_id: merchantId,
        active_voice_version_id: activeVersionId,
      },
      { onConflict: "merchant_id" },
    );
  if (upErr) throw upErr;

  return { activeVoiceVersionId: activeVersionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — insert a new voice_versions row.
//
// Lives here (not in queries.ts) so the row write happens immediately
// before the voice_extracted event append. Caller owns the ordering;
// this function does NOT write the event.
// ─────────────────────────────────────────────────────────────────────────────

export interface InsertVoiceVersionInput {
  merchantId: string;
  sourceSnapshotId: string;
  profile: VoiceProfile;
  modelVersion: string;
  promptVersion: string;
  tokensInput: number;
  tokensOutput: number;
  retries: number;
  /** Optional ISO timestamp; defaults to insert time. */
  extractedAt?: string;
}

/** Max attempts for the read-max-then-insert race retry loop. */
const INSERT_VERSION_MAX_ATTEMPTS = 5;

/**
 * Postgres error codes we expect to retry against: 23505 is unique_violation,
 * which fires when two concurrent extractions read the same `max(version_number)`
 * and both try to insert `max + 1`. The unique constraint
 * `voice_versions_merchant_version_unique` from migration 0006 makes the
 * second insert fail with this code, and we retry by re-reading the max.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string };
  return e.code === "23505";
}

export async function insertVoiceVersion(
  serviceClient: LapsedSupabaseClient,
  input: InsertVoiceVersionInput,
): Promise<{ versionId: string; versionNumber: number }> {
  // Validate the profile shape before persisting — defends decision 7
  // (immutable rows; profile must already conform).
  parseVoiceProfile(input.profile);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < INSERT_VERSION_MAX_ATTEMPTS; attempt++) {
    // Re-compute max + 1 on each attempt so a 23505 from a concurrent insert
    // is handled by picking the next available version_number.
    const { data: latest, error: latestErr } = await serviceClient
      .from("voice_versions")
      .select("version_number")
      .eq("merchant_id", input.merchantId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) throw latestErr;
    const nextVersionNumber = (latest?.version_number ?? 0) + 1;

    const row = {
      merchant_id: input.merchantId,
      version_number: nextVersionNumber,
      source_snapshot_id: input.sourceSnapshotId,
      profile: input.profile as unknown as Json,
      model_version: input.modelVersion,
      prompt_version: input.promptVersion,
      tokens_input: input.tokensInput,
      tokens_output: input.tokensOutput,
      retries: input.retries,
      ...(input.extractedAt ? { extracted_at: input.extractedAt } : {}),
    };

    const { data: inserted, error: insErr } = await serviceClient
      .from("voice_versions")
      .insert(row)
      .select("id, version_number")
      .single();
    if (!insErr && inserted) {
      return { versionId: inserted.id, versionNumber: inserted.version_number };
    }
    lastErr = insErr;
    if (!isUniqueViolation(insErr)) throw insErr;
    // Brief jittered backoff before retrying. Bounded by attempt cap.
    await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 30)));
  }
  throw lastErr ?? new Error("insertVoiceVersion: exhausted retry attempts");
}
