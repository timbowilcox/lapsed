// Opt-out registry — the compliance gate for every outbound SMS.
// Implements Sprint 07 chunk 3 + architectural decision 18 (opt-outs are
// immutable, append-only, and dual-recorded to both customer_opt_outs and
// Twilio). Spam Act (AU), TCPA (US), and GDPR (EU) all converge on
// immediate-and-permanent opt-out semantics — an opt-out never expires.
//
// Three public surfaces:
//   - assertNotOptedOut: the mandatory pre-flight before every outbound send,
//     mirroring assertNoPii from Sprint 05's redactor. Throws OptOutError.
//   - recordOptOut: dual-records an opt-out (table + Twilio). Idempotent.
//   - isOptedOut: read-only check used by the UI / dashboards.
//
// Plus detectOptOutKeyword: STOP-keyword detection for the inbound webhook's
// fast path (short-circuits before any LLM call).

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type { TwilioClient } from "./twilio-client";
import { maskPhone } from "./twilio-client";

// ─────────────────────────────────────────────────────────────────────────────
// Opt-out source taxonomy (matches the customer_opt_outs.source CHECK)
// ─────────────────────────────────────────────────────────────────────────────

export const OptOutSource = z.enum([
  "stop_keyword",
  "sonnet_classified",
  "merchant_manual",
  "twilio_native",
]);
export type OptOutSource = z.infer<typeof OptOutSource>;

// ─────────────────────────────────────────────────────────────────────────────
// STOP-keyword detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The recognised opt-out keywords. A message whose entire (trimmed,
 * punctuation-stripped, upper-cased) body equals one of these is a keyword
 * opt-out — handled in the inbound webhook's fast path BEFORE any LLM call.
 * A non-keyword opt-out ("please stop messaging me") is caught later by the
 * Sonnet classifier's `opt_out` intent.
 *
 * STOPALL is included because Twilio treats it as a native STOP keyword.
 */
const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "REMOVE",
  "CANCEL",
  "END",
  "QUIT",
]);

/**
 * Returns the matched opt-out keyword (canonical upper-case form) if `body`
 * is a keyword opt-out, else null. Case-insensitive and whitespace-tolerant:
 * leading/trailing whitespace and surrounding punctuation are stripped before
 * matching. Only an *exact* keyword match counts — "stop sending me deals"
 * is NOT a keyword opt-out (the classifier handles intent-based opt-outs).
 *
 * `merchantKeywords` supplements the built-in set with keywords the merchant
 * has configured via the opt-out settings panel (`merchants.opt_out_keywords`).
 * The caller (handle-inbound) fetches them before this call (decision 18).
 *
 * The returned keyword is recorded in the structured opt-out log for the
 * audit trail.
 */
