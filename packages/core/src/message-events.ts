// Message event helpers — the append-only event log + conversation-row
// helpers for the conversation engine. Mirrors voice-events.ts /
// campaign-events.ts. Implements architectural decisions 12-mirror
// (message_events is the append-only source of truth; conversations + messages
// are regeneratable materialized state) and 16 (conversations are keyed by
// (merchant_id, customer_id) — one thread per customer per merchant).
//
// Decision 3: every helper takes `channel` and never hardcodes "sms".

import { z } from "zod";
import type { LapsedSupabaseClient, Json } from "@lapsed/db";

// ─────────────────────────────────────────────────────────────────────────────
// Event taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export const MessageEventType = z.enum([
  "message_outbound_queued",
  "message_outbound_sent",
  "message_outbound_failed",
  "message_inbound_received",
  "inbound_classified",
  "reply_generated",
  "reply_sent",
  "degraded_mode",
  "opt_out_recorded",
  "posterior_updated",
]);
export type MessageEventType = z.infer<typeof MessageEventType>;

// ─────────────────────────────────────────────────────────────────────────────
// Per-event-type payload shapes
//
// Payloads NEVER contain customer PII or raw message text — only IDs, counts,
// enums, and timing metadata. All schemas are `.strict()` so a stray PII field
// is rejected at parse time (the decision-10 contract, mirroring voice_events).
// ─────────────────────────────────────────────────────────────────────────────

const OutboundQueuedPayload = z
  .object({
    campaign_id: z.string().uuid().nullable(),
    arm_id: z.string().uuid().nullable(),
  })
  .strict();

const OutboundSentPayload = z.object({ twilio_sid: z.string().min(1) }).strict();

const OutboundFailedPayload = z
  .object({
    error_code: z.number().int().nullable(),
    error_class: z.string().min(1).max(64),
  })
  .strict();

const InboundReceivedPayload = z.object({ twilio_sid: z.string().min(1) }).strict();

const InboundClassifiedPayload = z
  .object({
    sentiment: z.enum(["positive", "neutral", "negative"]),
    intent: z.enum(["engagement", "purchase", "question", "complaint", "opt_out", "other"]),
    confidence: z.number().min(0).max(1),
    retries: z.number().int().min(0),
  })
  .strict();

const ReplyGeneratedPayload = z
  .object({
    suggested_next_action: z.enum(["continue", "offer", "wait", "hand_off"]),
    retries: z.number().int().min(0),
  })
  .strict();

const ReplySentPayload = z.object({ twilio_sid: z.string().min(1) }).strict();

export const DegradedModePhase = z.enum(["classify", "generate"]);
export type DegradedModePhase = z.infer<typeof DegradedModePhase>;

const DegradedModePayload = z
  .object({
    phase: DegradedModePhase,
    reason: z.string().min(1).max(64),
    elapsed_ms: z.number().int().min(0),
  })
  .strict();

const OptOutRecordedPayload = z
  .object({
    source: z.enum(["stop_keyword", "sonnet_classified", "merchant_manual", "twilio_native"]),
    matched_keyword: z.string().max(32).optional(),
  })
  .strict();

const PosteriorUpdatedPayload = z
  .object({
    arm_id: z.string().uuid(),
    success: z.boolean(),
  })
  .strict();

// Discriminated union — each event type carries its own payload shape.
export type MessageEventInput =
  | { eventType: "message_outbound_queued"; payload: z.infer<typeof OutboundQueuedPayload> }
  | { eventType: "message_outbound_sent"; payload: z.infer<typeof OutboundSentPayload> }
  | { eventType: "message_outbound_failed"; payload: z.infer<typeof OutboundFailedPayload> }
  | { eventType: "message_inbound_received"; payload: z.infer<typeof InboundReceivedPayload> }
  | { eventType: "inbound_classified"; payload: z.infer<typeof InboundClassifiedPayload> }
  | { eventType: "reply_generated"; payload: z.infer<typeof ReplyGeneratedPayload> }
  | { eventType: "reply_sent"; payload: z.infer<typeof ReplySentPayload> }
  | { eventType: "degraded_mode"; payload: z.infer<typeof DegradedModePayload> }
  | { eventType: "opt_out_recorded"; payload: z.infer<typeof OptOutRecordedPayload> }
  | { eventType: "posterior_updated"; payload: z.infer<typeof PosteriorUpdatedPayload> };

export type AppendMessageEventInput = MessageEventInput & {
  merchantId: string;
  conversationId: string;
  /** null for events that fire before the messages row exists (queued). */
  messageId: string | null;
  occurredAt: string;
};

