import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizeUrl,
  isValidShopDomain,
  signStateToken,
  STATE_TOKEN_COOKIE,
  STATE_TTL_MS,
} from "@lapsed/shopify";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();
  const shop = request.nextUrl.searchParams.get("shop");

  if (!isValidShopDomain(shop)) {
    return NextResponse.json({ error: "invalid_shop" }, { status: 400 });
  }

  const state = signStateToken(shop, env.shopifyApiSecret);
  const authorizeUrl = buildAuthorizeUrl({
    shop,
    apiKey: env.shopifyApiKey,
    scopes: env.shopifyScopes,
    redirectUri: `${env.shopifyAppUrl}/api/shopify/callback`,
    state,
  });

  const response = NextResponse.redirect(authorizeUrl);
  // The state cookie must survive two contexts:
  //   1. Set when the install endpoint is hit (potentially inside the
  //      Shopify Admin iframe, where app.lapsed.ai is a third-party origin
  //      to admin.shopify.com — Chrome blocks third-party cookies unless
  //      they carry `SameSite=None; Secure; Partitioned`).
  //   2. Read when Shopify redirects back to /api/shopify/callback as a
  //      top-level navigation. SameSite=None means the cookie is sent on
  //      both first-party and (Partitioned) third-party requests.
  // CHIPS (`Partitioned`) opts into Chrome's partitioned-cookie storage
  // model — without it, modern Chrome silently drops the cookie.
  // The root page now does a client-side window.top.location.href break-out
  // before reaching this endpoint so we usually run top-level anyway, but
  // these attributes are kept as defense-in-depth.
  response.cookies.set({
    name: STATE_TOKEN_COOKIE,
    value: state,
    httpOnly: true,
    secure: true,
    sameSite: "none",
    partitioned: true,
    path: "/",
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  });
  return response;
}
