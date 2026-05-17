// Stripe webhook endpoint — Sprint 09 chunk 8.
//
// Decision 32: the Stripe signature is verified against the RAW request body
// BEFORE the body is parsed. `request.text()` reads the raw bytes;
// `verifyWebhookEvent` (Stripe's constructEvent) verifies the HMAC and only
// then parses. A tampered/absent signature → 400 with ZERO database writes.
//
// Idempotency, the subscription_events audit row, and all mirror-state
// transitions live in `handleStripeWebhookEvent` (@lapsed/core). Re-delivery
// is safe. Unknown event types return 200 (never fail Stripe's stream).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { handleStripeWebhookEvent } from "@lapsed/core";
import { serverEnv, billingEnv } from "@/app/lib/env";
import { billingStripeClient } from "@/app/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Raw body — required for signature verification. NEVER JSON.parse before
  // the signature is verified (decision 32).
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  // ── Signature verification — BEFORE body parsing, BEFORE any DB write ──────
  let event;
  try {
    event = billingStripeClient().verifyWebhookEvent(rawBody, signature);
  } catch {
    // Never log the body or the signature header. Category only.
    console.warn(JSON.stringify({ event: "stripe_webhook_signature_rejected" }));
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const startedAt = Date.now();
  try {
    const result = await handleStripeWebhookEvent(client, event, {
      priceIds: billingEnv().stripePriceIds,
    });
    console.info(
      `stripe_webhook event_type=${result.eventType} status=${result.status} ` +
        `event_id=${event.id} elapsed_ms=${Date.now() - startedAt}`,
    );
    return NextResponse.json({ received: true, status: result.status });
  } catch (err) {
    // A processing failure returns 500 so Stripe re-delivers; the handler is
    // idempotent, so the retry is safe.
    console.error(
      JSON.stringify({
        event: "stripe_webhook_processing_failed",
        event_id: event.id,
        event_type: event.type,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "webhook_processing_failed" }, { status: 500 });
  }
}