function parsePayload(event: MessageEventInput): unknown {
  switch (event.eventType) {
    case "message_outbound_queued":
      return OutboundQueuedPayload.parse(event.payload);
    case "message_outbound_sent":
      return OutboundSentPayload.parse(event.payload);
    case "message_outbound_failed":
      return OutboundFailedPayload.parse(event.payload);
    case "message_inbound_received":
      return InboundReceivedPayload.parse(event.payload);
    case "inbound_classified":
      return InboundClassifiedPayload.parse(event.payload);
    case "reply_generated":
      return ReplyGeneratedPayload.parse(event.payload);
    case "reply_sent":
      return ReplySentPayload.parse(event.payload);
    case "degraded_mode":
      return DegradedModePayload.parse(event.payload);
    case "opt_out_recorded":
      return OptOutRecordedPayload.parse(event.payload);
    case "posterior_updated":
      return PosteriorUpdatedPayload.parse(event.payload);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// appendMessageEvent — Zod-validated, idempotent (ON CONFLICT DO NOTHING)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the input against the per-event-type payload schema and inserts
 * into `message_events`. The `message_events_dedup_unique` constraint
 * (merchant_id, conversation_id, message_id, event_type, occurred_at — NULLS
 * NOT DISTINCT) makes a duplicate append a silent no-op.
 *
 * The persisted payload is the PARSED value, not the caller object — `.strict()`
 * rejects extra fields, so the row contains only the enumerated keys (no PII).
 *
 * IDEMPOTENCY CONTRACT: callers that may retry MUST reuse the SAME `occurredAt`
 * on the retry — a freshly stamped timestamp would defeat the dedup constraint.
 */
export async function appendMessageEvent(
  serviceClient: LapsedSupabaseClient,
  event: AppendMessageEventInput,
): Promise<void> {
  z.string().uuid("merchantId must be a UUID").parse(event.merchantId);
  z.string().uuid("conversationId must be a UUID").parse(event.conversationId);
  if (event.messageId !== null) {
    z.string().uuid("messageId must be a UUID").parse(event.messageId);
  }
  z.string().datetime("occurredAt must be an ISO-8601 datetime").parse(event.occurredAt);

  const parsedPayload = parsePayload(event);

  const { error } = await serviceClient.from("message_events").upsert(
    {
      merchant_id: event.merchantId,
      conversation_id: event.conversationId,
      message_id: event.messageId,
      event_type: event.eventType,
      payload: parsedPayload as Json,
      occurred_at: event.occurredAt,
    },
    {
      onConflict: "merchant_id,conversation_id,message_id,event_type,occurred_at",
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// ensureConversation — get-or-create the per-customer thread (decision 16)
// ─────────────────────────────────────────────────────────────────────────────

export interface EnsureConversationInput {
  merchantId: string;
  /** shopify_customer_gid. */
  customerId: string;
  /** Defaults to "sms" (decision 3 — channel is a parameter). */
  channel?: string;
}

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

/**
 * Returns the `conversations.id` of the thread for (merchantId, customerId),
 * creating the row if it does not exist. Per decision 16 there is exactly ONE
 * conversation per customer per merchant — the composite PK enforces it.
 *
 * Read-first then insert; a concurrent insert racing between the read and the
 * insert is detected via the PK unique violation and resolved by re-reading.
 * Idempotent across every ordering.
 */
export async function ensureConversation(
  serviceClient: LapsedSupabaseClient,
  input: EnsureConversationInput,
): Promise<{ conversationId: string }> {
  z.string().uuid("merchantId must be a UUID").parse(input.merchantId);
  const channel = input.channel ?? "sms";

  const existing = await readConversationId(serviceClient, input.merchantId, input.customerId);
  if (existing) return { conversationId: existing };

  const { data: inserted, error } = await serviceClient
    .from("conversations")
    .insert({ merchant_id: input.merchantId, customer_id: input.customerId, channel })
    .select("id")
    .maybeSingle();

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await readConversationId(serviceClient, input.merchantId, input.customerId);
      if (raced) return { conversationId: raced };
    }
    throw error;
  }
  if (!inserted) {
    throw new Error("ensureConversation: conversation insert returned no row");
  }
  return { conversationId: inserted.id };
}

async function readConversationId(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  customerId: string,
): Promise<string | null> {
  const { data, error } = await serviceClient
    .from("conversations")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// recordConversationActivity — update the materialized thread cache
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordConversationActivityInput {
  merchantId: string;
  customerId: string;
  /** ISO timestamp of the message that just landed. */
  occurredAt: string;
  direction: "inbound" | "outbound";
}

/**
 * Updates the `conversations` materialized cache after a message lands:
 * advances `last_message_at`, increments `message_count`, and — for an inbound
 * message — advances `last_inbound_at` (which the chunk-9 no-reply sweep
 * reads). conversations is a regeneratable cache (decision 12-mirror), so this
 * read-modify-write is acceptable; message_events remains the source of truth.
 */
export async function recordConversationActivity(
  serviceClient: LapsedSupabaseClient,
  input: RecordConversationActivityInput,
): Promise<void> {
  const { data: current, error: readErr } = await serviceClient
    .from("conversations")
    .select("message_count")
    .eq("merchant_id", input.merchantId)
    .eq("customer_id", input.customerId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!current) {
    throw new Error(
      `recordConversationActivity: no conversation for merchant/customer — call ensureConversation first`,
    );
  }

  const patch: { last_message_at: string; message_count: number; last_inbound_at?: string } = {
    last_message_at: input.occurredAt,
    message_count: (current.message_count ?? 0) + 1,
  };
  if (input.direction === "inbound") {
    patch.last_inbound_at = input.occurredAt;
  }

  const { error: upErr } = await serviceClient
    .from("conversations")
    .update(patch)
    .eq("merchant_id", input.merchantId)
    .eq("customer_id", input.customerId);
  if (upErr) throw upErr;
}
