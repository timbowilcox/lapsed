// Twilio client wrapper — the SINGLE seam between lapsed.ai and Twilio.
// Implements Sprint 07 chunk 2. No other module in the codebase imports the
// `twilio` SDK directly; everything routes through this wrapper so a future
// provider swap (or a channel beyond SMS — decision 3) touches one file.
//
// Three responsibilities:
//   - sendSms: outbound send with retry/backoff on transient failures
//   - validateWebhookSignature: Twilio's official request-signature check,
//     the security boundary on /api/sms/inbound (criterion 2)
//   - recordOptOut: the Twilio leg of decision 18's dual-recorded opt-out
//
// Pure-ish: all I/O is the injected SDK. Unit tests pass a fake `sdk`; the
// inbound-webhook integration test uses Twilio Test Credentials. Real
// credentials are runtime-only and never reach a test.

import twilio from "twilio";

// ─────────────────────────────────────────────────────────────────────────────
// Retry / backoff tuning
// ─────────────────────────────────────────────────────────────────────────────

/** Max send attempts on transient (5xx / 429 / network) Twilio failures. */
export const TWILIO_MAX_SEND_RETRIES = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_MAX_MS = 4000;

/**
 * Per-attempt wall-clock timeout on a Twilio send (criterion 9 — timeout +
 * retry). A `messages.create` that hangs past this is aborted and the attempt
 * is classified transient (retried). Without this the synchronous inbound
 * webhook's 5s p99 budget (decision 17) could be blown by a single stuck call.
 */
export const TWILIO_SEND_TIMEOUT_MS_DEFAULT = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// Minimal SDK surface
//
// Defining the slice of the Twilio SDK this wrapper depends on — rather than
// importing twilio's own (large) types — keeps the seam thin and lets unit
// tests inject a fake without constructing a real client.
// ─────────────────────────────────────────────────────────────────────────────

export interface TwilioMessageInstance {
  sid: string;
  status: string;
}

