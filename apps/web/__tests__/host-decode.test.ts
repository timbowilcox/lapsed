import { describe, it, expect } from "vitest";
import { shopFromHost, shopFromParams } from "../app/app/auth/install/host-decode";

// Helpers to produce base64-encoded host values the way Shopify does.
function encode(s: string) {
  return btoa(s);
}

describe("shopFromHost", () => {
  it("standard host returns the shop domain", () => {
    const host = encode("admin.shopify.com/store/myshop");
    expect(shopFromHost(host)).toBe("myshop.myshopify.com");
  });

  it("host with trailing slash returns the shop domain", () => {
    const host = encode("admin.shopify.com/store/myshop/");
    expect(shopFromHost(host)).toBe("myshop.myshopify.com");
  });

  it("host with no shop segment returns null", () => {
    const host = encode("admin.shopify.com");
    expect(shopFromHost(host)).toBeNull();
  });

  it("host with empty shop segment returns null", () => {
    const host = encode("admin.shopify.com/store/");
    expect(shopFromHost(host)).toBeNull();
  });

  it("missing host (empty string) returns null", () => {
    expect(shopFromHost("")).toBeNull();
  });

  it("invalid base64 returns null", () => {
    expect(shopFromHost("!!!not-base64!!!")).toBeNull();
  });
});

describe("shopFromParams", () => {
  function params(obj: Record<string, string | null>) {
    return { get: (key: string) => obj[key] ?? null };
  }

  it("returns ?shop= directly when present", () => {
    expect(shopFromParams(params({ shop: "directshop.myshopify.com" }))).toBe(
      "directshop.myshopify.com"
    );
  });

  it("prefers ?shop= over ?host= when both present", () => {
    const host = encode("admin.shopify.com/store/hostshop");
    expect(
      shopFromParams(params({ shop: "directshop.myshopify.com", host }))
    ).toBe("directshop.myshopify.com");
  });

  it("falls back to ?host= when ?shop= is absent", () => {
    const host = encode("admin.shopify.com/store/hostshop");
    expect(shopFromParams(params({ host }))).toBe("hostshop.myshopify.com");
  });

  it("returns null when neither param is present", () => {
    expect(shopFromParams(params({}))).toBeNull();
  });

  it("returns null when ?host= decodes to an unrecognised path", () => {
    const host = encode("admin.shopify.com");
    expect(shopFromParams(params({ host }))).toBeNull();
  });
});
