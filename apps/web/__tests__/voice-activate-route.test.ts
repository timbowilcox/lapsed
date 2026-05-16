// Unit tests for POST /api/voice/activate.
//
// Covers: auth gate, body validation, tenancy (the version must belong to
// the session merchant), the voice_activated event write, and re-materialize.
// appendVoiceEvent / materializeVoice are mocked — their own tests live in
// packages/core.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SessionMerchant } from "../app/lib/session";
import type { LapsedSupabaseClient } from "@lapsed/db";

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@lapsed/core", () => ({
  appendVoiceEvent: vi.fn(),
  materializeVoice: vi.fn(),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { createServiceClient } from "@lapsed/db";
import { appendVoiceEvent, materializeVoice } from "@lapsed/core";
import { POST } from "../app/api/voice/activate/route";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT: SessionMerchant = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  shopDomain: "test-shop.myshopify.com",
  shopName: "Test Shop",
  shopInitials: "TS",
  plan: "starter",
  planLabel: "Starter · 5k msgs",
  installedAt: "2026-05-16T09:00:00.000Z",
};

const VERSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIOR_VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeServiceClient(opts: {
  version?: { id: string } | null;
  versionError?: { code?: string; message: string } | null;
  agentProfile?: { active_voice_version_id: string | null } | null;
}): LapsedSupabaseClient {
  return {
    from: vi.fn((table: string) => {
      if (table === "voice_versions") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve(
              opts.versionError
                ? { data: null, error: opts.versionError }
                : { data: opts.version ?? null, error: null },
            ),
        };
        return chain;
      }
      // agent_profiles
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: opts.agentProfile ?? null, error: null }),
      };
      return chain;
    }),
  } as unknown as LapsedSupabaseClient;
}

function makeRequest(body: unknown, opts: { raw?: string } = {}): NextRequest {
  return new NextRequest("https://app.lapsed.ai/api/voice/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: opts.raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
  vi.mocked(createServiceClient).mockReturnValue(
    makeServiceClient({
      version: { id: VERSION_ID },
      agentProfile: { active_voice_version_id: PRIOR_VERSION_ID },
    }),
  );
  vi.mocked(appendVoiceEvent).mockResolvedValue(undefined);
  vi.mocked(materializeVoice).mockResolvedValue({ activeVoiceVersionId: VERSION_ID });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth + body validation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/activate — auth + body", () => {
  it("returns 401 when there is no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await POST(makeRequest({ versionId: VERSION_ID }));
    expect(res.status).toBe(401);
  });

  it("returns 400 on a non-JSON body", async () => {
    const res = await POST(makeRequest(null, { raw: "not-json{{" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
  });

  it("returns 400 when versionId is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("missing_version_id");
  });

  it("returns 400 when versionId is not a string", async () => {
    const res = await POST(makeRequest({ versionId: 42 }));
    expect(res.status).toBe(400);
  });

  it("does not write an event on auth failure", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    await POST(makeRequest({ versionId: VERSION_ID }));
    expect(appendVoiceEvent).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenancy
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/activate — tenancy", () => {
  it("returns 404 when the version does not belong to the merchant", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeServiceClient({ version: null }));
    const res = await POST(makeRequest({ versionId: VERSION_ID }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("version_not_found");
  });

  it("does not write an event when the version is not found", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeServiceClient({ version: null }));
    await POST(makeRequest({ versionId: VERSION_ID }));
    expect(appendVoiceEvent).not.toHaveBeenCalled();
    expect(materializeVoice).not.toHaveBeenCalled();
  });

  it("returns 500 when the version lookup errors", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({ versionError: { message: "rls denied" } }),
    );
    const res = await POST(makeRequest({ versionId: VERSION_ID }));
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Activation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/activate — activation", () => {
  it("returns 200 and writes a voice_activated event via settings_activate", async () => {
    const res = await POST(makeRequest({ versionId: VERSION_ID }));
    expect(res.status).toBe(200);
    expect(appendVoiceEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        merchantId: MERCHANT.id,
        eventType: "voice_activated",
        source: "settings_activate",
        payload: { version_id: VERSION_ID, previous_version_id: PRIOR_VERSION_ID },
      }),
    );
  });

  it("re-materializes the voice state after writing the event", async () => {
    await POST(makeRequest({ versionId: VERSION_ID }));
    expect(materializeVoice).toHaveBeenCalledWith(expect.anything(), MERCHANT.id);
  });

  it("records null previous_version_id when no version was active", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({ version: { id: VERSION_ID }, agentProfile: null }),
    );
    await POST(makeRequest({ versionId: VERSION_ID }));
    expect(appendVoiceEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        payload: { version_id: VERSION_ID, previous_version_id: null },
      }),
    );
  });
});
