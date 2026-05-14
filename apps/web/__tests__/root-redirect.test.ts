import { describe, it, expect, vi } from "vitest";
import {
  resolveRootRedirect,
  toURLSearchParams,
} from "../app/lib/root-redirect";

// Helpers
const validHmac = () => true;
const invalidHmac = () => false;
const merchantInstalled = vi.fn(async () => ({ installed: true }));
const merchantMissing = vi.fn(async () => ({ installed: false }));

function paramsWith(obj: Record<string, string>) {
  return new URLSearchParams(obj);
}

describe("resolveRootRedirect", () => {
  it("shop present + merchant installed → /app with full query string preserved", async () => {
    const params = paramsWith({
      shop: "lapsed-test.myshopify.com",
      host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbGFwc2VkLXRlc3Q",
      embedded: "1",
      hmac: "validsig",
      timestamp: "1715635200",
    });
    const result = await resolveRootRedirect({
      searchParams: params,
      verifyHmac: validHmac,
      lookupMerchant: merchantInstalled,
    });
    expect(result.target.startsWith("/app?")).toBe(true);
    const qp = new URLSearchParams(result.target.split("?")[1]);
    expect(qp.get("shop")).toBe("lapsed-test.myshopify.com");
    expect(qp.get("host")).toBe("YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbGFwc2VkLXRlc3Q");
    expect(qp.get("embedded")).toBe("1");
    expect(qp.get("hmac")).toBe("validsig");
    expect(qp.get("timestamp")).toBe("1715635200");
  });

  it("shop present + merchant not installed → /api/shopify/install with shop+host", async () => {
    const params = paramsWith({
      shop: "lapsed-test.myshopify.com",
      host: "YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbGFwc2VkLXRlc3Q",
      embedded: "1",
      hmac: "validsig",
    });
    const result = await resolveRootRedirect({
      searchParams: params,
      verifyHmac: validHmac,
      lookupMerchant: merchantMissing,
    });
    expect(result.target.startsWith("/api/shopify/install?")).toBe(true);
    const qp = new URLSearchParams(result.target.split("?")[1]);
    expect(qp.get("shop")).toBe("lapsed-test.myshopify.com");
    expect(qp.get("host")).toBe("YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbGFwc2VkLXRlc3Q");
    // No leakage of hmac/embedded into the install URL
    expect(qp.get("hmac")).toBeNull();
    expect(qp.get("embedded")).toBeNull();
  });

  it("shop present + merchant uninstalled treated as not installed → /api/shopify/install", async () => {
    const params = paramsWith({ shop: "lapsed-test.myshopify.com", hmac: "x" });
    const result = await resolveRootRedirect({
      searchParams: params,
      verifyHmac: validHmac,
      lookupMerchant: async () => ({ installed: false }),
    });
    expect(result.target.startsWith("/api/shopify/install?")).toBe(true);
  });

  it("no shop param → /app (existing direct-visit behavior)", async () => {
    const lookup = vi.fn(async () => ({ installed: true }));
    const result = await resolveRootRedirect({
      searchParams: new URLSearchParams(),
      verifyHmac: validHmac,
      lookupMerchant: lookup,
    });
    expect(result.target).toBe("/app");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("shop present but HMAC invalid → /app (do not act on untrusted ?shop=)", async () => {
    const lookup = vi.fn(async () => ({ installed: true }));
    const params = paramsWith({
      shop: "attacker.myshopify.com",
      hmac: "tamperedsig",
    });
    const result = await resolveRootRedirect({
      searchParams: params,
      verifyHmac: invalidHmac,
      lookupMerchant: lookup,
    });
    expect(result.target).toBe("/app");
    // Critical: the merchant lookup is NEVER called for untrusted shops,
    // so attacker.myshopify.com can't be probed via a redirect oracle.
    expect(lookup).not.toHaveBeenCalled();
  });

  it("shop present without host param → install URL omits host (still includes shop)", async () => {
    const params = paramsWith({ shop: "lapsed-test.myshopify.com", hmac: "x" });
    const result = await resolveRootRedirect({
      searchParams: params,
      verifyHmac: validHmac,
      lookupMerchant: merchantMissing,
    });
    const qp = new URLSearchParams(result.target.split("?")[1]);
    expect(qp.get("shop")).toBe("lapsed-test.myshopify.com");
    expect(qp.has("host")).toBe(false);
  });
});

describe("toURLSearchParams", () => {
  it("converts string values", () => {
    const sp = toURLSearchParams({ shop: "foo.myshopify.com", host: "abc" });
    expect(sp.get("shop")).toBe("foo.myshopify.com");
    expect(sp.get("host")).toBe("abc");
  });

  it("uses the first array value when a key has multiple values", () => {
    const sp = toURLSearchParams({ shop: ["first", "second"] });
    expect(sp.get("shop")).toBe("first");
  });

  it("skips undefined values", () => {
    const sp = toURLSearchParams({ shop: "foo", host: undefined });
    expect(sp.get("shop")).toBe("foo");
    expect(sp.has("host")).toBe(false);
  });

  it("returns empty params for an empty object", () => {
    const sp = toURLSearchParams({});
    expect(sp.toString()).toBe("");
  });
});
