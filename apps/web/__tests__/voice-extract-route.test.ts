// Unit tests for POST /api/voice/extract.
//
// Covers: auth gate (timingSafeEqual), body validation, merchant lookup 404,
// happy path 200, orchestrator-failure 202. The orchestrator itself
// (runVoiceExtraction) is stubbed — its own unit tests live in packages/core.
//
// Env vars for serverEnv() come from vitest.config.ts (CRON_SECRET, etc.).
// External dependencies (Supabase, Anthropic SDK, @lapsed/core) are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { RunVoiceExtractionResult } from "@lapsed/core";
import type { LapsedSupabaseClient } from "@lapsed/db";

// vi.mock is hoisted before all imports.
vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn(),
  decodeEncryptionKey: vi.fn().mockReturnValue(Buffer.alloc(32)),
  decryptToken: vi.fn().mockReturnValue("shpat_real_access_token"),
}));

vi.mock("@lapsed/core", () => ({
  runVoiceExtraction: vi.fn(),
}));

// Anthropic SDK default export is a class — stub it so the route can
// `new Anthropic({...})` without attempting a real API call.
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn() },
  })),
}));

import { createServiceClient, decodeEncryptionKey, decryptToken } from "@lapsed/db";
import { runVoiceExtraction } from "@lapsed/core";
import { POST } from "../app/api/voice/extract/route";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440001";
const CRON_SECRET = "test-secret"; // Matches vitest.config.ts CRON_SECRET env.

const MERCHANT_ROW = {
  id: MERCHANT_ID,
  shopify_shop_domain: "test-shop.myshopify.com",
  // Hex-encoded ciphertext: route strips "\\x" prefix before decrypting.
  shopify_access_token: "\\x616263",
};

const SUCCESS_RESULT: RunVoiceExtractionResult = {
  ok: true,
  versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  versionNumber: 1,
  snapshotId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  tokensInput: 100,
  tokensOutput: 200,
  retries: 0,
};

const FAILURE_RESULT: RunVoiceExtractionResult = {
  ok: false,
  reason: "synthesize",
  detail: "max_retries_exceeded",
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a chainable Supabase mock that resolves `.single()` to the given
 * merchant row (or null on not-found). Only `.from("merchants")` is wired —
 * the route makes exactly one DB query.
 */
function makeServiceClient(
  merchantData: typeof MERCHANT_ROW | null,
  dbError?: { message: string },
): LapsedSupabaseClient {
  const single = vi.fn().mockResolvedValue(
    dbError
      ? { data: null, error: dbError }
      : { data: merchantData, error: null },
  );
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = single;
  return { from: vi.fn().mockReturnValue(chain) } as unknown as LapsedSupabaseClient;
}

function makeRequest(opts: {
  authHeader?: string;
  body?: unknown;
}): NextRequest {
  const auth = opts.authHeader ?? `Bearer ${CRON_SECRET}`;
  return new NextRequest("https://app.lapsed.ai/api/voice/extract", {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(opts.body ?? { merchantId: MERCHANT_ID }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: merchant found, extraction succeeds.
  vi.mocked(createServiceClient).mockReturnValue(makeServiceClient(MERCHANT_ROW));
  vi.mocked(runVoiceExtraction).mockResolvedValue(SUCCESS_RESULT);
  // decodeEncryptionKey and decryptToken already have .mockReturnValue defaults
  // set in vi.mock factories above; they persist across clearAllMocks.
  vi.mocked(decodeEncryptionKey).mockReturnValue(Buffer.alloc(32));
  vi.mocked(decryptToken).mockReturnValue("shpat_real_access_token");
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth gate
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/extract — auth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const req = new NextRequest("https://app.lapsed.ai/api/voice/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchantId: MERCHANT_ID }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  it("returns 401 when secret is wrong", async () => {
    const res = await POST(makeRequest({ authHeader: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  it("returns 401 when header is missing Bearer prefix", async () => {
    const res = await POST(makeRequest({ authHeader: CRON_SECRET }));
    expect(res.status).toBe(401);
  });

  it("does not call runVoiceExtraction on auth failure", async () => {
    await POST(makeRequest({ authHeader: "Bearer wrong" }));
    expect(runVoiceExtraction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Body validation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/extract — body validation", () => {
  it("returns 400 on non-JSON body", async () => {
    const req = new NextRequest("https://app.lapsed.ai/api/voice/extract", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        "Content-Type": "text/plain",
      },
      body: "not-json{{{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  it("returns 400 when merchantId is missing", async () => {
    const res = await POST(makeRequest({ body: { source: "install_orchestrator" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_merchant_id");
  });

  it("returns 400 when merchantId is not a string", async () => {
    const res = await POST(makeRequest({ body: { merchantId: 42 } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_merchant_id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Merchant lookup
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/extract — merchant lookup", () => {
  it("returns 404 when merchant is not found", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeServiceClient(null));
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("merchant_not_found");
  });

  it("returns 404 when DB returns an error", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient(null, { message: "connection refused" }),
    );
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(404);
  });

  it("does not call runVoiceExtraction on merchant-not-found", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeServiceClient(null));
    await POST(makeRequest({}));
    expect(runVoiceExtraction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Success path
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/extract — success", () => {
  it("returns 200 when runVoiceExtraction returns ok:true", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
  });

  it("response body matches runVoiceExtraction result on success", async () => {
    const res = await POST(makeRequest({}));
    const body = (await res.json()) as typeof SUCCESS_RESULT;
    expect(body.ok).toBe(true);
    expect(body.versionId).toBe(SUCCESS_RESULT.versionId);
    expect(body.tokensInput).toBe(SUCCESS_RESULT.tokensInput);
  });

  it("forwards source:install_orchestrator when omitted from body", async () => {
    await POST(makeRequest({ body: { merchantId: MERCHANT_ID } }));
    expect(vi.mocked(runVoiceExtraction)).toHaveBeenCalledWith(
      expect.objectContaining({ source: "install_orchestrator" }),
    );
  });

  it("forwards source:settings_reextract when provided in body", async () => {
    await POST(
      makeRequest({ body: { merchantId: MERCHANT_ID, source: "settings_reextract" } }),
    );
    expect(vi.mocked(runVoiceExtraction)).toHaveBeenCalledWith(
      expect.objectContaining({ source: "settings_reextract" }),
    );
  });

  it("calls decryptToken with the hex ciphertext from the merchant row", async () => {
    await POST(makeRequest({}));
    // Route strips "\\x" prefix → "616263" then Buffer.from(..., 'hex')
    expect(vi.mocked(decryptToken)).toHaveBeenCalledWith(
      Buffer.from("616263", "hex"),
      expect.any(Buffer),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator failure
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/extract — orchestrator failure", () => {
  it("returns 202 when runVoiceExtraction returns ok:false", async () => {
    vi.mocked(runVoiceExtraction).mockResolvedValue(FAILURE_RESULT);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(202);
  });

  it("response body contains ok:false and reason on orchestrator failure", async () => {
    vi.mocked(runVoiceExtraction).mockResolvedValue(FAILURE_RESULT);
    const res = await POST(makeRequest({}));
    const body = (await res.json()) as typeof FAILURE_RESULT;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("synthesize");
  });
});
