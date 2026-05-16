// Conversation sweep — the daily background pass over the conversation engine.
// Implements Sprint 07 chunk 9. Two responsibilities, both per-merchant:
//
//   A. No-reply posterior sweep (decision 19): every campaign outbound that is
//      NO_REPLY_SWEEP_DAYS old and never had a posterior folded in
//      (posterior_updated_at IS NULL) fires updatePosterior(arm, success=false)
//      — the "no reply = failure" signal. posterior_updated_at is the
//      idempotency flag: the inbound webhook stamps it on a reply, this sweep
//      stamps the rest, so every campaign-driven outbound's arm gets exactly
//      one posterior update.
//
//   B. Degraded-reply retry (decision 17): the synchronous inbound webhook
//      writes a `degraded_mode` event and returns a fallback when an LLM step
//      overruns the latency budget. That event is the "async retry queue"
//      decision 17 commits to. This sweep scans for degraded inbounds with no
//      reply yet, re-runs classify → (posterior if it never fired) → generate,
//      and sends the deferred reply as a real outbound SMS.

import { z } from "zod";
import type { LapsedSupabaseClient, Json } from "@lapsed/db";
import { updatePosterior } from "./bandit";
import { classifyReply, OPT_OUT_CONFIDENCE_THRESHOLD } from "./classify-reply";
import { generateReply } from "./generate-reply";
import { appendMessageEvent, DegradedModePhase } from "./message-events";
import { recordOptOut, isOptedOut } from "./opt-out-registry";
import { sendMessage } from "./send-message";

/**
 * Only degraded inbounds sent within this window are retried. Past it, the
 * customer's moment has passed — a stale "we'll get back to you" reply is
 * worse than none, and the no-reply sweep still folds the posterior in. This
 * also bounds the retry: a persistently-failing inbound is abandoned rather
 * than re-classified every night forever.
 */
export const DEGRADED_RETRY_WINDOW_DAYS = 3;
import {
  routeBanditPosterior,
  loadConversationHistory,
  loadVoiceProfile,
  loadCustomerContext,
  type HandleInboundDeps,
} from "./handle-inbound";

// ─────────────────────────────────────────────────────────────────────────────
// A. No-reply posterior sweep
// ─────────────────────────────────────────────────────────────────────────────

export interface SweepNoReplyOpts {
  merchantId: string;
  /** Days after an outbound with no posterior before posterior=false fires. */
  noReplySweepDays: number;
  now?: () => Date;
}

export interface SweepNoReplyResult {
  merchantId: string;
  /** Outbound messages folded into a posterior as success=false this run. */
  sweptCount: number;
}

/**
 * Fires `updatePosterior(arm, success=false)` for every campaign outbound that
 * is `noReplySweepDays` old and still has `posterior_updated_at IS NULL` — it
 * never elicited a reply. Idempotent: stamping `posterior_updated_at` means a
 * re-run of the sweep skips already-swept outbounds.
 */
