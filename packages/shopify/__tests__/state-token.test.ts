import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  signStateToken,
  verifyStateToken,
  STATE_TTL_MS,
} from "../src/state-token";

const SECRET = "test-shopify-api-secret";
const SHOP = "lapsed-test.myshopify.com";

describe("verifyStateToken", () => {
  it("verifies a fresh token", () => {
    const token = signStateToken(SHOP, SECRET);
    const r = verifyStateToken(token, SECRET);
    expect(r).toMatchObject({ ok: true, shop: SHOP });
  });

  it("rejects a missing token", () => {
    expect(verifyStateToken(undefined, SECRET)).toEqual({ ok: false, reason: "missing" });
    expect(verifyStateToken("", SECRET)).toEqual({ ok: false, reason: "missing" });
    expect(verifyStateToken(null, SECRET)).toEqual({ ok: false, reason: "missing" });
  });

  it("rejects a malformed token (no separator)", () => {
    expect(verifyStateToken("not-a-token", SECRET)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a malformed token (empty body or sig)", () => {
    expect(verifyStateToken(".abc", SECRET).ok).toBe(false);
    expect(verifyStateToken("abc.", SECRET).ok).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = signStateToken(SHOP, SECRET);
    const tampered = token.slice(0, -2) + (token.endsWith("0") ? "11" : "00");
    expect(verifyStateToken(tampered, SECRET)).toEqual({ ok: false, reason: "tampered" });
  });

  it("rejects a tampered payload", () => {
    const token = signStateToken(SHOP, SECRET);
    // Mutate the body — the signature won't verify.
    const [body, sig] = token.split(".");
    const tamperedBody = Buffer.from(
      JSON.stringify({ nonce: "x", shop: "attacker.myshopify.com", issuedAt: Date.now() }),
    ).toString("base64url");
    expect(verifyStateToken(`${tamperedBody}.${sig}`, SECRET)).toEqual({
      ok: false,
      reason: "tampered",
    });
    void body; // unused
  });

  it("rejects when signed with the wrong secret", () => {
    const token = signStateToken(SHOP, "other-secret");
    expect(verifyStateToken(token, SECRET)).toEqual({ ok: false, reason: "tampered" });
  });

  it("rejects an expired token", () => {
    const past = Date.now() - STATE_TTL_MS - 1_000;
    // Build a token whose embedded issuedAt is older than TTL.
    const body = Buffer.from(
      JSON.stringify({ nonce: "x", shop: SHOP, issuedAt: past }),
    ).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(body).digest("hex");
    const expired = `${body}.${sig}`;
    expect(verifyStateToken(expired, SECRET)).toEqual({ ok: false, reason: "expired" });
  });
});
