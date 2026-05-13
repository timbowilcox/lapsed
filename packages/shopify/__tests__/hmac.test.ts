import { describe, expect, it } from "vitest";
import { computeOAuthHmac, verifyOAuthHmac } from "../src/hmac";

const SECRET = "test-shopify-api-secret";

// A typical Shopify OAuth callback's signed params (hmac itself filled in below).
function buildParams(overrides: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams({
    code: "abcdef123456",
    host: "bGFwc2VkLXRlc3QubXlzaG9waWZ5LmNvbS9hZG1pbg",
    shop: "lapsed-test.myshopify.com",
    state: "signed-state-token",
    timestamp: "1715680000",
    ...overrides,
  });
  return params;
}

describe("computeOAuthHmac", () => {
  it("produces a deterministic 64-hex digest for known params", () => {
    const params = buildParams();
    const hmac = computeOAuthHmac(params, SECRET);
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(hmac).toBe(computeOAuthHmac(params, SECRET));
  });

  it("ignores the `hmac` parameter when computing", () => {
    const a = buildParams();
    const b = buildParams();
    b.set("hmac", "ffffffff");
    expect(computeOAuthHmac(a, SECRET)).toBe(computeOAuthHmac(b, SECRET));
  });

  it("ignores the `signature` parameter when computing", () => {
    const a = buildParams();
    const b = buildParams();
    b.set("signature", "decade");
    expect(computeOAuthHmac(a, SECRET)).toBe(computeOAuthHmac(b, SECRET));
  });

  it("changes when any signed parameter changes by one byte", () => {
    const a = buildParams();
    const b = buildParams({ code: "abcdef123457" });
    expect(computeOAuthHmac(a, SECRET)).not.toBe(computeOAuthHmac(b, SECRET));
  });

  it("accepts a plain object input", () => {
    const obj = { shop: "x.myshopify.com", code: "a" };
    const usp = new URLSearchParams(obj);
    expect(computeOAuthHmac(obj, SECRET)).toBe(computeOAuthHmac(usp, SECRET));
  });
});

describe("verifyOAuthHmac", () => {
  function sign(p: URLSearchParams): URLSearchParams {
    const signed = new URLSearchParams(p);
    signed.set("hmac", computeOAuthHmac(p, SECRET));
    return signed;
  }

  it("accepts an unmodified, freshly signed callback", () => {
    const signed = sign(buildParams());
    expect(verifyOAuthHmac(signed, SECRET)).toBe(true);
  });

  it("rejects when the hmac is missing", () => {
    expect(verifyOAuthHmac(buildParams(), SECRET)).toBe(false);
  });

  it("rejects when any byte of a signed param is changed", () => {
    const signed = sign(buildParams());
    signed.set("code", "abcdef123457"); // one byte flipped
    expect(verifyOAuthHmac(signed, SECRET)).toBe(false);
  });

  it("rejects when the hmac itself is tampered", () => {
    const signed = sign(buildParams());
    const hmac = signed.get("hmac")!;
    signed.set("hmac", hmac.slice(0, -1) + (hmac.endsWith("0") ? "1" : "0"));
    expect(verifyOAuthHmac(signed, SECRET)).toBe(false);
  });

  it("rejects when the wrong secret is used", () => {
    const signed = sign(buildParams());
    expect(verifyOAuthHmac(signed, "wrong-secret")).toBe(false);
  });

  it("rejects when a new param is appended (not part of the signature)", () => {
    const signed = sign(buildParams());
    signed.set("extra", "injected");
    expect(verifyOAuthHmac(signed, SECRET)).toBe(false);
  });
});
