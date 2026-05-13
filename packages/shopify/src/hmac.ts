import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Compute the Shopify HMAC for a set of OAuth callback query parameters.
 *
 * Per https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant
 * the signature is HMAC-SHA256(secret, message) where `message` is the
 * URL-encoded query string sorted by key, with the `hmac` and
 * `signature` parameters removed.
 */
export function computeOAuthHmac(
  params: URLSearchParams | Record<string, string>,
  secret: string,
): string {
  const entries =
    params instanceof URLSearchParams
      ? Array.from(params.entries())
      : Object.entries(params);
  const filtered = entries.filter(([k]) => k !== "hmac" && k !== "signature");
  filtered.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = filtered
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Verify the `hmac` query parameter on a Shopify OAuth callback. Uses
 * a constant-time comparison to avoid timing side channels.
 */
export function verifyOAuthHmac(
  params: URLSearchParams | Record<string, string>,
  secret: string,
): boolean {
  const provided =
    params instanceof URLSearchParams ? params.get("hmac") : params.hmac;
  if (!provided) return false;
  const expected = computeOAuthHmac(params, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
