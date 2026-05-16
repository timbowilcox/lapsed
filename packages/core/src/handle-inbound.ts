// Inbound reply orchestrator — the synchronous heart of decision 17.
// Implements the body of Sprint 07 chunk 7. The /api/sms/inbound route
// (apps/web) owns Twilio-signature validation, form parsing, and TwiML
// rendering; THIS module owns the in-band flow once the request is trusted:
//
//   resolve customer → record inbound → STOP fast path → classify (timed)
//   → opt-out-intent path → bandit posterior update → generate reply (timed)
//
// Latency budget (decision 17): the whole flow must finish within
// `latencyBudgetMs` (5s p99). The two Sonnet calls (classify + generate)
// share a soft sub-budget of `latencyBudgetMs - LATENCY_RESERVE_MS`; if a
// call does not return in time the orchestrator records a `degraded_mode`
// event and returns a safe fallback reply rather than blowing the budget.
//
// Decision 10: the inbound body is PII-redacted before it reaches either
// Sonnet call. Decision 18: STOP keywords and Sonnet-classified opt_out
// intent both dual-record the opt-out. Decision 19: every classified inbound
// fires a bandit posterior update routed to the conversation's most-recent
// outbound arm.

import type Anthropic from "@anthropic-ai/sdk";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { getActiveVoiceProfile } from "@lapsed/db";
import { redact } from "./pii-redactor";
import { detectOptOutKeyword, recordOptOut } from "./opt-out-registry";
import { classifyReply, OPT_OUT_CONFIDENCE_THRESHOLD } from "./classify-reply";
import {
  generateReply,
  REPLY_HISTORY_LIMIT,
  type ReplyHistoryMessage,
  type CustomerReplyContext,
} from "./generate-reply";
import { parseVoiceProfile, type VoiceProfile } from "./voice-synthesizer";
import { updatePosterior } from "./bandit";
import {
  appendMessageEvent,
  ensureConversation,
  recordConversationActivity,
} from "./message-events";
import type { TwilioClient } from "./twilio-client";

// ─────────────────────────────────────────────────────────────────────────────
// Tuning + canned replies
// ─────────────────────────────────────────────────────────────────────────────

/** Wall-clock reserved (ms) for DB writes + TwiML after the LLM soft budget. */
export const LATENCY_RESERVE_MS = 1000;

/** Returned when the customer opts out (STOP keyword or Sonnet-classified). */
export const OPT_OUT_ACK =
  "You're unsubscribed and won't receive more messages from us. Reply START any time to reconnect.";

/** Returned when an LLM step exceeds the latency budget (decision 17). */
export const DEGRADED_FALLBACK_REPLY =
  "Thanks for your message — we'll get back to you shortly.";

/** Conservative voice profile used when a merchant has no active voice yet. */
const DEFAULT_VOICE_PROFILE: VoiceProfile = {
  tone_descriptors: ["warm", "reassuring", "down_to_earth"],
  sentence_length: "short",
  register: "conversational",
  emoji_policy: "never",
  forbidden_phrases: [],
  signature_phrases: ["thanks for being here"],
  sample_sentences: [
    "Lovely to hear from you.",
    "Happy to help with that.",
    "No rush at all.",
    "We're glad you reached out.",
    "Anything else we can sort out?",
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface HandleInboundDeps {
  serviceClient: LapsedSupabaseClient;
  twilioClient: TwilioClient;
  classifyClient: Anthropic;
  generateClient: Anthropic;
  /** Override for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface HandleInboundInput {
  /** Twilio `From` — the customer's phone (E.164). */
  fromNumber: string;
  /** Twilio `To` — our merchant number (E.164). Kept for v2 per-number routing. */
  toNumber: string;
  /** Raw inbound message body. */
  body: string;
  /** Twilio `MessageSid` of the inbound. */
  twilioSid: string;
  /** Total budget (ms) — INBOUND_REPLY_LATENCY_BUDGET_MS. */
  latencyBudgetMs: number;
  /** Optional Sonnet model override. */
  model?: string;
}

export type HandleInboundOutcome =
  | "replied"
  | "opted_out"
  | "degraded"
  | "unresolved"
  | "empty_body"
  | "duplicate";

export interface HandleInboundResult {
  /** The reply text for the route to render as TwiML. Empty string → no <Message>. */
  replyBody: string;
  outcome: HandleInboundOutcome;
  /** Per-step elapsed_ms timings, for the route's structured log. */
  timings: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function handleInboundMessage(
  deps: HandleInboundDeps,
  input: HandleInboundInput,
): Promise<HandleInboundResult> {
  const now = deps.now ?? (() => new Date());
  const startMs = now().getTime();
  const timings: Record<string, number> = {};
  const mark = (step: string): void => {
    timings[step] = now().getTime() - startMs;
  };
  // The two Sonnet calls share this soft deadline; past it we go degraded.
  const softDeadlineMs = startMs + Math.max(0, input.latencyBudgetMs - LATENCY_RESERVE_MS);
  const remaining = (): number => softDeadlineMs - now().getTime();

  const body = input.body.trim();
  if (body.length === 0) {
    mark("empty_body");
    logStep("inbound_empty_body", { elapsed_ms: timings.empty_body });
    return { replyBody: "", outcome: "empty_body", timings };
  }

  // ── Resolve the customer from the From-number ──────────────────────────────
  const resolved = await resolveCustomer(deps.serviceClient, input.fromNumber);
  mark("resolved");
  if (!resolved) {
    logStep("inbound_unresolved", { elapsed_ms: timings.resolved });
    return { replyBody: "", outcome: "unresolved", timings };
  }
  const { merchantId, customerId } = resolved;

  // ── Ensure the per-customer conversation (decision 16) ─────────────────────
  const { conversationId } = await ensureConversation(deps.serviceClient, {
    merchantId,
    customerId,
  });

  // ── Webhook-retry idempotency (decision 19 integrity) ──────────────────────
  // Twilio retries a webhook when it does not receive a timely 2xx. A retry
  // carries the SAME MessageSid; re-processing it would double-insert the
  // inbound row and double-fire the bandit posterior. If we have already
  // recorded an inbound with this twilio_sid, this is a retry — return the
  // reply we produced the first time (or empty) WITHOUT re-running
  // classification, the posterior update, or generation.
  if (input.twilioSid) {
    const priorInbound = await findInboundByTwilioSid(
      deps.serviceClient,
      conversationId,
      input.twilioSid,
    );
    if (priorInbound) {
      const priorReply = await findReplyAfter(
        deps.serviceClient,
        conversationId,
        priorInbound.sentAt,
      );
      mark("deduped");
      logStep("inbound_duplicate", { elapsed_ms: timings.deduped });
      return { replyBody: priorReply ?? "", outcome: "duplicate", timings };
    }
  }

  // ── Record the inbound message (raw + PII-redacted bodies) ─────────────────
  const redactedBody = redact(body).redacted;
  const inboundAt = now().toISOString();
  const inboundMessageId = await insertInboundMessage(deps.serviceClient, {
    merchantId,
    conversationId,
    body,
    redactedBody,
    twilioSid: input.twilioSid,
    sentAt: inboundAt,
  });
  await appendMessageEvent(deps.serviceClient, {
    eventType: "message_inbound_received",
    merchantId,
    conversationId,
    messageId: inboundMessageId,
    occurredAt: inboundAt,
    payload: { twilio_sid: input.twilioSid },
  });
  await recordConversationActivity(deps.serviceClient, {
    merchantId,
    customerId,
    occurredAt: inboundAt,
    direction: "inbound",
  });
  mark("inbound_recorded");

  // ── STOP-keyword fast path (decision 18) — short-circuits before any LLM ───
  const keyword = detectOptOutKeyword(body);
  if (keyword) {
    await recordOptOutAndEvent(deps, {
      merchantId,
      customerId,
      conversationId,
      inboundMessageId,
      phoneNumber: input.fromNumber,
      source: "stop_keyword",
      matchedKeyword: keyword,
    });
    mark("opted_out_keyword");
    logStep("inbound_opt_out", {
      source: "stop_keyword",
      elapsed_ms: timings.opted_out_keyword,
    });
    return { replyBody: OPT_OUT_ACK, outcome: "opted_out", timings };
  }

  // ── Sentiment classification (timed against the soft deadline) ─────────────
  const classifyOutcome = await withDeadline(
    classifyReply(deps.classifyClient, { redactedBody, model: input.model }),
    remaining(),
  );
  mark("classified");
  if (classifyOutcome.status !== "ok") {
    await appendDegradedEvent(deps, {
      merchantId,
      conversationId,
      messageId: inboundMessageId,
      phase: "classify",
      reason: classifyOutcome.status === "timeout" ? "timeout" : "error",
      elapsedMs: timings.classified,
    });
    logStep("inbound_degraded", { phase: "classify", elapsed_ms: timings.classified });
    return { replyBody: DEGRADED_FALLBACK_REPLY, outcome: "degraded", timings };
  }
  const classification = classifyOutcome.value.classification;

  // ── Sonnet-classified opt-out intent (decision 18) ─────────────────────────
  if (
    classification.intent === "opt_out" &&
    classification.confidence > OPT_OUT_CONFIDENCE_THRESHOLD
  ) {
    await appendMessageEvent(deps.serviceClient, {
      eventType: "inbound_classified",
      merchantId,
      conversationId,
      messageId: inboundMessageId,
      occurredAt: now().toISOString(),
      payload: {
        sentiment: classification.sentiment,
        intent: classification.intent,
        confidence: classification.confidence,
        retries: classifyOutcome.value.retries,
      },
    });
    await materializeMessageClassification(deps.serviceClient, inboundMessageId, classification);
    await recordOptOutAndEvent(deps, {
      merchantId,
      customerId,
      conversationId,
      inboundMessageId,
      phoneNumber: input.fromNumber,
      source: "sonnet_classified",
    });
    mark("opted_out_intent");
    logStep("inbound_opt_out", { source: "sonnet_classified", elapsed_ms: timings.opted_out_intent });
    return { replyBody: OPT_OUT_ACK, outcome: "opted_out", timings };
  }

  // ── Record the classification ──────────────────────────────────────────────
  await appendMessageEvent(deps.serviceClient, {
    eventType: "inbound_classified",
    merchantId,
    conversationId,
    messageId: inboundMessageId,
    occurredAt: now().toISOString(),
    payload: {
      sentiment: classification.sentiment,
      intent: classification.intent,
      confidence: classification.confidence,
      retries: classifyOutcome.value.retries,
    },
  });
  await materializeMessageClassification(deps.serviceClient, inboundMessageId, classification);

  // ── Bandit posterior update (decision 19) ──────────────────────────────────
  // success = positive sentiment AND (engagement OR purchase) intent.
  const success =
    classification.sentiment === "positive" &&
    (classification.intent === "engagement" || classification.intent === "purchase");
  await routeBanditPosterior(deps, { merchantId, conversationId, success });
  mark("posterior_updated");

  // ── Reply generation (timed against the remaining soft budget) ─────────────
  const history = await loadConversationHistory(deps.serviceClient, conversationId);
  const voiceProfile = await loadVoiceProfile(deps.serviceClient, merchantId);
  const customerContext = await loadCustomerContext(deps.serviceClient, merchantId, customerId);

  const genOutcome = await withDeadline(
    generateReply(deps.generateClient, {
      classification,
      conversationHistory: history,
      voiceProfile,
      customerContext,
      model: input.model,
    }),
    remaining(),
  );
  mark("generated");
  if (genOutcome.status !== "ok") {
    await appendDegradedEvent(deps, {
      merchantId,
      conversationId,
      messageId: inboundMessageId,
      phase: "generate",
      reason: genOutcome.status === "timeout" ? "timeout" : "error",
      elapsedMs: timings.generated,
    });
    logStep("inbound_degraded", { phase: "generate", elapsed_ms: timings.generated });
    return { replyBody: DEGRADED_FALLBACK_REPLY, outcome: "degraded", timings };
  }

  const reply = genOutcome.value.reply;

  // ── Record the outbound reply (sent by Twilio via the TwiML response) ──────
  const replyAt = now().toISOString();
  const replyMessageId = await insertOutboundReply(deps.serviceClient, {
    merchantId,
    conversationId,
    body: reply.body,
    redactedBody: redact(reply.body).redacted,
    sentAt: replyAt,
  });
  await appendMessageEvent(deps.serviceClient, {
    eventType: "reply_generated",
    merchantId,
    conversationId,
    messageId: replyMessageId,
    occurredAt: replyAt,
    payload: {
      suggested_next_action: reply.suggested_next_action,
      retries: genOutcome.value.retries,
    },
  });
  await appendMessageEvent(deps.serviceClient, {
    eventType: "reply_sent",
    merchantId,
    conversationId,
    messageId: replyMessageId,
    occurredAt: addMs(replyAt, 1),
    // The TwiML response is the transport; there is no synchronous Twilio SID.
    payload: { twilio_sid: "twiml_inline" },
  });
  await recordConversationActivity(deps.serviceClient, {
    merchantId,
    customerId,
    occurredAt: replyAt,
    direction: "outbound",
  });

  mark("done");
  logStep("inbound_replied", {
    elapsed_ms: timings.done,
    classify_ms: timings.classified,
    generate_ms: timings.generated,
  });
  return { replyBody: reply.body, outcome: "replied", timings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Latency helper
// ─────────────────────────────────────────────────────────────────────────────

type DeadlineOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

/**
 * Races a promise against a wall-clock deadline. A timeout resolves to
 * `{ status: "timeout" }`; a rejection to `{ status: "error" }`. Never throws —
 * the orchestrator branches on `status` to decide degraded mode. The timer is
 * always cleared so a resolved race leaves no dangling handle.
 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
  if (ms <= 0) return { status: "timeout" };
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeadlineOutcome<T>>((resolve) => {
    handle = setTimeout(() => resolve({ status: "timeout" }), ms);
  });
  const work = p
    .then((value): DeadlineOutcome<T> => ({ status: "ok", value }))
    .catch((error): DeadlineOutcome<T> => ({ status: "error", error }));
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(handle);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Customer resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the (merchantId, customerId) for an inbound From-number. v1 runs a
 * single shared Twilio number, so resolution is by customer phone. If more
 * than one merchant has a customer with this phone, the candidate with the
 * most recently active conversation wins (the live thread). Returns null when
 * no customer matches — the route then returns an empty TwiML.
 */
async function resolveCustomer(
  serviceClient: LapsedSupabaseClient,
  fromNumber: string,
): Promise<{ merchantId: string; customerId: string } | null> {
  const { data, error } = await serviceClient
    .from("customers")
    .select("merchant_id, shopify_customer_gid")
    .eq("phone", fromNumber);
  if (error) throw error;
  const candidates = data ?? [];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { merchantId: candidates[0]!.merchant_id, customerId: candidates[0]!.shopify_customer_gid };
  }
  // Disambiguate by the most recently active conversation.
  let best: { merchantId: string; customerId: string; lastAt: string } | null = null;
  for (const c of candidates) {
    const { data: conv } = await serviceClient
      .from("conversations")
      .select("last_message_at")
      .eq("merchant_id", c.merchant_id)
      .eq("customer_id", c.shopify_customer_gid)
      .maybeSingle();
    const lastAt = conv?.last_message_at ?? "";
    if (!best || lastAt > best.lastAt) {
      best = { merchantId: c.merchant_id, customerId: c.shopify_customer_gid, lastAt };
    }
  }
  return best ? { merchantId: best.merchantId, customerId: best.customerId } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message-row writers
// ─────────────────────────────────────────────────────────────────────────────

interface InsertInboundInput {
  merchantId: string;
  conversationId: string;
  body: string;
  redactedBody: string;
  twilioSid: string;
  sentAt: string;
}

async function insertInboundMessage(
  serviceClient: LapsedSupabaseClient,
  input: InsertInboundInput,
): Promise<string> {
  const { data, error } = await serviceClient
    .from("messages")
    .insert({
      merchant_id: input.merchantId,
      conversation_id: input.conversationId,
      direction: "inbound",
      channel: "sms",
      body: input.body,
      pii_redacted_body: input.redactedBody,
      twilio_sid: input.twilioSid,
      status: "received",
      sent_at: input.sentAt,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("insertInboundMessage: no row returned");
  return data.id;
}

interface InsertOutboundReplyInput {
  merchantId: string;
  conversationId: string;
  body: string;
  redactedBody: string;
  sentAt: string;
}

async function insertOutboundReply(
  serviceClient: LapsedSupabaseClient,
  input: InsertOutboundReplyInput,
): Promise<string> {
  const { data, error } = await serviceClient
    .from("messages")
    .insert({
      merchant_id: input.merchantId,
      conversation_id: input.conversationId,
      direction: "outbound",
      channel: "sms",
      body: input.body,
      pii_redacted_body: input.redactedBody,
      // A TwiML reply has no campaign / arm — it is a conversational turn,
      // not a campaign send (decision 16 — per-message campaign attribution).
      campaign_id: null,
      arm_id: null,
      status: "sent",
      sent_at: input.sentAt,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("insertOutboundReply: no row returned");
  return data.id;
}

/**
 * Returns an existing inbound message with this twilio_sid for the
 * conversation, or null. Backs the webhook-retry idempotency guard.
 */
async function findInboundByTwilioSid(
  serviceClient: LapsedSupabaseClient,
  conversationId: string,
  twilioSid: string,
): Promise<{ id: string; sentAt: string } | null> {
  const { data, error } = await serviceClient
    .from("messages")
    .select("id, sent_at")
    .eq("conversation_id", conversationId)
    .eq("twilio_sid", twilioSid)
    .eq("direction", "inbound")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, sentAt: data.sent_at } : null;
}

/**
 * Returns the body of the first outbound message sent AFTER `afterIso` on the
 * conversation — the reply that followed a given inbound. Null when none
 * exists (e.g. the original inbound degraded or opted the customer out).
 */
async function findReplyAfter(
  serviceClient: LapsedSupabaseClient,
  conversationId: string,
  afterIso: string,
): Promise<string | null> {
  const { data, error } = await serviceClient
    .from("messages")
    .select("body, sent_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "outbound")
    .gte("sent_at", afterIso)
    .order("sent_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.body ?? null;
}

/** Writes the classification back to the messages cache (sentiment + intent). */
async function materializeMessageClassification(
  serviceClient: LapsedSupabaseClient,
  messageId: string,
  classification: { sentiment: string; intent: string },
): Promise<void> {
  const { error } = await serviceClient
    .from("messages")
    .update({ sentiment: classification.sentiment, intent: classification.intent })
    .eq("id", messageId);
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// Opt-out + degraded-mode event helpers
// ─────────────────────────────────────────────────────────────────────────────

interface RecordOptOutAndEventInput {
  merchantId: string;
  customerId: string;
  conversationId: string;
  inboundMessageId: string;
  phoneNumber: string;
  source: "stop_keyword" | "sonnet_classified";
  matchedKeyword?: string;
}

async function recordOptOutAndEvent(
  deps: HandleInboundDeps,
  input: RecordOptOutAndEventInput,
): Promise<void> {
  await recordOptOut(deps.serviceClient, deps.twilioClient, {
    merchantId: input.merchantId,
    customerId: input.customerId,
    phoneNumber: input.phoneNumber,
    source: input.source,
    inboundMessageId: input.inboundMessageId,
  });
  await appendMessageEvent(deps.serviceClient, {
    eventType: "opt_out_recorded",
    merchantId: input.merchantId,
    conversationId: input.conversationId,
    messageId: input.inboundMessageId,
    occurredAt: (deps.now ?? (() => new Date()))().toISOString(),
    payload: {
      source: input.source,
      ...(input.matchedKeyword ? { matched_keyword: input.matchedKeyword } : {}),
    },
  });
}

interface AppendDegradedInput {
  merchantId: string;
  conversationId: string;
  messageId: string;
  phase: "classify" | "generate";
  reason: string;
  elapsedMs: number;
}

/**
 * Records a `degraded_mode` event. This event IS the v1 "async retry queue"
 * referenced by decision 17 — the chunk-9 sweep cron scans for conversations
 * whose latest inbound degraded and re-attempts a reply on the next tick.
 * There is no separate worker/queue (decision 17 — no queue infrastructure).
 */
async function appendDegradedEvent(
  deps: HandleInboundDeps,
  input: AppendDegradedInput,
): Promise<void> {
  await appendMessageEvent(deps.serviceClient, {
    eventType: "degraded_mode",
    merchantId: input.merchantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    occurredAt: (deps.now ?? (() => new Date()))().toISOString(),
    payload: { phase: input.phase, reason: input.reason, elapsed_ms: input.elapsedMs },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bandit posterior routing (decision 19)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Routes a posterior update to the conversation's MOST RECENT outbound arm
 * (decision 19 — conversation-level, not campaign-level per decision 16). If
 * the most recent outbound was a non-campaign reply (arm_id null) there is no
 * arm to update — the reply is skipped, logged, and not an error. The updated
 * outbound message is stamped `posterior_updated_at` so the chunk-9 no-reply
 * sweep does not also fire a (false) posterior for it.
 */
export async function routeBanditPosterior(
  deps: HandleInboundDeps,
  input: { merchantId: string; conversationId: string; success: boolean },
): Promise<void> {
  const { data, error } = await deps.serviceClient
    .from("messages")
    .select("id, arm_id")
    .eq("conversation_id", input.conversationId)
    .eq("direction", "outbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const outboundId = data?.id ?? null;
  const armId = data?.arm_id ?? null;
  if (!outboundId || !armId) {
    logStep("posterior_skip_no_arm", { conversation_id: input.conversationId });
    return;
  }

  await updatePosterior(deps.serviceClient, armId, input.success, {
    now: deps.now ?? (() => new Date()),
  });
  // Stamp the outbound so the chunk-9 sweep treats it as already-folded-in.
  const stampedAt = (deps.now ?? (() => new Date()))().toISOString();
  const { error: stampErr } = await deps.serviceClient
    .from("messages")
    .update({ posterior_updated_at: stampedAt })
    .eq("id", outboundId);
  if (stampErr) throw stampErr;

  await appendMessageEvent(deps.serviceClient, {
    eventType: "posterior_updated",
    merchantId: input.merchantId,
    conversationId: input.conversationId,
    messageId: outboundId,
    occurredAt: stampedAt,
    payload: { arm_id: armId, success: input.success },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reply-context loaders
// ─────────────────────────────────────────────────────────────────────────────

/** Loads the last REPLY_HISTORY_LIMIT messages of the thread, oldest-first. */
export async function loadConversationHistory(
  serviceClient: LapsedSupabaseClient,
  conversationId: string,
): Promise<ReplyHistoryMessage[]> {
  const { data, error } = await serviceClient
    .from("messages")
    .select("direction, pii_redacted_body, sent_at")
    .eq("conversation_id", conversationId)
    .order("sent_at", { ascending: false })
    .limit(REPLY_HISTORY_LIMIT);
  if (error) throw error;
  const rows = (data ?? []).slice().reverse(); // back to oldest-first
  return rows.map((r) => ({
    direction: r.direction === "inbound" ? "inbound" : "outbound",
    redactedBody: r.pii_redacted_body,
  }));
}

/** Loads + parses the merchant's active voice profile, or a safe default. */
export async function loadVoiceProfile(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
): Promise<VoiceProfile> {
  const active = await getActiveVoiceProfile(serviceClient, merchantId);
  if (!active) return DEFAULT_VOICE_PROFILE;
  try {
    return parseVoiceProfile(active.profile);
  } catch {
    // A stored profile that no longer parses must not break a live reply.
    logStep("voice_profile_parse_failed", { merchant_id: merchantId });
    return DEFAULT_VOICE_PROFILE;
  }
}

/** Loads lightweight, PII-free customer context for reply tailoring. */
export async function loadCustomerContext(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  customerId: string,
): Promise<CustomerReplyContext> {
  const [customerRes, stateRes] = await Promise.all([
    serviceClient
      .from("customers")
      .select("last_order_at")
      .eq("merchant_id", merchantId)
      .eq("shopify_customer_gid", customerId)
      .maybeSingle(),
    serviceClient
      .from("customer_inferred_state")
      .select("lifecycle_stage, propensity_90d")
      .eq("merchant_id", merchantId)
      .eq("shopify_customer_gid", customerId)
      .maybeSingle(),
  ]);
  if (customerRes.error) throw customerRes.error;
  if (stateRes.error) throw stateRes.error;
  return {
    lifecycleStage: stateRes.data?.lifecycle_stage ?? "unknown",
    lastOrderAt: customerRes.data?.last_order_at ?? null,
    propensity: stateRes.data?.propensity_90d ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** Single-line JSON structured log. Never includes raw phone, body, or PII. */
function logStep(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
