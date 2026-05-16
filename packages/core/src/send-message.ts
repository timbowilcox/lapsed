// Outbound message engine — the end-to-end `sendMessage` orchestrator.
// Implements Sprint 07 chunk 6. Mirrors the orchestrator pattern of
// run-voice-extraction.ts / propose-campaign.ts.
//
// Decision 3 (channel-agnostic): the function is `sendMessage`, NOT `sendSms`.
// `channel` is a parameter (default "sms"); v1 wires only the Twilio SMS
// provider but the signature, the events, and the rows all carry channel.
//
// Decision 18: `assertNotOptedOut` is the mandatory pre-flight gate.
//
// Flow:
//   1. Pre-flight — assertNotOptedOut, daily-cap check, customer phone lookup
//   2. ensureConversation (decision 16 — one thread per customer)
//   3. Append message_outbound_queued event
//   4. twilio.sendSms with {campaign_id, arm_id, customer_id} metadata
//   5a. success → insert messages row + message_outbound_sent event
//   5b. failure → message_outbound_failed event
//   6. recordConversationActivity (advance last_message_at, message_count)
//
// sendMessage returns a discriminated result rather than throwing for the
// EXPECTED skip outcomes (opted-out, daily-cap reached, no phone, Twilio
// failure) — the campaign launcher cron (chunk 8) inspects `ok` to decide
// whether to continue, skip this customer, or stop for the day. A genuine
// programming error (bad UUID, DB outage) still throws.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type { TwilioClient } from "./twilio-client";
import { redact } from "./pii-redactor";
import { assertNotOptedOut, OptOutError } from "./opt-out-registry";
import {
  appendMessageEvent,
  ensureConversation,
  recordConversationActivity,
} from "./message-events";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

const SendMessageInputSchema = z.object({
  merchantId: z.string().uuid("merchantId must be a UUID"),
  customerId: z.string().min(1, "customerId is required"),
  body: z.string().min(1, "body is required"),
  /** Merchant outbound number, E.164 (TWILIO_PHONE_NUMBER). */
  fromNumber: z.string().min(1, "fromNumber is required"),
  /** Channel — decision 3. Defaults to "sms". */
  channel: z.string().min(1).default("sms"),
  /** Proposal id when this outbound is campaign-driven; null for an ad-hoc reply. */
  campaignId: z.string().uuid().nullable().default(null),
  /** bandit_arm_id of the sampled arm; null when not campaign-driven. */
  armId: z.string().uuid().nullable().default(null),
  /** Per-merchant per-UTC-day outbound cap (cost discipline). */
  outboundDailyCap: z.number().int().min(0),
});

export type SendMessageInput = z.input<typeof SendMessageInputSchema>;

export type SendMessageSkipReason =
  | "opted_out"
  | "cap_reached"
  | "no_phone"
  | "twilio_failed"
  | "already_sent";

export type SendMessageResult =
  | { ok: true; messageId: string; conversationId: string; twilioSid: string }
  | {
      ok: false;
      reason: SendMessageSkipReason;
      conversationId: string | null;
      detail: string;
    };

