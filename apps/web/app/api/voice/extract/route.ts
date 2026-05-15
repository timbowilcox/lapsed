// Internal endpoint that runs the voice-extraction orchestrator for a
// given merchant. Triggered fire-and-forget by the OAuth callback right
// after a successful install + token persist. Also invokable from the
// Settings "Re-extract" button (chunk 11) with the same auth.
//
// Auth: CRON_SECRET header (same pattern as the nightly scoring job).
// The route writes nothing to the response that surfaces to the caller —
// success/failure is observable via the voice_events log on the merchant.

import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  createServiceClient,
  decodeEncryptionKey,
  decryptToken,
} from "@lapsed/db";
import { runVoiceExtraction } from "@lapsed/core";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vercel function timeout — extraction includes a Sonnet call so allow up
// to 60s end-to-end. Per-step timeouts inside the orchestrator bound this.
export const maxDuration = 60;

interface ExtractBody {
  merchantId: string;
  source?: "install_orchestrator" | "settings_reextract";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();

  // Auth: shared secret. Identical pattern to the scoring cron route.
  const authHeader = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.cronSecret}`;
  if (authHeader !== expected) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: ExtractBody;
  try {
    body = (await request.json()) as ExtractBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!body.merchantId || typeof body.merchantId !== "string") {
    return NextResponse.json({ error: "missing_merchant_id" }, { status: 400 });
  }

  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Look up the shop domain + decrypt the access token. The token never
  // appears in any log or response body.
  const { data: merchant, error: merchErr } = await serviceClient
    .from("merchants")
    .select("id,shopify_shop_domain,shopify_access_token")
    .eq("id", body.merchantId)
    .single();
  if (merchErr || !merchant) {
    return NextResponse.json({ error: "merchant_not_found" }, { status: 404 });
  }

  const encKey = decodeEncryptionKey(env.tokenEncryptionKey);
  const ciphertextHex = (merchant.shopify_access_token as string).replace(/^\\x/, "");
  const accessToken = decryptToken(Buffer.from(ciphertextHex, "hex"), encKey);

  const anthropicClient = new Anthropic({
    apiKey: env.anthropicApiKey,
    // SDK retries disabled — synthesizer runs its own retry loop with
    // token-usage accumulation across attempts (decision 9).
    maxRetries: 0,
    timeout: 30_000,
  });

  const result = await runVoiceExtraction({
    serviceClient,
    anthropicClient,
    merchantId: merchant.id,
    shopDomain: merchant.shopify_shop_domain,
    accessToken,
    model: env.sonnetModel,
    dailyCapDefault: env.voiceExtractionDailyCapDefault,
    source: body.source ?? "install_orchestrator",
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 202 });
}
