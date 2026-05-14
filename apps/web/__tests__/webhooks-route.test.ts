/**
 * Integration tests for POST /api/shopify/webhooks/route.ts.
 *
 * Tests are pure unit tests (no real DB) — the Supabase client is mocked
 * via vi.mock so that DB calls return controlled fixtures. The HMAC is the
 * real implementation from @lapsed/shopify so the signature behaviour is
 * authentic.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const API_SECRET = "test-webhook-secret-32-bytes-longx";
const SHOP_DOMAIN = "test-shop.myshopify.com";
const WEBHOOK_ID = "shopify-whid-001";
const SAMPLE_PAYLOAD = JSON.stringify({ id: 1, email: "test@example.com" });

function computeHmac(body: string | Buffer, secret = API_SECRET): string {
  return createHmac("sha256", secret)
    .update(typeof body === "string" ? Buffer.from(body) : body)
    .digest("base64");
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase mock factories
// ─────────────────────────────────────────────────────────────────────────────

function makeSupabaseMock(
  opts: {
    merchantId?: string | null;
    existingDelivery?: { id: string; status: string } | null;
  } = {},
) {
  const { merchantId = "merchant-uuid-001", existingDelivery = null } = opts;

  const insertedRows: unknown[] = [];

  const mockClient = {
    from: vi.fn((table: string) => {
      if (table === "merchants") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: merchantId ? { id: merchantId } : null,
            error: null,
          }),
        };
      }
      if (table === "webhook_deliveries") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: existingDelivery,
            error: null,
          }),
          insert: vi.fn((row: unknown) => {
            insertedRows.push(row);
            return {
              select: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({
                data: { id: "delivery-uuid-001" },
                error: null,
              }),
            };
          }),
          update: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ error: null }),
          })),
        };
      }
      return {};
    }),
  };

  return { mockClient, insertedRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildRequest(opts: {
  body?: string;
  hmac?: string;
  topic?: string;
  shopDomain?: string;
  webhookId?: string;
}) {
  const {
    body = SAMPLE_PAYLOAD,
    hmac = computeHmac(body),
    topic = "orders/paid",
    shopDomain = SHOP_DOMAIN,
    webhookId = WEBHOOK_ID,
  } = opts;

  return new Request("https://app.lapsed.ai/api/shopify/webhooks", {
    method: "POST",
    headers: {
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-topic": topic,
      "x-shopify-domain": shopDomain,
      "x-shopify-webhook-id": webhookId,
      "content-type": "application/json",
    },
    body,
  });
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/shopify/webhooks — HMAC verification", () => {
  it("returns 401 when HMAC header is missing", async () => {
    const req = buildRequest({ hmac: "" });
    const { POST } = await import("../app/api/shopify/webhooks/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest(req));
    expect(res.status).toBe(401);
  });

  it("returns 401 when HMAC is computed with the wrong secret", async () => {
    const req = buildRequest({ hmac: computeHmac(SAMPLE_PAYLOAD, "wrong-secret") });
    const { POST } = await import("../app/api/shopify/webhooks/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest(req));
    expect(res.status).toBe(401);
  });

  it("returns 401 when the body has been tampered (valid HMAC for original body)", async () => {
    const originalBody = SAMPLE_PAYLOAD;
    const hmac = computeHmac(originalBody);
    // Tamper the body after signing
    const req = buildRequest({
      body: originalBody.replace("test@example.com", "attacker@evil.com"),
      hmac,
    });
    const { POST } = await import("../app/api/shopify/webhooks/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest(req));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/shopify/webhooks — idempotency", () => {
  it("returns 200 without reprocessing when webhookId already exists", async () => {
    const { mockClient } = makeSupabaseMock({
      existingDelivery: { id: "existing-delivery", status: "processed" },
    });

    vi.doMock("@lapsed/db", async (importOriginal) => {
      const original = await importOriginal<typeof import("@lapsed/db")>();
      return {
        ...original,
        createServiceClient: vi.fn(() => mockClient),
      };
    });

    const req = buildRequest({ webhookId: WEBHOOK_ID });
    const { POST } = await import("../app/api/shopify/webhooks/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest(req));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/shopify/webhooks — unknown topic delivery", () => {
  it("returns 200 for a valid delivery even when no handler is registered", async () => {
    const { mockClient } = makeSupabaseMock({ existingDelivery: null });

    vi.doMock("@lapsed/db", async (importOriginal) => {
      const original = await importOriginal<typeof import("@lapsed/db")>();
      return {
        ...original,
        createServiceClient: vi.fn(() => mockClient),
      };
    });

    const req = buildRequest({ topic: "unknown/topic", webhookId: "whid-new-001" });
    const { POST } = await import("../app/api/shopify/webhooks/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest(req));
    expect(res.status).toBe(200);
  });
});
