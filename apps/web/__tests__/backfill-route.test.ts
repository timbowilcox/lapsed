/**
 * Unit tests for POST /api/shopify/backfill.
 *
 * All external dependencies (Supabase client, Shopify token verification,
 * encryption helpers, fetch) are mocked so tests run without network or DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MERCHANT_ID = "merchant-uuid-001";
const SHOP_DOMAIN = "test-shop.myshopify.com";
const FAKE_ACCESS_TOKEN = "shpat_fake";
// Hex-encoded fake ciphertext returned by the mocked Supabase query.
const FAKE_CIPHER_HEX = Buffer.alloc(48, 9).toString("hex");

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

type UpsertCall = { table: string; row: Record<string, unknown> };
type UpdateCall = { table: string; values: Record<string, unknown> };

function makeMockClient(opts: { merchantId?: string | null } = {}) {
  const { merchantId = MERCHANT_ID } = opts;
  const upserts: UpsertCall[] = [];
  const updates: UpdateCall[] = [];

  const client = {
    from: vi.fn((table: string) => {
      if (table === "merchants") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: merchantId
              ? { id: merchantId, shopify_access_token: `\\x${FAKE_CIPHER_HEX}` }
              : null,
            error: null,
          }),
          update: vi.fn((vals: Record<string, unknown>) => {
            updates.push({ table, values: vals });
            return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
          }),
        };
      }
      return {
        upsert: vi.fn((row: Record<string, unknown>) => {
          upserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        }),
        update: vi.fn((vals: Record<string, unknown>) => {
          updates.push({ table, values: vals });
          return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
        }),
      };
    }),
  };

  return { client, upserts, updates };
}

function makeShopifyFetchResponse(
  body: unknown,
  opts: { status?: number; linkHeader?: string; retryAfter?: string } = {},
): Response {
  const { status = 200, linkHeader, retryAfter } = opts;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (linkHeader) headers.set("Link", linkHeader);
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}

function buildRequest(opts: {
  resource?: string;
  cursor?: string;
  sessionCookie?: string;
  invalidJson?: boolean;
}) {
  const { resource = "customers", cursor, sessionCookie = "valid-session-token", invalidJson = false } = opts;
  const body = invalidJson ? "not json" : JSON.stringify(cursor ? { resource, cursor } : { resource });

  return new Request(`https://app.lapsed.ai/api/shopify/backfill`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionCookie ? { Cookie: `lapsed_session=${sessionCookie}` } : {}),
    },
    body,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  process.env.SHOPIFY_API_KEY = "test-api-key";
  process.env.NEXT_PUBLIC_SHOPIFY_API_KEY = "test-api-key";
  process.env.SHOPIFY_API_SECRET = "test-api-secret";
  process.env.SHOPIFY_SCOPES = "read_customers,read_orders";
  process.env.SHOPIFY_APP_URL = "https://app.lapsed.ai";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  process.env.SUPABASE_JWT_SECRET = "jwt-secret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

async function importWithMocks(opts: { merchantId?: string | null; session?: { ok: boolean; shopDomain?: string } } = {}) {
  const { merchantId = MERCHANT_ID, session = { ok: true, shopDomain: SHOP_DOMAIN } } = opts;
  const { client, upserts, updates } = makeMockClient({ merchantId });

  vi.doMock("@lapsed/shopify", async (orig) => {
    const original = await orig<typeof import("@lapsed/shopify")>();
    return {
      ...original,
      verifyShopifySessionToken: vi.fn().mockResolvedValue(session),
    };
  });

  vi.doMock("@lapsed/db", async (orig) => {
    const original = await orig<typeof import("@lapsed/db")>();
    return {
      ...original,
      createServiceClient: vi.fn(() => client),
      decodeEncryptionKey: vi.fn(() => Buffer.alloc(32, 7)),
      decryptToken: vi.fn(() => FAKE_ACCESS_TOKEN),
    };
  });

  const { POST } = await import("../app/api/shopify/backfill/route");
  const { NextRequest } = await import("next/server");
  return { POST, NextRequest, upserts, updates };
}

// ─────────────────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/shopify/backfill — authentication", () => {
  it("returns 401 when session verification fails", async () => {
    const { POST, NextRequest } = await importWithMocks({ session: { ok: false } });
    const req = buildRequest({ resource: "customers" });
    const res = await POST(new NextRequest(req));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("returns 401 and does not call createServiceClient when session is invalid", async () => {
    vi.resetModules();
    const createServiceClientMock = vi.fn();

    vi.doMock("@lapsed/shopify", async (orig) => {
      const original = await orig<typeof import("@lapsed/shopify")>();
      return { ...original, verifyShopifySessionToken: vi.fn().mockResolvedValue({ ok: false }) };
    });
    vi.doMock("@lapsed/db", async (orig) => {
      const original = await orig<typeof import("@lapsed/db")>();
      return { ...original, createServiceClient: createServiceClientMock };
    });

    const { POST } = await import("../app/api/shopify/backfill/route");
    const { NextRequest } = await import("next/server");
    await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(createServiceClientMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Request validation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/shopify/backfill — request validation", () => {
  it("returns 400 for invalid JSON body", async () => {
    const { POST, NextRequest } = await importWithMocks();
    // set up fetch to not be called
    global.fetch = vi.fn();
    const res = await POST(new NextRequest(buildRequest({ invalidJson: true })));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_body" });
  });

  it("returns 400 for unknown resource value", async () => {
    const { POST, NextRequest } = await importWithMocks();
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({ customers: [] }));
    const req = new Request("https://app.lapsed.ai/api/shopify/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resource: "products" }),
    });
    const res = await POST(new NextRequest(req));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_resource" });
  });

  it("returns 404 when merchant is not found", async () => {
    const { POST, NextRequest } = await importWithMocks({ merchantId: null });
    global.fetch = vi.fn();
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shopify API error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/shopify/backfill — Shopify API errors", () => {
  it("returns 429 with Retry-After header when Shopify rate-limits", async () => {
    const { POST, NextRequest } = await importWithMocks();
    global.fetch = vi.fn().mockResolvedValue(
      makeShopifyFetchResponse({}, { status: 429, retryAfter: "4" }),
    );
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("4");
  });

  it("returns 429 with default Retry-After of 2 when header is absent", async () => {
    const { POST, NextRequest } = await importWithMocks();
    const resp = makeShopifyFetchResponse({}, { status: 429 });
    global.fetch = vi.fn().mockResolvedValue(resp);
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("2");
  });

  it("returns 502 on non-429 Shopify error", async () => {
    const { POST, NextRequest } = await importWithMocks();
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({}, { status: 503 }));
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(res.status).toBe(502);
  });

  it("returns 504 when Shopify fetch times out (AbortError)", async () => {
    const { POST, NextRequest } = await importWithMocks();
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    global.fetch = vi.fn().mockRejectedValue(abortErr);
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(res.status).toBe(504);
  });

  it("returns 502 on generic network error", async () => {
    const { POST, NextRequest } = await importWithMocks();
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(res.status).toBe(502);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cursor / pagination
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/shopify/backfill — cursor extraction", () => {
  it("returns nextCursor from Link header rel=next", async () => {
    const { POST, NextRequest } = await importWithMocks();
    const linkHeader = `<https://test-shop.myshopify.com/admin/api/2026-04/customers.json?page_info=abc123&limit=250>; rel="next"`;
    global.fetch = vi.fn().mockResolvedValue(
      makeShopifyFetchResponse({ customers: [] }, { linkHeader }),
    );
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(res.status).toBe(200);
    const json = await res.json() as { nextCursor: string | null };
    expect(json.nextCursor).toBe("abc123");
  });

  it("returns null nextCursor when Link header has only rel=previous", async () => {
    const { POST, NextRequest } = await importWithMocks();
    const linkHeader = `<https://test-shop.myshopify.com/admin/api/2026-04/customers.json?page_info=xyz&limit=250>; rel="previous"`;
    global.fetch = vi.fn().mockResolvedValue(
      makeShopifyFetchResponse({ customers: [] }, { linkHeader }),
    );
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    const json = await res.json() as { nextCursor: string | null };
    expect(json.nextCursor).toBeNull();
  });

  it("returns null nextCursor when no Link header", async () => {
    const { POST, NextRequest } = await importWithMocks();
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({ customers: [] }));
    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    const json = await res.json() as { nextCursor: string | null };
    expect(json.nextCursor).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Customer backfill
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/shopify/backfill — customers resource", () => {
  it("writes customer_events and customers upsert for each customer", async () => {
    const { POST, NextRequest, upserts } = await importWithMocks();
    const customers = [
      { id: 1001, email: "a@example.com", total_spent: "100.00", orders_count: 2, created_at: "2024-01-01T00:00:00Z" },
      { id: 1002, email: "b@example.com", total_spent: "50.50", orders_count: 1, created_at: "2024-02-01T00:00:00Z" },
    ];
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({ customers }));

    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    expect(res.status).toBe(200);
    const json = await res.json() as { count: number };
    expect(json.count).toBe(2);

    const eventUpserts = upserts.filter((u) => u.table === "customer_events");
    expect(eventUpserts).toHaveLength(2);
    expect(eventUpserts[0]?.row.event_type).toBe("customer_backfilled");
    expect(eventUpserts[0]?.row.source).toBe("shopify_backfill");
    expect(eventUpserts[0]?.row.shopify_customer_gid).toBe("gid://shopify/Customer/1001");

    const profileUpserts = upserts.filter((u) => u.table === "customers");
    expect(profileUpserts).toHaveLength(2);
    expect(profileUpserts[0]?.row.total_ltv_cents).toBe(10000);
    expect(profileUpserts[1]?.row.total_ltv_cents).toBe(5050);
  });

  it("skips customers with missing id and does not count them", async () => {
    const { POST, NextRequest, upserts } = await importWithMocks();
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({
      customers: [{ id: 0, email: "x@x.com" }, { id: 500, email: "y@y.com", created_at: "2024-01-01T00:00:00Z" }],
    }));

    const res = await POST(new NextRequest(buildRequest({ resource: "customers" })));
    const json = await res.json() as { count: number };
    expect(json.count).toBe(1);
    const profileUpserts = upserts.filter((u) => u.table === "customers");
    expect(profileUpserts).toHaveLength(1);
    expect(profileUpserts[0]?.row.shopify_customer_gid).toBe("gid://shopify/Customer/500");
  });

  it("updates merchant last_backfill_at after processing", async () => {
    const { POST, NextRequest, updates } = await importWithMocks();
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({ customers: [] }));

    await POST(new NextRequest(buildRequest({ resource: "customers" })));

    const merchantUpdate = updates.find((u) => u.table === "merchants");
    expect(merchantUpdate?.values).toHaveProperty("last_backfill_at");
    expect(typeof merchantUpdate?.values.last_backfill_at).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orders backfill
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/shopify/backfill — orders resource", () => {
  it("writes order_events and orders upsert for each order", async () => {
    const { POST, NextRequest, upserts } = await importWithMocks();
    const orders = [
      { id: 5001, customer: { id: 111 }, total_price: "200.00", financial_status: "paid", created_at: "2024-01-01T00:00:00Z" },
    ];
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({ orders }));

    const res = await POST(new NextRequest(buildRequest({ resource: "orders" })));
    expect(res.status).toBe(200);
    const json = await res.json() as { count: number };
    expect(json.count).toBe(1);

    const orderEvent = upserts.find((u) => u.table === "order_events");
    expect(orderEvent?.row.event_type).toBe("order_backfilled");
    expect(orderEvent?.row.shopify_order_gid).toBe("gid://shopify/Order/5001");
    expect(orderEvent?.row.shopify_customer_gid).toBe("gid://shopify/Customer/111");

    const orderUpsert = upserts.find((u) => u.table === "orders");
    expect(orderUpsert?.row.total_price_cents).toBe(20000);
  });

  it("skips orders with missing customer.id", async () => {
    const { POST, NextRequest, upserts } = await importWithMocks();
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({
      orders: [
        { id: 5002, customer: null, total_price: "10.00" },
        { id: 5003, customer: { id: 222 }, total_price: "30.00", created_at: "2024-01-01T00:00:00Z" },
      ],
    }));

    const res = await POST(new NextRequest(buildRequest({ resource: "orders" })));
    const json = await res.json() as { count: number };
    expect(json.count).toBe(1);
    const orderUpserts = upserts.filter((u) => u.table === "orders");
    expect(orderUpserts).toHaveLength(1);
    expect(orderUpserts[0]?.row.shopify_order_gid).toBe("gid://shopify/Order/5003");
  });

  it("skips orders with missing order id", async () => {
    const { POST, NextRequest, upserts } = await importWithMocks();
    global.fetch = vi.fn().mockResolvedValue(makeShopifyFetchResponse({
      orders: [{ id: 0, customer: { id: 1 } }],
    }));

    const res = await POST(new NextRequest(buildRequest({ resource: "orders" })));
    const json = await res.json() as { count: number };
    expect(json.count).toBe(0);
    expect(upserts.filter((u) => u.table === "order_events")).toHaveLength(0);
  });
});
