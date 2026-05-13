import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface StateTokenPayload {
  nonce: string;
  shop: string;
  issuedAt: number;
}

/**
 * Mint a signed state token for the OAuth round trip. Stored in a
 * httpOnly cookie; compared to the `state` query parameter on the
 * OAuth callback.
 *
 * Format: base64url(JSON payload).hex(HMAC-SHA256(secret, payload))
 */
export function signStateToken(shop: string, secret: string): string {
  const payload: StateTokenPayload = {
    nonce: randomBytes(16).toString("hex"),
    shop,
    issuedAt: Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return `${body}.${sig}`;
}

export type VerifyStateResult =
  | { ok: true; shop: string }
  | { ok: false; reason: "missing" | "malformed" | "tampered" | "expired" };

/**
 * Verify a state token returned by Shopify. Returns the decoded shop on
 * success. The failure mode is returned as a discriminated tag so
 * callers can log it without leaking values.
 */
export function verifyStateToken(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): VerifyStateResult {
  if (!token) return { ok: false, reason: "missing" };

  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const body = token.slice(0, dotIdx);
  const providedSig = token.slice(dotIdx + 1);

  const expectedSig = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(providedSig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "tampered" };
  }

  let payload: StateTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StateTokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload.shop || !payload.issuedAt) {
    return { ok: false, reason: "malformed" };
  }
  if (now - payload.issuedAt > STATE_TTL_MS) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, shop: payload.shop };
}

export const STATE_TOKEN_COOKIE = "lapsed_oauth_state";
export { STATE_TTL_MS };
