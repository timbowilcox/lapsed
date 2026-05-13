import { describe, expect, it } from "vitest";
import {
  isValidShopDomain,
  buildAuthorizeUrl,
  verifyOAuthCallback,
  exchangeCodeForToken,
} from "../src/oauth";
import { computeOAuthHmac } from "../src/hmac";
import { signStateToken } from "../src/state-token";

const SECRET = "test-shopify-api-secret";
const SHOP = "lapsed-test.myshopify.com";

describe("isValidShopDomain", () => {
  it("accepts well-formed myshopify domains", () => {
    expect(isValidShopDomain("a.myshopify.com")).toBe(true);
    expect(isValidShopDomain("bondi-goods.myshopify.com")).toBe(true);
    expect(isValidShopDomain("lapsed-test.myshopify.com")).toBe(true);
  });

  it("rejects non-myshopify domains", () => {
    expect(isValidShopDomain("evil.com")).toBe(false);
    expect(isValidShopDomain("foo.myshopify.com.evil.com")).toBe(false);
    expect(isValidShopDomain("foo.example.com")).toBe(false);
  });

  it("rejects malformed strings", () => {
    expect(isValidShopDomain(null)).toBe(false);
    expect(isValidShopDomain(undefined)).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
    expect(isValidShopDomain("-leading.myshopify.com")).toBe(false);
    expect(isValidShopDomain("UPPER.myshopify.com")).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds a well-formed Shopify authorize URL", () => {
    const url = buildAuthorizeUrl({
      shop: SHOP,
      apiKey: "abc123",
      scopes: "read_orders,read_products",
      redirectUri: "https://app.lapsed.ai/api/shopify/callback",
      state: "signed-state",
    });
    const parsed = new URL(url);
    expect(parsed.host).toBe(SHOP);
    expect(parsed.pathname).toBe("/admin/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("abc123");
    expect(parsed.searchParams.get("scope")).toBe("read_orders,read_products");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://app.lapsed.ai/api/shopify/callback",
    );
    expect(parsed.searchParams.get("state")).toBe("signed-state");
  });
});

function signedCallback(opts: {
  shop?: string;
  code?: string;
  state?: string;
  timestamp?: string;
}): URLSearchParams {
  const params = new URLSearchParams({
    shop: opts.shop ?? SHOP,
    code: opts.code ?? "abc",
    state: opts.state ?? "state-cookie",
    timestamp: opts.timestamp ?? "1715680000",
  });
  params.set("hmac", computeOAuthHmac(params, SECRET));
  return params;
}

describe("verifyOAuthCallback", () => {
  it("accepts a freshly-signed callback with matching state", () => {
    const stateCookie = signStateToken(SHOP, SECRET);
    const params = signedCallback({ state: stateCookie });
    const result = verifyOAuthCallback({
      query: params,
      stateCookie,
      secret: SECRET,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when `shop` parameter is missing", () => {
    const params = signedCallback({});
    params.delete("shop");
    expect(verifyOAuthCallback({ query: params, stateCookie: "x", secret: SECRET })).toEqual({
      ok: false,
      reason: "missing_shop",
    });
  });

  it("rejects a non-Shopify shop", () => {
    const params = signedCallback({ shop: "evil.com" });
    expect(verifyOAuthCallback({ query: params, stateCookie: "x", secret: SECRET })).toEqual({
      ok: false,
      reason: "invalid_shop",
    });
  });

  it("rejects when the HMAC is tampered (one byte changed)", () => {
    const stateCookie = signStateToken(SHOP, SECRET);
    const params = signedCallback({ state: stateCookie });
    params.set("code", "tampered-after-signing");
    expect(verifyOAuthCallback({ query: params, stateCookie, secret: SECRET })).toEqual({
      ok: false,
      reason: "hmac_failed",
    });
  });

  it("rejects when state cookie is missing", () => {
    const params = signedCallback({});
    expect(verifyOAuthCallback({ query: params, stateCookie: undefined, secret: SECRET })).toEqual({
      ok: false,
      reason: "state_missing",
    });
  });

  it("rejects when state cookie has expired", () => {
    const stateCookie = signStateToken(SHOP, SECRET);
    const params = signedCallback({ state: stateCookie });
    expect(
      verifyOAuthCallback({
        query: params,
        stateCookie,
        secret: SECRET,
        now: Date.now() + 11 * 60_000, // 11 min in the future
      }),
    ).toEqual({ ok: false, reason: "state_expired" });
  });

  it("rejects when the state query and state cookie don't match", () => {
    const stateA = signStateToken(SHOP, SECRET);
    const stateB = signStateToken(SHOP, SECRET); // different nonce → different token
    const params = signedCallback({ state: stateA });
    expect(verifyOAuthCallback({ query: params, stateCookie: stateB, secret: SECRET })).toEqual({
      ok: false,
      reason: "state_mismatch",
    });
  });

  it("rejects when state cookie shop doesn't match query shop", () => {
    const stateForOther = signStateToken("other-shop.myshopify.com", SECRET);
    const params = signedCallback({ shop: SHOP, state: stateForOther });
    const result = verifyOAuthCallback({
      query: params,
      stateCookie: stateForOther,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: "state_mismatch" });
  });
});

describe("exchangeCodeForToken", () => {
  it("returns access_token + scope on success", async () => {
    const fakeFetch = ((_url: string, _init: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "shpat_xyz", scope: "read_orders" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as unknown as typeof fetch;
    const result = await exchangeCodeForToken({
      shop: SHOP,
      apiKey: "abc",
      apiSecret: SECRET,
      code: "auth_code",
      fetchFn: fakeFetch,
    });
    expect(result).toEqual({ access_token: "shpat_xyz", scope: "read_orders" });
  });

  it("throws on non-2xx", async () => {
    const fakeFetch = ((_url: string) =>
      Promise.resolve(new Response("nope", { status: 400 }))) as unknown as typeof fetch;
    await expect(
      exchangeCodeForToken({
        shop: SHOP,
        apiKey: "abc",
        apiSecret: SECRET,
        code: "bad",
        fetchFn: fakeFetch,
      }),
    ).rejects.toThrow(/Shopify token exchange failed: 400/);
  });

  it("throws when access_token is missing from response", async () => {
    const fakeFetch = ((_url: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ scope: "x" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    await expect(
      exchangeCodeForToken({
        shop: SHOP,
        apiKey: "abc",
        apiSecret: SECRET,
        code: "bad",
        fetchFn: fakeFetch,
      }),
    ).rejects.toThrow(/missing required fields/);
  });
});
