import { SignJWT } from "jose";

const SESSION_COOKIE = "lapsed_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h — App Bridge tokens are short-lived but our cookie is the session anchor

/**
 * Mint an internal session token for a verified merchant. Structurally
 * compatible with a Shopify App Bridge JWT (iss/dest/aud claims), so
 * `verifyShopifySessionToken` can validate it the same way.
 *
 * Set as an httpOnly cookie by the OAuth callback. The dashboard
 * server component reads this cookie and calls
 * `verifyShopifySessionToken` against it.
 */
export async function mintSessionCookie(opts: {
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
  now?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const ttl = opts.ttlSeconds ?? SESSION_TTL_SECONDS;
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(`https://${opts.shopDomain}/admin`)
    .setSubject(`shop:${opts.shopDomain}`)
    .setAudience(opts.apiKey)
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(now + ttl)
    .setJti(`sess_${now}`)
    .sign(new TextEncoder().encode(opts.apiSecret))
    .then((jwt) => jwtWithDest(jwt, opts.shopDomain, opts.apiSecret, opts.apiKey, now, ttl));
}

// jose's SignJWT doesn't have a setDest convenience, so re-mint with
// the same secret if we need to inject the dest claim. Cheap pure
// build — no external IO.
async function jwtWithDest(
  _placeholder: string,
  shopDomain: string,
  apiSecret: string,
  apiKey: string,
  now: number,
  ttl: number,
): Promise<string> {
  return await new SignJWT({ dest: `https://${shopDomain}` })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(`https://${shopDomain}/admin`)
    .setSubject(`shop:${shopDomain}`)
    .setAudience(apiKey)
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(now + ttl)
    .setJti(`sess_${now}`)
    .sign(new TextEncoder().encode(apiSecret));
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS };
