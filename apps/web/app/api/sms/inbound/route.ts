// Twilio inbound SMS webhook — the synchronous-reply heart of decision 17.
// Implements Sprint 07 chunk 7.
//
// Flow: parse the Twilio form POST → validate the request signature (403 on
// failure, before any business logic) → hand off to handleInboundMessage,
// which runs the in-band classify/opt-out/generate flow within the latency
// budget → render the reply (or fallback) as TwiML.
//
// Security boundary (criterion 2): a tampered or forged request fails
// validateWebhookSignature and gets a 403 with no DB writes and no LLM calls.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import {
  validateWebhookSignature,
  createTwilioClient,
  createClassifyClient,
  createGenerateClient,
  handleInboundMessage,
  DEGRADED_FALLBACK_REPLY,
} from "@lapsed/core";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Twilio's own webhook timeout is 15s; our latency budget is 5s. 30s of
// function headroom covers a worst-case cold start plus the budget.
export const maxDuration = 30;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();
  const startMs = Date.now();

  // ── Parse the Twilio form POST ─────────────────────────────────────────────
  // Twilio sends application/x-www-form-urlencoded. Parsing the form is a
  // prerequisite of signature validation — it is NOT business logic.
  let params: Record<string, string>;
  try {
    const form = await request.formData();
    params = {};
    for (const [key, value] of form.entries()) {
      params[key] = typeof value === "string" ? value : "";
    }
  } catch {
    return xmlResponse(emptyTwiml(), 400);
  }

  // ── Validate the Twilio request signature (criterion 2) ────────────────────
  // Reconstruct the externally-visible URL Twilio signed against — behind
  // Vercel's proxy `request.url` may carry an internal host.
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const signedUrl = `${proto}://${host}${url.pathname}${url.search}`;
  const signature = request.headers.get("x-twilio-signature") ?? "";

  const valid = validateWebhookSignature({
    authToken: env.twilioAuthToken,
    signature,
    url: signedUrl,
    params,
  });
  if (!valid) {
    console.warn(
      JSON.stringify({ event: "sms_inbound_signature_rejected", elapsed_ms: Date.now() - startMs }),
    );
    // 403 before any DB write or LLM call.
    return new NextResponse("Forbidden", { status: 403 });
  }

  // ── Hand off to the in-band orchestrator ───────────────────────────────────
  const from = params.From ?? "";
  const to = params.To ?? "";
  const body = params.Body ?? "";
  const twilioSid = params.MessageSid ?? params.SmsSid ?? "";

  // A signature-valid Twilio request always carries a MessageSid; its absence
  // means a malformed request. Without it the retry-idempotency key is empty,
  // so reject rather than process an un-dedupable inbound.
  if (!twilioSid) {
    console.warn(
      JSON.stringify({ event: "sms_inbound_missing_sid", elapsed_ms: Date.now() - startMs }),
    );
    return xmlResponse(emptyTwiml(), 200);
  }

  try {
    const serviceClient = createServiceClient({
      url: env.supabaseUrl,
      serviceKey: env.supabaseSecretKey,
    });
    const twilioClient = createTwilioClient({
      accountSid: env.twilioAccountSid,
      authToken: env.twilioAuthToken,
      // Keep the wrapper's per-send timeout well under our reply budget.
      sendTimeoutMs: Math.max(2000, env.inboundReplyLatencyBudgetMs - 1000),
    });
    const classifyClient = createClassifyClient({ apiKey: env.anthropicApiKey });
    const generateClient = createGenerateClient({ apiKey: env.anthropicApiKey });

    const result = await handleInboundMessage(
      { serviceClient, twilioClient, classifyClient, generateClient },
      {
        fromNumber: from,
        toNumber: to,
        body,
        twilioSid,
        latencyBudgetMs: env.inboundReplyLatencyBudgetMs,
        model: env.sonnetModel,
      },
    );

    console.log(
      JSON.stringify({
        event: "sms_inbound_handled",
        outcome: result.outcome,
        elapsed_ms: Date.now() - startMs,
        timings: result.timings,
      }),
    );

    return xmlResponse(result.replyBody ? messageTwiml(result.replyBody) : emptyTwiml(), 200);
  } catch (err) {
    // A true error (DB outage, etc.) — return a safe fallback rather than a
    // 5xx, so Twilio does not retry-storm and the customer still gets a reply.
    console.error(
      JSON.stringify({
        event: "sms_inbound_error",
        error_class: err instanceof Error ? err.name : "UnknownError",
        elapsed_ms: Date.now() - startMs,
      }),
    );
    return xmlResponse(messageTwiml(DEGRADED_FALLBACK_REPLY), 200);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TwiML rendering
// ─────────────────────────────────────────────────────────────────────────────

function emptyTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function messageTwiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(body)}</Message></Response>`;
}

/** XML-escapes a reply body for safe inclusion in the TwiML response. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlResponse(xml: string, status: number): NextResponse {
  return new NextResponse(xml, {
    status,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}
