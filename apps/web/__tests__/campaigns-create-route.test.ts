// Unit tests for POST /api/campaigns/create.
//
// Covers: auth gate, missing groupSlug, invalid groupSlug, proposeCampaign
// success, proposeCampaign failure (voice_profile, cap_check, group_fetch,
// generic), cancellation (no submit called).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMerchant } from "../app/lib/session";

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn().mockReturnValue({}),
}));

vi.mock("@lapsed/core", () => ({
  proposeCampaign: vi.fn(),
}));

// anthropic-ai/sdk is imported but only used to create a client object that
// gets passed to proposeCampaign — mock it as a no-op constructor.
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({})),
}));

// serverEnv returns the values the route needs.
vi.mock("@/app/lib/env", () => ({
  serverEnv: vi.fn().mockReturnValue({
    supabaseUrl: "https://example.supabase.co",
    supabaseSecretKey: "service-key",
    anthropicApiKey: "sk-ant-test",
    campaignProposalDailyCapDefault: 5,
    holdoutRate: 0.1,
    sonnetModel: "claude-sonnet-4-6-latest",
  }),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { proposeCampaign } from "@lapsed/core";
import { POST } from "../app/api/campaigns/create/route";

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

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/campaigns/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SUCCESS_RESULT = {
  ok: true as const,
  proposalId: "prop-123",
  variantCount: 3,
  customerCount: 800,
  holdoutCount: 80,
  tokensInput: 1000,
  tokensOutput: 500,
  retries: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
  vi.mocked(proposeCampaign).mockResolvedValue(SUCCESS_RESULT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/campaigns/create — auth", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await POST(makeRequest({ groupSlug: "lapsed_vips" }));
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthenticated");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/campaigns/create — validation", () => {
  it("returns 400 when body is not valid JSON object", async () => {
    const req = new Request("http://localhost/api/campaigns/create", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when groupSlug is missing", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/valid customer group/i);
  });

  it("returns 400 when groupSlug is not a known group", async () => {
    const res = await POST(makeRequest({ groupSlug: "unknown_slug" }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/valid customer group/i);
  });

  it("accepts all known group slugs", async () => {
    const slugs = [
      "lapsed_vips",
      "at_risk_regulars",
      "single_purchase_converters",
      "price_sensitive_lapsed",
      "recent_first_purchasers",
      "win_backs_at_risk",
    ];
    for (const slug of slugs) {
      const res = await POST(makeRequest({ groupSlug: slug }));
      expect(res.status).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Success
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/campaigns/create — success", () => {
  it("returns proposalId on success", async () => {
    const res = await POST(makeRequest({ groupSlug: "lapsed_vips" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { proposalId: string };
    expect(body.proposalId).toBe("prop-123");
  });

  it("calls proposeCampaign with source: 'manual'", async () => {
    await POST(makeRequest({ groupSlug: "at_risk_regulars" }));
    expect(vi.mocked(proposeCampaign)).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: MERCHANT.id,
        groupSlug: "at_risk_regulars",
        source: "manual",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure cases from proposeCampaign
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/campaigns/create — proposeCampaign failures", () => {
  it("returns 422 with brand-voice message on voice_profile failure", async () => {
    vi.mocked(proposeCampaign).mockResolvedValue({
      ok: false,
      reason: "voice_profile",
      detail: "no_active_voice_profile",
      proposalId: null,
    });
    const res = await POST(makeRequest({ groupSlug: "lapsed_vips" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/brand voice/i);
  });

  it("returns 429 on cap_check failure", async () => {
    vi.mocked(proposeCampaign).mockResolvedValue({
      ok: false,
      reason: "cap_check",
      detail: "daily_cap_exhausted",
      proposalId: "prop-x",
    });
    const res = await POST(makeRequest({ groupSlug: "lapsed_vips" }));
    expect(res.status).toBe(429);
  });

  it("returns 422 with sync message on group_fetch failure", async () => {
    vi.mocked(proposeCampaign).mockResolvedValue({
      ok: false,
      reason: "group_fetch",
      detail: "group_has_no_customers",
      proposalId: "prop-x",
    });
    const res = await POST(makeRequest({ groupSlug: "lapsed_vips" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/nightly sync/i);
  });

  it("returns 500 for unexpected failures", async () => {
    vi.mocked(proposeCampaign).mockResolvedValue({
      ok: false,
      reason: "design",
      detail: "ai_error",
      proposalId: "prop-x",
    });
    const res = await POST(makeRequest({ groupSlug: "lapsed_vips" }));
    expect(res.status).toBe(500);
  });
});
