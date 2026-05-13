import { jwtVerify } from "jose";
import { isValidShopDomain } from "./oauth";

export interface ShopifySessionClaims {
  iss: string;
  dest: string;
  aud: string;
  sub: string;
  exp: number;
  nbf: number;
  iat: number;
  jti: string;
  sid?: string;
}

export type VerifySessionResult =
  | { ok: true; claims: ShopifySessionClaims; shopDomain: string }
  | { ok: false; reason: "missing" | "malformed" | "signature" | "expired" | "audience" | "issuer" };

interface VerifyOptions {
  token: string | undefined | null;
  apiKey: string;
  apiSecret: string;
  now?: number;
}

/**
 * Verify a Shopify App Bridge session token. The token is a JWT signed
 * with the app's API secret (HS256). On success returns the claims and
 * the extracted shop domain (`xxx.myshopify.com`).
 *
 * Failure modes are returned as discriminated tags so callers can log
 * the category without leaking the token, shop, or claims.
 */
export async function verifyShopifySessionToken(
  opts: VerifyOptions,
): Promise<VerifySessionResult> {
  if (!opts.token) return { ok: false, reason: "missing" };

  const secret = new TextEncoder().encode(opts.apiSecret);
  const now = Math.floor((opts.now ?? Date.now()) / 1000);

  let payload: unknown;
  try {
    const { payload: jwtPayload } = await jwtVerify(opts.token, secret, {
      algorithms: ["HS256"],
      currentDate: new Date(now * 1000),
      audience: opts.apiKey,
    });
    payload = jwtPayload;
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    if (e.code === "ERR_JWT_CLAIM_VALIDATION_FAILED") return { ok: false, reason: "audience" };
    if (e.code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
      return { ok: false, reason: "signature" };
    }
    return { ok: false, reason: "malformed" };
  }

  const claims = payload as ShopifySessionClaims;
  if (
    typeof claims.iss !== "string" ||
    typeof claims.dest !== "string" ||
    typeof claims.aud !== "string" ||
    typeof claims.exp !== "number" ||
    typeof claims.nbf !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  let issHost: string;
  try {
    issHost = new URL(claims.iss).host;
  } catch {
    return { ok: false, reason: "issuer" };
  }
  if (!isValidShopDomain(issHost)) {
    return { ok: false, reason: "issuer" };
  }

  let destHost: string;
  try {
    destHost = new URL(claims.dest).host;
  } catch {
    return { ok: false, reason: "issuer" };
  }
  if (destHost !== issHost) {
    return { ok: false, reason: "issuer" };
  }

  return { ok: true, claims, shopDomain: issHost };
}

interface GetMerchantFromSessionOptions {
  token: string | undefined | null;
  apiKey: string;
  apiSecret: string;
  now?: number;
}

/**
 * Thin wrapper that returns just the verified shop domain or null.
 * Server components / route handlers compose this with a Supabase
 * lookup to fetch the merchant row.
 */
export async function getShopDomainFromSession(
  opts: GetMerchantFromSessionOptions,
): Promise<string | null> {
  const result = await verifyShopifySessionToken(opts);
  return result.ok ? result.shopDomain : null;
}