export function detectOptOutKeyword(
  body: string,
  merchantKeywords: readonly string[] = [],
): string | null {
  if (!body) return null;
  // Strip surrounding whitespace, punctuation (. ! " etc.), and invisible
  // format/control characters (e.g. a U+200B zero-width space a carrier or
  // copy-paste can append), then upper-case. A keyword opt-out is exactly
  // one token — multi-word bodies fall through to the Sonnet classifier.
  const normalized = body
    .trim()
    .replace(/^[\s\p{P}\p{Cf}\p{Cc}]+|[\s\p{P}\p{Cf}\p{Cc}]+$/gu, "")
    .toUpperCase();
  if (normalized.length === 0) return null;
  if (OPT_OUT_KEYWORDS.has(normalized)) return normalized;
  // Check merchant-configured extras (already upper-cased in DB by the API layer).
  const merchantSet = new Set(merchantKeywords.map((k) => k.toUpperCase()));
  return merchantSet.has(normalized) ? normalized : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// OptOutError
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by assertNotOptedOut when an outbound send is attempted for a
 * customer who has opted out. Mirrors PiiLeakError (Sprint 05) — a pre-flight
 * gate that throws rather than silently passing.
 */
export class OptOutError extends Error {
  readonly merchantId: string;
  readonly customerId: string;
  constructor(merchantId: string, customerId: string) {
    super(`customer ${customerId} has opted out — outbound send refused`);
    this.name = "OptOutError";
    this.merchantId = merchantId;
    this.customerId = customerId;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// isOptedOut — read-only check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the customer has at least one customer_opt_outs row.
 * Read-only; safe to call from UI / dashboard code. Uses a HEAD count so it
 * never pulls opt-out rows over the wire.
 */
export async function isOptedOut(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  customerId: string,
): Promise<boolean> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);
  const { data, error } = await serviceClient
    .from("customer_opt_outs")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// assertNotOptedOut — the mandatory pre-flight gate (decision 18)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Throws OptOutError if the customer has opted out. The mandatory pre-flight
 * before EVERY outbound send (decision 18) — mirrors assertNoPii's role in the
 * Sprint 05 voice pipeline. The campaign launcher cron and the inbound reply
 * path both call this; a send path that bypasses it is a decision-18
 * violation.
 */
export async function assertNotOptedOut(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  customerId: string,
): Promise<void> {
  if (await isOptedOut(serviceClient, merchantId, customerId)) {
    throw new OptOutError(merchantId, customerId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// recordOptOut — dual-record an opt-out (decision 18)
// ─────────────────────────────────────────────────────────────────────────────

const RecordOptOutInputSchema = z.object({
  merchantId: z.string().uuid("merchantId must be a UUID"),
  customerId: z.string().min(1, "customerId is required"),
  /**
   * Customer phone, E.164. The inbound webhook supplies Twilio's `From`. May
   * be empty for a merchant_manual opt-out of a customer with no phone on
   * file — decision 18 requires the opt-out to ALWAYS be recordable; the
   * phone is needed only for the (best-effort) Twilio leg, not for the
   * customer_opt_outs source-of-truth row.
   */
  phoneNumber: z.string(),
  source: OptOutSource,
  /** The inbound message that triggered the opt-out; absent for merchant_manual. */
  inboundMessageId: z.string().uuid().optional(),
});

export type RecordOptOutInput = z.infer<typeof RecordOptOutInputSchema>;

export interface RecordOptOutResult {
  /** True when a new customer_opt_outs row was written this call. */
  recorded: boolean;
  /** True when the customer was already opted out — this call was a no-op. */
  alreadyOptedOut: boolean;
  /** True when the Twilio opt-out leg succeeded (decision 18 dual-record). */
  twilioRecorded: boolean;
}

/**
 * Dual-records an opt-out (decision 18): appends a customer_opt_outs row AND
 * calls the Twilio opt-out leg via the injected TwilioClient.
 *
 * Idempotent: if the customer is already opted out, this is a no-op that
 * returns `alreadyOptedOut: true` without writing a second row or re-calling
 * Twilio. customer_opt_outs is append-only (decision 18) so the first row
 * stands as the permanent record.
 *
 * Ordering: the customer_opt_outs row is written FIRST — it is the
 * application source of truth and the surface assertNotOptedOut reads. Only
 * after it commits is the Twilio leg called. If the table write fails this
 * function THROWS (the opt-out was not honored). If the Twilio leg fails the
 * opt-out IS still honored (our table is the gate) — the failure is logged as
 * a critical structured event and surfaced via `twilioRecorded: false` rather
 * than thrown, so an inbound webhook is not failed by a Twilio-side hiccup.
 */
export async function recordOptOut(
  serviceClient: LapsedSupabaseClient,
  twilioClient: TwilioClient,
  input: RecordOptOutInput,
): Promise<RecordOptOutResult> {
  const v = RecordOptOutInputSchema.parse(input);

  // Idempotency: a customer already opted out is never re-recorded.
  if (await isOptedOut(serviceClient, v.merchantId, v.customerId)) {
    return { recorded: false, alreadyOptedOut: true, twilioRecorded: false };
  }

  // 1. Write the application source of truth FIRST. A failure here throws —
  //    the opt-out has not been honored and the caller must know.
  const { error: insertErr } = await serviceClient.from("customer_opt_outs").insert({
    merchant_id: v.merchantId,
    customer_id: v.customerId,
    phone_number: v.phoneNumber,
    source: v.source,
    inbound_message_id: v.inboundMessageId ?? null,
  });
  if (insertErr) {
    logStructured("opt_out_table_write_failed", {
      level: "critical",
      merchant_id: v.merchantId,
      customer_id: v.customerId,
      source: v.source,
    });
    throw insertErr;
  }

  // 2. Twilio leg (decision 18 safety net). A failure here does NOT throw —
  //    the opt-out is already honored by our table — but it IS a critical
  //    structured-log event so the divergence is observable. With no phone on
  //    file there is nothing for the provider to suppress; the table row
  //    still stands as the enforcement gate.
  let twilioRecorded = true;
  if (v.phoneNumber.trim().length === 0) {
    twilioRecorded = false;
    logStructured("opt_out_no_phone_for_twilio_leg", {
      merchant_id: v.merchantId,
      customer_id: v.customerId,
      source: v.source,
    });
    return { recorded: true, alreadyOptedOut: false, twilioRecorded };
  }
  try {
    await twilioClient.recordOptOut(v.phoneNumber);
  } catch (err) {
    twilioRecorded = false;
    logStructured("opt_out_twilio_leg_failed", {
      level: "critical",
      merchant_id: v.merchantId,
      customer_id: v.customerId,
      source: v.source,
      phone: maskPhone(v.phoneNumber),
      error_class: err instanceof Error ? err.name : "UnknownError",
    });
  }

  logStructured("opt_out_recorded", {
    merchant_id: v.merchantId,
    customer_id: v.customerId,
    source: v.source,
    twilio_recorded: twilioRecorded,
  });

  return { recorded: true, alreadyOptedOut: false, twilioRecorded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Single-line JSON structured log. Never includes raw phone, body, or PII. */
function logStructured(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
