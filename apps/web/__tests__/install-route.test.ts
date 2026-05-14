import { describe, it, expect, beforeEach, vi } from "vitest";

// We import the route handler dynamically AFTER setting env vars + mocks
// so the lazy `serverEnv()` cache picks them up.

const API_SECRET = "test-api-secret-must-be-32-bytes-long-x";

beforeEach(() => {
  vi.resetModules();
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.NEXT_PUBLIC_SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = API_SECRET;
  process.env.SHOPIFY_SCOPES = "read_customers,read_orders";
  process.env.SHOPIFY_APP_URL = "https://app.lapsed.ai";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.SUPABASE_JWT_SECRET = "jwt-secret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

async function callInstall(url: string) {
  const { GET } = await import("../app/api/shopify/install/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(url);
  return GET(req);
}

describe("/api/shopify/install — state cookie attributes", () => {
  it("sets the state cookie with SameSite=None, Secure, Partitioned, HttpOnly", async () => {
    const res = await callInstall(
      "https://app.lapsed.ai/api/shopify/install?shop=lapsed-test.myshopify.com",
    );

    // NextResponse exposes the parsed cookie via .cookies.get(name); the
    // raw Set-Cookie header is what the browser actually sees, so we
    // assert on that for the attributes.
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const sc = setCookie ?? "";

    expect(sc).toMatch(/^lapsed_oauth_state=/);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=None/i);
    expect(sc).toMatch(/Partitioned/i);
    expect(sc).toMatch(/Path=\//i);
    expect(sc).toMatch(/Max-Age=600/i); // 10 minutes
  });

  it("redirects to Shopify's authorize URL with the expected params", async () => {
    const res = await callInstall(
      "https://app.lapsed.ai/api/shopify/install?shop=lapsed-test.myshopify.com",
    );
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.host).toBe("lapsed-test.myshopify.com");
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-api-key");
    expect(url.searchParams.get("scope")).toBe("read_customers,read_orders");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.lapsed.ai/api/shopify/callback",
    );
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("rejects an invalid shop domain", async () => {
    const res = await callInstall(
      "https://app.lapsed.ai/api/shopify/install?shop=not-a-shopify-host.com",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_shop");
  });

  it("rejects a missing shop param", async () => {
    const res = await callInstall("https://app.lapsed.ai/api/shopify/install");
    expect(res.status).toBe(400);
  });
});
