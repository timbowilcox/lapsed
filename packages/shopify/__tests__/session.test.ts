import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { verifyShopifySessionToken } from "../src/session";

const API_KEY = "d7c8736233049f6489c57c82ceb0f569";
const API_SECRET = "test-shopify-api-secret-at-least-32-bytes-long";
const SHOP = "lapsed-test.myshopify.com";

async function signSessionToken(
  overrides: Partial<{
    iss: string;
    dest: string;
    aud: string;
    secret: string;
    exp: number;
    nbf: number;
  }> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: overrides.iss ?? `https://${SHOP}/admin`,
    dest: overrides.dest ?? `https://${SHOP}`,
    aud: overrides.aud ?? API_KEY,
    sub: "12345",
    nbf: overrides.nbf ?? now - 5,
    exp: overrides.exp ?? now + 60,
    iat: now,
    jti: "test-jti",
  };
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(new TextEncoder().encode(overrides.secret ?? API_SECRET));
}

describe("verifyShopifySessionToken", () => {
  it("accepts a valid session token", async () => {
    const token = await signSessionToken();
    const result = await verifyShopifySessionToken({
      token,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    expect(result).toMatchObject({ ok: true, shopDomain: SHOP });
  });

  it("rejects a missing token", async () => {
    const result = await verifyShopifySessionToken({
      token: undefined,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signSessionToken({ exp: now - 60, nbf: now - 120 });
    const result = await verifyShopifySessionToken({
      token,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token with an invalid signature", async () => {
    const token = await signSessionToken({ secret: "wrong-secret-different-from-real-one" });
    const result = await verifyShopifySessionToken({
      token,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a token whose iss host is not a myshopify domain", async () => {
    const token = await signSessionToken({
      iss: "https://evil.com/admin",
      dest: "https://evil.com",
    });
    const result = await verifyShopifySessionToken({
      token,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "issuer" });
  });

  it("rejects a token where dest host differs from iss host", async () => {
    const token = await signSessionToken({
      iss: `https://${SHOP}/admin`,
      dest: "https://other.myshopify.com",
    });
    const result = await verifyShopifySessionToken({
      token,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "issuer" });
  });

  it("rejects a token whose audience doesn't match the configured API key", async () => {
    const token = await signSessionToken({ aud: "different-api-key" });
    const result = await verifyShopifySessionToken({
      token,
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "audience" });
  });
});
