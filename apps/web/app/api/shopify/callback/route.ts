import { NextResponse, after, type NextRequest } from "next/server";
import {
  STATE_TOKEN_COOKIE,
  exchangeCodeForToken,
  verifyOAuthCallback,
  mintSessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@lapsed/shopify";
import {
  createServiceClient,
  decodeEncryptionKey,
  encryptToken,
} from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fires the voice-extraction orchestrator as a background POST using
 * Next.js `after()` so the Vercel runtime keeps the function alive until
 * the fetch resolves, even though the OAuth redirect response is already
 * sent. Without `after`, an unawaited fetch is cancelled the moment the
 * handler returns.
 */
function triggerVoiceExtraction(opts: {
  appUrl: string;
  cronSecret: string;
  merchantId: string;
}): Promise<void> {
  const url = `${opts.appUrl}/api/voice/extract`;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.cronSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      merchantId: opts.merchantId,
      source: "install_orchestrator",
    }),
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      console.warn(`voice_extraction_trigger_failed err=${(err as Error).message}`);
    });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();
  const stateCookie = request.cookies.get(STATE_TOKEN_COOKIE)?.value;

  const verification = verifyOAuthCallback({
    query: request.nextUrl.searchParams,
    stateCookie,
    secret: env.shopifyApiSecret,
  });

  if (!verification.ok) {
    // Log only the failure category. Never log the shop, hmac, state or token values.
    console.warn(`oauth_callback_rejected reason=${verification.reason}`);
    return NextResponse.json({ error: verification.reason }, { status: 400 });
  }

  const shop = request.nextUrl.searchParams.get("shop")!;
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ error: "missing_code" }, { status: 400 });
  }

  let tokenResp;
  try {
    tokenResp = await exchangeCodeForToken({
      shop,
      apiKey: env.shopifyApiKey,
      apiSecret: env.shopifyApiSecret,
      code,
    });
  } catch (e) {
    console.warn(`oauth_token_exchange_failed reason=${(e as Error).message}`);
    return NextResponse.json({ error: "token_exchange_failed" }, { status: 502 });
  }

  const key = decodeEncryptionKey(env.tokenEncryptionKey);
  const ciphertext = encryptToken(tokenResp.access_token, key);

  const admin = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Postgres bytea on-the-wire format is `\xHEX...`. PostgREST passes
  // string values straight to Postgres which decodes the hex literal.
  const { data: merchantRow, error } = await admin
    .from("merchants")
    .upsert(
      {
        shopify_shop_domain: shop,
        shopify_access_token: `\\x${ciphertext.toString("hex")}` as unknown as string,
        shopify_scope: tokenResp.scope,
        uninstalled_at: null,
      },
      { onConflict: "shopify_shop_domain" },
    )
    .select("id")
    .single();
  if (error || !merchantRow) {
    console.warn(`merchant_upsert_failed code=${error?.code ?? "unknown"}`);
    return NextResponse.json({ error: "persistence_failed" }, { status: 500 });
  }

  // Schedule background extraction via `after` (Next.js 15.1 stable API).
  // `after` defers the callback until after the redirect response is fully
  // flushed, extending the Vercel function lifetime so the fetch is not
  // cancelled mid-flight. The onboarding UI polls voice_events for progress.
  after(triggerVoiceExtraction({
    appUrl: env.shopifyAppUrl,
    cronSecret: env.cronSecret,
    merchantId: merchantRow.id,
  }));

  const sessionToken = await mintSessionCookie({
    shopDomain: shop,
    apiKey: env.shopifyApiKey,
    apiSecret: env.shopifyApiSecret,
  });

  const response = NextResponse.redirect(`${env.shopifyAppUrl}/app`);
  response.cookies.delete(STATE_TOKEN_COOKIE);
  response.cookies.set({
    name: SESSION_COOKIE,
    value: sessionToken,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return response;
}