export interface TwilioSdk {
  messages: {
    create(opts: { to: string; from: string; body: string }): Promise<TwilioMessageInstance>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// sendSms types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log-only context. NEVER sent to Twilio and NEVER logged in raw form — only
 * the ids (already non-PII) reach structured logs.
 */
export interface SendSmsMetadata {
  campaignId?: string;
  armId?: string;
  customerId?: string;
}

export interface SendSmsInput {
  /** Customer phone, E.164. */
  to: string;
  /** Merchant Twilio number, E.164. */
  from: string;
  body: string;
  metadata?: SendSmsMetadata;
}

export type SendSmsResult =
  | { ok: true; twilioSid: string; status: string; attempts: number }
  | {
      ok: false;
      /** Twilio error code (e.g. 21610 opted-out) when present, else the HTTP status, else null. */
      errorCode: number | null;
      errorClass: string;
      detail: string;
      attempts: number;
    };

// ─────────────────────────────────────────────────────────────────────────────
// TwilioClient — the wrapper interface (the swap seam)
// ─────────────────────────────────────────────────────────────────────────────

export interface TwilioClient {
  /**
   * Sends one SMS. Transient failures (HTTP 5xx, 429, network/timeout) retry
   * up to TWILIO_MAX_SEND_RETRIES with exponential backoff. Permanent failures
   * (HTTP 4xx other than 429 — bad number, opted-out, auth) return
   * `{ ok: false }` immediately without retry. Never throws for a Twilio-side
   * failure — the caller inspects `result.ok` and records the outcome event.
   */
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
  /**
   * The Twilio leg of decision 18's dual-recorded opt-out. Throws on failure
   * so the caller (recordOptOut in opt-out-registry.ts) can emit a critical
   * structured-log event — a silent Twilio-side failure must not pass.
   */
  recordOptOut(phoneNumber: string): Promise<void>;
}

export interface TwilioClientOptions {
  accountSid: string;
  authToken: string;
  /** Injected SDK for unit tests; defaults to a real twilio() client. */
  sdk?: TwilioSdk;
  /**
   * Injected opt-out handler for unit tests. Defaults to
   * `defaultOptOutHandler`. See decision 18 note on `defaultOptOutHandler`.
   */
  optOutHandler?: (phoneNumber: string) => Promise<void>;
  /** Injected sleep for fast tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt send timeout; defaults to TWILIO_SEND_TIMEOUT_MS_DEFAULT. */
  sendTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a TwilioClient. In production `sdk` is omitted and a real
 * `twilio(accountSid, authToken)` client is constructed. Unit tests pass a
 * fake `sdk` (and usually a fake `optOutHandler` + instant `sleep`).
 */
export function createTwilioClient(opts: TwilioClientOptions): TwilioClient {
  const sdk: TwilioSdk =
    opts.sdk ?? (twilio(opts.accountSid, opts.authToken) as unknown as TwilioSdk);
  const optOutHandler = opts.optOutHandler ?? defaultOptOutHandler;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sendTimeoutMs = opts.sendTimeoutMs ?? TWILIO_SEND_TIMEOUT_MS_DEFAULT;

  return {
    async sendSms(input: SendSmsInput): Promise<SendSmsResult> {
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= TWILIO_MAX_SEND_RETRIES; attempt++) {
        if (attempt > 1) await sleep(computeBackoffMs(attempt - 1));
        try {
          const message = await withTimeout(
            sdk.messages.create({
              to: input.to,
              from: input.from,
              body: input.body,
            }),
            sendTimeoutMs,
          );
          return { ok: true, twilioSid: message.sid, status: message.status, attempts: attempt };
        } catch (err) {
          lastErr = err;
          const cls = classifyTwilioError(err);
          if (cls.kind === "permanent") {
            logStructured("twilio_send_failed", {
              reason: "permanent",
              error_code: cls.errorCode,
              error_class: cls.errorClass,
              to: maskPhone(input.to),
              campaign_id: input.metadata?.campaignId ?? null,
              arm_id: input.metadata?.armId ?? null,
              attempts: attempt,
            });
            return {
              ok: false,
              errorCode: cls.errorCode,
              errorClass: cls.errorClass,
              detail: cls.detail,
              attempts: attempt,
            };
          }
          // transient — fall through to the next attempt
          logStructured("twilio_send_retry", {
            error_code: cls.errorCode,
            error_class: cls.errorClass,
            to: maskPhone(input.to),
            attempt,
          });
        }
      }
      const cls = classifyTwilioError(lastErr);
      logStructured("twilio_send_failed", {
        reason: "exhausted_retries",
        error_code: cls.errorCode,
        error_class: cls.errorClass,
        to: maskPhone(input.to),
        attempts: TWILIO_MAX_SEND_RETRIES,
      });
      return {
        ok: false,
        errorCode: cls.errorCode,
        errorClass: cls.errorClass,
        detail: cls.detail,
        attempts: TWILIO_MAX_SEND_RETRIES,
      };
    },

    async recordOptOut(phoneNumber: string): Promise<void> {
      await optOutHandler(phoneNumber);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateWebhookSignature — the inbound-webhook security boundary
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidateWebhookSignatureInput {
  authToken: string;
  /** The X-Twilio-Signature header value. */
  signature: string;
  /** The fully-qualified URL Twilio POSTed to (must match exactly). */
  url: string;
  /** The POST body as a flat string map (URL-encoded form fields). */
  params: Record<string, string>;
}

/**
 * Validates a Twilio webhook request signature using Twilio's OWN official
 * `validateRequest` helper (criterion 2 — no custom HMAC implementation). A
 * tampered or forged request fails this check; the inbound route returns 403
 * before parsing the body or touching the database.
 *
 * A malformed signature or a thrown SDK error is treated as INVALID (returns
 * false) rather than propagating — an exception must never be mistaken for a
 * pass.
 */
export function validateWebhookSignature(input: ValidateWebhookSignatureInput): boolean {
  try {
    return twilio.validateRequest(input.authToken, input.signature, input.url, input.params);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Default opt-out handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The default Twilio-side opt-out behavior for v1.
 *
 * DECISION 18 NOTE: Twilio NATIVELY records STOP/UNSUBSCRIBE-keyword opt-outs
 * the moment the customer texts the keyword to the Twilio number — for the
 * keyword path Twilio's tracking is already updated with no API call from us.
 * Twilio exposes no public REST endpoint to add an arbitrary number to its
 * opt-out list for a non-keyword (Sonnet-classified) opt-out. Decision 18
 * names `customer_opt_outs` the application source of truth and Twilio the
 * safety net; v1's enforcement gate is `assertNotOptedOut` reading our table.
 *
 * This handler is therefore the seam: it emits an auditable structured log
 * confirming the Twilio-side leg ran. When a Twilio Messaging Service with
 * managed opt-outs is provisioned (post-v1), inject an `optOutHandler` that
 * POSTs the suppression — no other code changes.
 */
async function defaultOptOutHandler(phoneNumber: string): Promise<void> {
  logStructured("twilio_opt_out_recorded", { phone: maskPhone(phoneNumber) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

interface TwilioErrorClassification {
  kind: "transient" | "permanent";
  errorCode: number | null;
  errorClass: string;
  detail: string;
}

/**
 * Classifies a thrown Twilio/network error as transient (retry) or permanent
 * (give up). Twilio SDK errors carry a numeric `status` (HTTP) and `code`
 * (Twilio error code). HTTP 5xx and 429 are transient; other 4xx are
 * permanent. A network/timeout error with no `status` is transient.
 */
function classifyTwilioError(err: unknown): TwilioErrorClassification {
  const e = err as { status?: number; code?: number; message?: string; name?: string } | null;
  const httpStatus = typeof e?.status === "number" ? e.status : null;
  const twilioCode = typeof e?.code === "number" ? e.code : null;
  const errorClass = e?.name ?? "Error";
  const detail = (e?.message ?? "unknown_twilio_error").slice(0, 200);
  // Twilio error code is the most specific signal; fall back to HTTP status.
  const errorCode = twilioCode ?? httpStatus;

  if (httpStatus === null) {
    // No HTTP status — a network / wrapper-timeout / abort error. Transient.
    return { kind: "transient", errorCode, errorClass, detail };
  }
  // 429 (rate limit), 408 (request timeout), and all 5xx are transient.
  if (httpStatus === 429 || httpStatus === 408 || httpStatus >= 500) {
    return { kind: "transient", errorCode, errorClass, detail };
  }
  // 4xx other than 408/429 — bad request, opted-out recipient, auth. Permanent.
  return { kind: "permanent", errorCode, errorClass, detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-attempt timeout
// ─────────────────────────────────────────────────────────────────────────────

/** Error thrown when a send attempt exceeds its wall-clock timeout. */
class TwilioTimeoutError extends Error {
  constructor(ms: number) {
    super(`twilio send attempt exceeded ${ms}ms timeout`);
    this.name = "TwilioTimeoutError";
  }
}

/**
 * Races a Twilio call against a wall-clock timeout. A timeout rejects with a
 * `TwilioTimeoutError` — which carries no HTTP `status`, so classifyTwilioError
 * treats it as transient and the send is retried. The timer is always cleared
 * so a resolved race leaves no dangling handle (open-handle warnings in tests).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new TwilioTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Exponential backoff with jitter, capped at BACKOFF_MAX_MS. `step` is the
 * retry index (>= 1). Exported for direct unit testing of the backoff curve.
 */
export function computeBackoffMs(step: number): number {
  const raw = BACKOFF_BASE_MS * 2 ** (step - 1);
  const jitter = Math.floor(Math.random() * BACKOFF_BASE_MS);
  return Math.min(raw + jitter, BACKOFF_MAX_MS);
}

/**
 * Masks a phone number for logs — keeps only the last 4 digits (criterion 8:
 * no customer phone in logs). Exported so callers building their own log
 * lines reuse the exact masking.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return "***";
  return `***${digits.slice(-4)}`;
}

/** Single-line JSON structured log. Never includes raw phone, body, or PII. */
function logStructured(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