export interface SendMessageOptions {
  /** Override for unit tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// sendMessage
// ─────────────────────────────────────────────────────────────────────────────

export async function sendMessage(
  serviceClient: LapsedSupabaseClient,
  twilioClient: TwilioClient,
  rawInput: SendMessageInput,
  opts: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const input = SendMessageInputSchema.parse(rawInput);
  const now = opts.now ?? (() => new Date());

  // ── Pre-flight 1: opt-out gate (decision 18) ───────────────────────────────
  try {
    await assertNotOptedOut(serviceClient, input.merchantId, input.customerId);
  } catch (err) {
    if (err instanceof OptOutError) {
      logStructured("send_message_skipped", {
        reason: "opted_out",
        merchant_id: input.merchantId,
        customer_id: input.customerId,
      });
      return { ok: false, reason: "opted_out", conversationId: null, detail: "customer opted out" };
    }
    throw err;
  }

  // ── Pre-flight 2: daily cap (cost discipline) ──────────────────────────────
  const sentToday = await countOutboundSentToday(serviceClient, input.merchantId, now());
  if (sentToday >= input.outboundDailyCap) {
    logStructured("send_message_skipped", {
      reason: "cap_reached",
      merchant_id: input.merchantId,
      sent_today: sentToday,
      cap: input.outboundDailyCap,
    });
    return {
      ok: false,
      reason: "cap_reached",
      conversationId: null,
      detail: `daily cap ${input.outboundDailyCap} reached`,
    };
  }

  // ── Pre-flight 3: customer phone lookup ────────────────────────────────────
  const phone = await lookupCustomerPhone(serviceClient, input.merchantId, input.customerId);
  if (!phone) {
    logStructured("send_message_skipped", {
      reason: "no_phone",
      merchant_id: input.merchantId,
      customer_id: input.customerId,
    });
    return { ok: false, reason: "no_phone", conversationId: null, detail: "customer has no phone" };
  }

  // ── Ensure the per-customer conversation (decision 16) ─────────────────────
  const { conversationId } = await ensureConversation(serviceClient, {
    merchantId: input.merchantId,
    customerId: input.customerId,
    channel: input.channel,
  });

  // ── Idempotency guard for campaign-driven sends ────────────────────────────
  // A campaign sends each customer exactly one outbound. If a prior outbound
  // for this (conversation, campaign) already exists — e.g. the launch cron
  // crashed mid-batch and re-ran — skip rather than re-send. The chunk-8 cron
  // is the only campaign caller and runs single-threaded per merchant, so a
  // check-then-send TOCTOU is not a concern; this guard defends the re-run
  // case. Ad-hoc replies (campaignId null) are sent once by the webhook and
  // are not retried, so they need no guard.
  if (input.campaignId) {
    const priorSendId = await findCampaignOutbound(
      serviceClient,
      conversationId,
      input.campaignId,
    );
    if (priorSendId) {
      logStructured("send_message_skipped", {
        reason: "already_sent",
        merchant_id: input.merchantId,
        conversation_id: conversationId,
        campaign_id: input.campaignId,
      });
      return {
        ok: false,
        reason: "already_sent",
        conversationId,
        detail: "a campaign outbound already exists for this customer",
      };
    }
  }

  // ── Queued event (no messages row yet — message_id null) ───────────────────
  const baseTime = now().getTime();
  await appendMessageEvent(serviceClient, {
    eventType: "message_outbound_queued",
    merchantId: input.merchantId,
    conversationId,
    messageId: null,
    occurredAt: new Date(baseTime).toISOString(),
    payload: { campaign_id: input.campaignId, arm_id: input.armId },
  });

  // ── Send via Twilio ────────────────────────────────────────────────────────
  const sendResult = await twilioClient.sendSms({
    to: phone,
    from: input.fromNumber,
    body: input.body,
    metadata: {
      campaignId: input.campaignId ?? undefined,
      armId: input.armId ?? undefined,
      customerId: input.customerId,
    },
  });

  if (!sendResult.ok) {
    await appendMessageEvent(serviceClient, {
      eventType: "message_outbound_failed",
      merchantId: input.merchantId,
      conversationId,
      messageId: null,
      occurredAt: new Date(baseTime + 1).toISOString(),
      payload: { error_code: sendResult.errorCode, error_class: sendResult.errorClass },
    });
    logStructured("send_message_failed", {
      merchant_id: input.merchantId,
      conversation_id: conversationId,
      campaign_id: input.campaignId,
      error_code: sendResult.errorCode,
      error_class: sendResult.errorClass,
    });
    return {
      ok: false,
      reason: "twilio_failed",
      conversationId,
      detail: `twilio error ${sendResult.errorCode ?? "unknown"}`,
    };
  }

  // ── Success — insert the messages row + sent event ─────────────────────────
  const sentAt = new Date(baseTime + 2).toISOString();
  const { data: messageRow, error: insertErr } = await serviceClient
    .from("messages")
    .insert({
      merchant_id: input.merchantId,
      conversation_id: conversationId,
      direction: "outbound",
      channel: input.channel,
      body: input.body,
      pii_redacted_body: redact(input.body).redacted,
      twilio_sid: sendResult.twilioSid,
      campaign_id: input.campaignId,
      arm_id: input.armId,
      status: "sent",
      sent_at: sentAt,
    })
    .select("id")
    .single();
  if (insertErr || !messageRow) {
    throw insertErr ?? new Error("sendMessage: messages insert returned no row");
  }

  await appendMessageEvent(serviceClient, {
    eventType: "message_outbound_sent",
    merchantId: input.merchantId,
    conversationId,
    messageId: messageRow.id,
    occurredAt: sentAt,
    payload: { twilio_sid: sendResult.twilioSid },
  });

  await recordConversationActivity(serviceClient, {
    merchantId: input.merchantId,
    customerId: input.customerId,
    occurredAt: sentAt,
    direction: "outbound",
  });

  logStructured("send_message_sent", {
    merchant_id: input.merchantId,
    conversation_id: conversationId,
    message_id: messageRow.id,
    campaign_id: input.campaignId,
    arm_id: input.armId,
    twilio_attempts: sendResult.attempts,
  });

  return { ok: true, messageId: messageRow.id, conversationId, twilioSid: sendResult.twilioSid };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Counts `message_outbound_sent` events for a merchant since UTC midnight. */
async function countOutboundSentToday(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  now: Date,
): Promise<number> {
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const { count, error } = await serviceClient
    .from("message_events")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("event_type", "message_outbound_sent")
    .gte("occurred_at", utcMidnight.toISOString());
  if (error) throw error;
  return count ?? 0;
}

/**
 * Returns the id of an existing outbound `messages` row for this conversation
 * + campaign, or null. Backs the campaign-send idempotency guard so a re-run
 * of the launch cron does not double-send.
 */
async function findCampaignOutbound(
  serviceClient: LapsedSupabaseClient,
  conversationId: string,
  campaignId: string,
): Promise<string | null> {
  const { data, error } = await serviceClient
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("campaign_id", campaignId)
    .eq("direction", "outbound")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/** Looks up the customer's phone from the materialized `customers` row. */
async function lookupCustomerPhone(
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

/** Single-line JSON structured log. Never includes raw phone, body, or PII. */
function logStructured(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
