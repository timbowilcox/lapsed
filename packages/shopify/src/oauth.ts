import { verifyOAuthHmac } from "./hmac";
import { verifyStateToken, type VerifyStateResult } from "./state-token";

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/;

/**
 * Validate that a shop string is a legal Shopify domain. Prevents
 * `?shop=evil.com` from coercing the install endpoint into talking to
 * a non-Shopify host.
 */
export function isValidShopDomain(shop: string | null | undefined): shop is string {
  return typeof shop === "string" && SHOP_DOMAIN_RE.test(shop);
}

interface BuildAuthorizeUrlOptions {
  shop: string;
  apiKey: string;
  scopes: string;
  redirectUri: string;
  state: string;
}

/**
 * Construct the Shopify authorize URL the merchant's browser is sent
 * to. The `scope` and `redirect_uri` must match what Shopify is
 * expecting (declared in shopify.app.toml).
 */
export function buildAuthorizeUrl(opts: BuildAuthorizeUrlOptions): string {
  const params = new URLSearchParams({
    client_id: opts.apiKey,
    scope: opts.scopes,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    "grant_options[]": "",
  });
  return `https://${opts.shop}/admin/oauth/authorize?${params.toString()}`;
}

export interface CallbackVerificationResult {
  ok: boolean;
  reason?:
    | "missing_shop"
    | "invalid_shop"
    | "hmac_failed"
    | "state_missing"
    | "state_malformed"
    | "state_tampered"
    | "state_expired"
    | "state_mismatch";
}

interface VerifyCallbackOptions {
  query: URLSearchParams;
  stateCookie: string | undefined | null;
  secret: string;
  now?: number;
}

/**
 * Run the full callback validation chain: shop syntax, HMAC, state
 * signature, state expiry, state value matches query state. Returns
 * a discriminated result so callers can log the failure category
 * without leaking the values.
 */
export function verifyOAuthCallback(
  opts: VerifyCallbackOptions,
): CallbackVerificationResult {
  const shop = opts.query.get("shop");
  if (!shop) return { ok: false, reason: "missing_shop" };
  if (!isValidShopDomain(shop)) return { ok: false, reason: "invalid_shop" };

  if (!verifyOAuthHmac(opts.query, opts.secret)) {
    return { ok: false, reason: "hmac_failed" };
  }

  const stateResult: VerifyStateResult = verifyStateToken(
    opts.stateCookie,
    opts.secret,
    opts.now,
  );
  if (!stateResult.ok) {
    return { ok: false, reason: `state_${stateResult.reason}` as CallbackVerificationResult["reason"] };
  }

  const queryState = opts.query.get("state");
  if (!queryState || queryState !== opts.stateCookie) {
    return { ok: false, reason: "state_mismatch" };
  }

  if (stateResult.shop !== shop) {
    return { ok: false, reason: "state_mismatch" };
  }

  return { ok: true };
}

interface ExchangeCodeOptions {
  shop: string;
  apiKey: string;
  apiSecret: string;
  code: string;
  fetchFn?: typeof fetch;
}

export interface ShopifyAccessTokenResponse {
  access_token: string;
  scope: string;
}

/**
 * Exchange an OAuth authorization code for an access token. Done
 * server-side on the OAuth callback path. The returned access_token
 * must be encrypted before persisting.
 */
export async function exchangeCodeForToken(
  opts: ExchangeCodeOptions,
): Promise<ShopifyAccessTokenResponse> {
  const fetcher = opts.fetchFn ?? fetch;
  const res = await fetcher(`https://${opts.shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: opts.apiKey,
      client_secret: opts.apiSecret,
      code: opts.code,
    }),
  });
  if (!res.ok) {
    throw new Error(`Shopify token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as ShopifyAccessTokenResponse;
  if (!body.access_token || !body.scope) {
    throw new Error("Shopify token exchange response missing required fields");
  }
  return body;
}