export async function sweepNoReplyPosteriors(
  serviceClient: LapsedSupabaseClient,
  opts: SweepNoReplyOpts,
): Promise<SweepNoReplyResult> {
  z.string().uuid("merchantId must be a UUID").parse(opts.merchantId);
  const now = opts.now ?? (() => new Date());
  const cutoff = new Date(
    now().getTime() - opts.noReplySweepDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await serviceClient
    .from("messages")
    .select("id, conversation_id, arm_id, sent_at")
    .eq("merchant_id", opts.merchantId)
    .eq("direction", "outbound")
    .is("posterior_updated_at", null)
    .not("arm_id", "is", null)
    .lte("sent_at", cutoff);
  if (error) throw error;

  // Only campaign-driven outbounds carry an arm to update; a non-campaign
  // reply (arm_id null) has no posterior. The `.not("arm_id", "is", null)`
  // filter excludes them at the query level so they are not re-scanned nightly.
  const stale = data ?? [];

  let sweptCount = 0;
  for (const m of stale) {
    const armId = m.arm_id as string;
    await updatePosterior(serviceClient, armId, false, { now });
    const stampedAt = now().toISOString();
    const { error: stampErr } = await serviceClient
      .from("messages")
      .update({ posterior_updated_at: stampedAt })
      .eq("id", m.id);
    if (stampErr) throw stampErr;
    await appendMessageEvent(serviceClient, {
      eventType: "posterior_updated",
      merchantId: opts.merchantId,
      conversationId: m.conversation_id,
      messageId: m.id,
      occurredAt: stampedAt,
      payload: { arm_id: armId, success: false },
    });
    sweptCount += 1;
  }

  logStructured("sweep_no_reply_complete", {
    merchant_id: opts.merchantId,
    swept_count: sweptCount,
  });
  return { merchantId: opts.merchantId, sweptCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Degraded-reply retry
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryDegradedOpts {
  merchantId: string;
  /** Merchant outbound Twilio number. */
  fromNumber: string;
  /** Per-merchant per-UTC-day outbound cap. */
  outboundDailyCap: number;
  now?: () => Date;
  model?: string;
}

export interface RetryDegradedResult {
  merchantId: string;
  /** Degraded inbounds that produced a sent reply this run. */
  retried: number;
  /** Degraded inbounds that re-classified to an opt-out. */
  optedOut: number;
  /** Degraded inbounds that failed again (will be retried next tick). */
  stillDegraded: number;
}

interface DegradedEntry {
  inboundMessageId: string;
  conversationId: string;
  phase: string;
}

/**
 * Re-attempts the deferred reply for every degraded inbound that has no reply
 * yet (decision 17's async-retry contract). For each: re-classify, fire the
 * bandit posterior IF the original degrade was at the classify phase (a
 * generate-phase degrade already fired it before generation), generate the
 * reply, and send it as a real outbound SMS via `sendMessage`. Once a reply is
 * sent, the outbound row makes a subsequent sweep skip the inbound.
 */
export async function retryDegradedReplies(
  deps: HandleInboundDeps,
  opts: RetryDegradedOpts,
): Promise<RetryDegradedResult> {
  z.string().uuid("merchantId must be a UUID").parse(opts.merchantId);
  const now = deps.now ?? opts.now ?? (() => new Date());
  const result: RetryDegradedResult = {
    merchantId: opts.merchantId,
    retried: 0,
    optedOut: 0,
    stillDegraded: 0,
  };

  const degraded = await loadOpenDegradedInbounds(
    deps.serviceClient,
    opts.merchantId,
    now(),
  );

  for (const entry of degraded) {
    const inbound = await loadInboundForRetry(deps.serviceClient, entry.inboundMessageId);
    if (!inbound) continue;
    const customerId = await loadConversationCustomer(deps.serviceClient, entry.conversationId);
    if (!customerId) continue;

    // Decision 18: a customer who opted out between the original inbound and
    // this sweep must not get a retried reply. Pre-flight before the LLM calls.
    if (await isOptedOut(deps.serviceClient, opts.merchantId, customerId)) {
      logStructured("degraded_retry_skipped_opted_out", {
        merchant_id: opts.merchantId,
        conversation_id: entry.conversationId,
      });
      continue;
    }

    try {
      // Re-classify the deferred inbound.
      const classified = await classifyReply(deps.classifyClient, {
        redactedBody: inbound.redactedBody,
        model: opts.model,
      });
      const classification = classified.classification;

      await appendMessageEvent(deps.serviceClient, {
        eventType: "inbound_classified",
        merchantId: opts.merchantId,
        conversationId: entry.conversationId,
        messageId: entry.inboundMessageId,
        occurredAt: now().toISOString(),
        payload: {
          sentiment: classification.sentiment,
          intent: classification.intent,
          confidence: classification.confidence,
          retries: classified.retries,
        },
      });

      // Sonnet-classified opt-out — record it and skip the reply.
      if (
        classification.intent === "opt_out" &&
        classification.confidence > OPT_OUT_CONFIDENCE_THRESHOLD
      ) {
        const phone = await loadCustomerPhone(deps.serviceClient, opts.merchantId, customerId);
        if (phone) {
          await recordOptOut(deps.serviceClient, deps.twilioClient, {
            merchantId: opts.merchantId,
            customerId,
            phoneNumber: phone,
            source: "sonnet_classified",
            inboundMessageId: entry.inboundMessageId,
          });
        }
        result.optedOut += 1;
        continue;
      }

      // Posterior: a classify-phase degrade never fired one; a generate-phase
      // degrade already did (the webhook fires the posterior before generate).
      if (entry.phase === "classify") {
        const success =
          classification.sentiment === "positive" &&
          (classification.intent === "engagement" || classification.intent === "purchase");
        await routeBanditPosterior(deps, {
          merchantId: opts.merchantId,
          conversationId: entry.conversationId,
          success,
        });
      }

      // Generate + send the deferred reply as a real outbound SMS.
      const history = await loadConversationHistory(deps.serviceClient, entry.conversationId);
      const voiceProfile = await loadVoiceProfile(deps.serviceClient, opts.merchantId);
      const customerContext = await loadCustomerContext(
        deps.serviceClient,
        opts.merchantId,
        customerId,
      );
      const generated = await generateReply(deps.generateClient, {
        classification,
        conversationHistory: history,
        voiceProfile,
        customerContext,
        model: opts.model,
      });

      const sent = await sendMessage(
        deps.serviceClient,
        deps.twilioClient,
        {
          merchantId: opts.merchantId,
          customerId,
          body: generated.reply.body,
          fromNumber: opts.fromNumber,
          // A degraded retry is a conversational reply, not a campaign send.
          campaignId: null,
          armId: null,
          outboundDailyCap: opts.outboundDailyCap,
        },
        { now },
      );
      if (sent.ok) {
        result.retried += 1;
      } else {
        result.stillDegraded += 1;
        logStructured("degraded_retry_send_skipped", {
          merchant_id: opts.merchantId,
          conversation_id: entry.conversationId,
          reason: sent.reason,
        });
      }
    } catch (err) {
      // A re-classify / re-generate failure: leave the degraded_mode event in
      // place so the next tick retries. Bounded by transient-error recovery.
      result.stillDegraded += 1;
      logStructured("degraded_retry_failed", {
        merchant_id: opts.merchantId,
        conversation_id: entry.conversationId,
        error_class: err instanceof Error ? err.name : "UnknownError",
      });
    }
  }

  logStructured("retry_degraded_complete", {
    merchant_id: opts.merchantId,
    retried: result.retried,
    opted_out: result.optedOut,
    still_degraded: result.stillDegraded,
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Degraded-retry loaders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns at most ONE open degraded inbound PER CONVERSATION — the latest one
 * still awaiting a reply. Rationale: a conversation that degraded several
 * times should get a single fresh reply addressing the customer's most recent
 * message, not a backlog of stale replies. "Open" means no outbound message
 * exists strictly after that inbound's sent_at (the synchronous fallback TwiML
 * is never persisted as a messages row). Only inbounds within
 * DEGRADED_RETRY_WINDOW_DAYS are returned — older ones are abandoned (the
 * no-reply sweep still folds the posterior in), which bounds the retry.
 */
async function loadOpenDegradedInbounds(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  now: Date,
): Promise<DegradedEntry[]> {
  const windowStart = new Date(
    now.getTime() - DEGRADED_RETRY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await serviceClient
    .from("message_events")
    .select("message_id, conversation_id, payload")
    .eq("merchant_id", merchantId)
    .eq("event_type", "degraded_mode");
  if (error) throw error;

  // Reduce to the latest in-window degraded inbound per conversation.
  const latestByConversation = new Map<
    string,
    { inboundMessageId: string; conversationId: string; phase: string; sentAt: string }
  >();
  for (const ev of data ?? []) {
    if (!ev.message_id) continue;
    const inbound = await serviceClient
      .from("messages")
      .select("sent_at")
      .eq("id", ev.message_id)
      .maybeSingle();
    if (inbound.error) throw inbound.error;
    if (!inbound.data) continue;
    const sentAt = inbound.data.sent_at as string;
    if (sentAt < windowStart) continue; // outside the retry window — abandon

    // Validate the phase against the enum; an unknown value cannot drive the
    // posterior decision. (routeBanditPosterior is itself idempotent, so a
    // wrong guess cannot double-fire — but validate for correctness anyway.)
    const phaseParsed = DegradedModePhase.safeParse(payloadString(ev.payload, "phase"));
    const phase = phaseParsed.success ? phaseParsed.data : "generate";

    const prior = latestByConversation.get(ev.conversation_id);
    if (!prior || sentAt > prior.sentAt) {
      latestByConversation.set(ev.conversation_id, {
        inboundMessageId: ev.message_id,
        conversationId: ev.conversation_id,
        phase,
        sentAt,
      });
    }
  }

  // Keep only conversations with no outbound AFTER the latest degraded inbound.
  const open: DegradedEntry[] = [];
  for (const entry of latestByConversation.values()) {
    const reply = await serviceClient
      .from("messages")
      .select("id")
      .eq("conversation_id", entry.conversationId)
      .eq("direction", "outbound")
      .gt("sent_at", entry.sentAt)
      .limit(1)
      .maybeSingle();
    if (reply.error) throw reply.error;
    if (reply.data) continue; // already replied — nothing to retry
    open.push({
      inboundMessageId: entry.inboundMessageId,
      conversationId: entry.conversationId,
      phase: entry.phase,
    });
  }
  return open;
}

interface InboundForRetry {
  redactedBody: string;
}

/** Loads the redacted body of a degraded inbound for re-classification. */
async function loadInboundForRetry(
  serviceClient: LapsedSupabaseClient,
  messageId: string,
): Promise<InboundForRetry | null> {
  const { data, error } = await serviceClient
    .from("messages")
    .select("pii_redacted_body")
    .eq("id", messageId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { redactedBody: data.pii_redacted_body };
}

/** Looks up a customer's phone from the materialized `customers` row. */
async function loadCustomerPhone(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  customerId: string,
): Promise<string | null> {
  const { data, error } = await serviceClient
    .from("customers")
    .select("phone")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", customerId)
    .maybeSingle();
  if (error) throw error;
  const phone = data?.phone;
  return phone && phone.trim().length > 0 ? phone : null;
}

/** Resolves a conversation's customer_id (shopify_customer_gid). */
async function loadConversationCustomer(
  serviceClient: LapsedSupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await serviceClient
    .from("conversations")
    .select("customer_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw error;
  return data?.customer_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function payloadString(payload: Json, key: string): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return null;
}

/** Single-line JSON structured log. Never includes raw phone, body, or PII. */
function logStructured(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
