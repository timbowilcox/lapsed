import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhookHmac } from "@lapsed/shopify";
import { createServiceClient, type Json } from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";
import { getHandler } from "./handlers/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();

  // Read raw body as Buffer before any parsing — required for HMAC verification.
  const rawBody = Buffer.from(await request.arrayBuffer());
  const hmacHeader = request.headers.get("x-shopify-hmac-sha256") ?? "";
  const topic = request.headers.get("x-shopify-topic") ?? "";
  const shopDomain = request.headers.get("x-shopify-domain") ?? "";
  const webhookId = request.headers.get("x-shopify-webhook-id") ?? "";

  // Verify HMAC first — reject immediately on failure without processing.
  if (!verifyWebhookHmac(rawBody, hmacHeader, env.shopifyApiSecret)) {
    return new NextResponse(null, { status: 401 });
  }

  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Resolve merchant_id from shop domain. A webhook for an uninstalled / unknown
  // shop is still acknowledged with 200 so Shopify does not retry endlessly.
  const { data: merchantRow } = await serviceClient
    .from("merchants")
    .select("id")
    .eq("shopify_shop_domain", shopDomain)
    .single();

  const merchantId = merchantRow?.id ?? null;

  // Shopify guarantees X-Shopify-Webhook-Id on every delivery (API 2026-04+).
  // A missing ID is a malformed delivery — acknowledge and skip processing so
  // we do not write a synthetic row that wastes the idempotency table's slot.
  if (!webhookId) {
    console.warn(`webhook_missing_id topic=${topic}`);
    return new NextResponse(null, { status: 200 });
  }

  // Idempotency check: if this webhookId has already been processed, return 200
  // immediately without re-processing. shopify_webhook_id has a UNIQUE constraint.
  const { data: existing } = await serviceClient
    .from("webhook_deliveries")
    .select("id, status")
    .eq("shopify_webhook_id", webhookId)
    .maybeSingle();

  if (existing) {
    return new NextResponse(null, { status: 200 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    // Malformed JSON — log the topic but do not re-throw; still acknowledge.
    console.warn(`webhook_parse_error topic=${topic}`);
    payload = null;
  }

  // Write the idempotency log row. Fail open: if this insert returns no row
  // (conflict on shopify_webhook_id), deliveryId is null and the status update
  // is skipped — the delivery has already been recorded by the first consumer.
  const { data: deliveryRow } = await serviceClient
    .from("webhook_deliveries")
    .insert({
      merchant_id: merchantId,
      topic,
      shopify_webhook_id: webhookId,
      payload: (payload ?? {}) as Json,
      status: "pending",
    })
    .select("id")
    .single();

  const deliveryId = deliveryRow?.id ?? null;

  // Dispatch to the topic handler if one is registered.
  const handler = getHandler(topic);
  let finalStatus = "processed";
  let errorMessage: string | null = null;

  if (handler && merchantId) {
    try {
      await handler({ merchantId, shopDomain, topic, payload, serviceClient });
    } catch (err) {
      // Never let a handler error cause a non-200 response — Shopify retries on
      // non-200 and the error will be recorded in the idempotency log.
      errorMessage = (err as Error).message;
      console.warn(`webhook_handler_error topic=${topic} err=${errorMessage}`);
      finalStatus = "failed";
    }
  }

  // Update delivery record with final status.
  if (deliveryId) {
    await serviceClient
      .from("webhook_deliveries")
      .update({
        status: finalStatus,
        processed_at: new Date().toISOString(),
        ...(errorMessage !== null ? { error_message: errorMessage } : {}),
      })
      .eq("id", deliveryId);
  }

  return new NextResponse(null, { status: 200 });
}
