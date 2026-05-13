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
  response.cookies.set({
    name: STATE_TOKEN_COOKIE,
    value: state,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(STATE_TTL_MS / 1000),
  });
  return response;
}
