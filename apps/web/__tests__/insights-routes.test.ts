// Tests for the AI Insights API routes — Sprint 11 chunk 9.
//
// GET  /api/insights            — returns active insights for the merchant
// POST /api/insights/[id]       — state transitions (dismiss / act / snooze)
// GET  /api/cron/insights       — runs generateRecommendations for all merchants

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SessionMerchant } from "../app/lib/session";

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn().mockReturnValue({}),
}));

vi.mock("@lapsed/core", () => ({
  getActiveInsights: vi.fn(),
  markDismissed: vi.fn(),
  markActed: vi.fn(),
  markSnoozed: vi.fn(),
  generateRecommendations: vi.fn(),
  InsightNotFoundError: class InsightNotFoundError extends Error {
    readonly insightId: string;
    constructor(insightId: string) {
      super(`Insight ${insightId} not found`);
      this.name = "InsightNotFoundError";
      this.insightId = insightId;
    }
  },
}));

vi.mock("@/app/lib/env", () => ({
  serverEnv: vi.fn().mockReturnValue({
    supabaseUrl: "https://example.supabase.co",
    supabaseSecretKey: "service-key",
    cronSecret: "test-cron-secret",
  }),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import {
  getActiveInsights,
  markDismissed,
  markActed,
  markSnoozed,
  generateRecommendations,
  InsightNotFoundError,
  type InsightRow,
} from "@lapsed/core";
import { GET as getInsights } from "../app/api/insights/route";
import { POST as postInsightAction } from "../app/api/insights/[id]/route";
import { GET as cronInsights } from "../app/api/cron/insights/route";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT: SessionMerchant = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  shopDomain: "test-shop.myshopify.com",
  shopName: "Test Shop",
  shopInitials: "TS",
  plan: "growth",
  planLabel: "Growth",
  installedAt: "2026-01-01T00:00:00Z",
};

const INSIGHT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeInsight(overrides: Partial<InsightRow> = {}): InsightRow {
  return {
    id: INSIGHT_ID,
    merchantId: MERCHANT.id,
    insightKey: "cohort:lapsed_vip_dormancy",
    priority: "HIGH",
    category: "cohort",
    signalMetric: "lapsed_vip_count",
    signalValue: 15,
    threshold: 10,
    merchantCopy: "15 dormant VIP customers.",
    ctaAction: { route: "/app/campaigns/new", params: { groupSlug: "lapsed_vips" } },
    state: "active",
    createdAt: "2026-05-18T05:00:00Z",
    expiresAt: "2026-05-18T23:00:00Z",
    ...overrides,
  };
}

function makeNextRequest(url: string, method = "GET", headers?: Record<string, string>): NextRequest {
  return new NextRequest(url, { method, headers });
}

function makeCronRequest(): NextRequest {
  return makeNextRequest("https://app.lapsed.ai/api/cron/insights", "GET", {
    Authorization: "Bearer test-cron-secret",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/insights
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/insights", () => {
  beforeEach(() => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
    vi.mocked(getActiveInsights).mockResolvedValue([]);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await getInsights();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("session");
  });

  it("returns empty array when there are 0 active insights", async () => {
    vi.mocked(getActiveInsights).mockResolvedValue([]);
    const res = await getInsights();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.insights).toEqual([]);
  });

  it("returns 1 insight correctly shaped", async () => {
    vi.mocked(getActiveInsights).mockResolvedValue([makeInsight()]);
    const res = await getInsights();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.insights).toHaveLength(1);
    expect(body.insights[0].insightKey).toBe("cohort:lapsed_vip_dormancy");
  });

  it("returns 2 insights", async () => {
    vi.mocked(getActiveInsights).mockResolvedValue([
      makeInsight({ id: "id-1", insightKey: "cohort:lapsed_vip_dormancy" }),
      makeInsight({ id: "id-2", insightKey: "opt_out:elevated_count", category: "opt_out" }),
    ]);
    const res = await getInsights();
    const body = await res.json();
    expect(body.insights).toHaveLength(2);
  });

  it("returns 4 insights", async () => {
    const insights = ([1, 2, 3, 4] as const).map((n) =>
      makeInsight({ id: `id-${n}`, insightKey: `cohort:key_${n}` }),
    );
    vi.mocked(getActiveInsights).mockResolvedValue(insights);
    const res = await getInsights();
    const body = await res.json();
    expect(body.insights).toHaveLength(4);
  });

  it("returns 500 when the DB query fails", async () => {
    vi.mocked(getActiveInsights).mockRejectedValue(new Error("db error"));
    const res = await getInsights();
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/insights/[id]?action=...
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/insights/[id]?action=...", () => {
  beforeEach(() => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
    vi.mocked(markDismissed).mockResolvedValue(undefined);
    vi.mocked(markActed).mockResolvedValue(undefined);
    vi.mocked(markSnoozed).mockResolvedValue(undefined);
  });

  function makeActionRequest(id: string, action: string): NextRequest {
    return makeNextRequest(`https://app.lapsed.ai/api/insights/${id}?action=${action}`, "POST");
  }

  it("returns 401 when not authenticated", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const req = makeActionRequest(INSIGHT_ID, "dismiss");
    const res = await postInsightAction(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid action", async () => {
    const req = makeActionRequest(INSIGHT_ID, "invalid_action");
    const res = await postInsightAction(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid action");
  });

  it("dismiss: calls markDismissed and returns 204", async () => {
    const req = makeActionRequest(INSIGHT_ID, "dismiss");
    const res = await postInsightAction(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
    expect(res.status).toBe(204);
    expect(vi.mocked(markDismissed)).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT.id,
      INSIGHT_ID,
    );
  });

  it("act: calls markActed and returns 204", async () => {
    const req = makeActionRequest(INSIGHT_ID, "act");
    const res = await postInsightAction(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
    expect(res.status).toBe(204);
    expect(vi.mocked(markActed)).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT.id,
      INSIGHT_ID,
    );
  });

  it("snooze: calls markSnoozed and returns 204", async () => {
    const req = makeActionRequest(INSIGHT_ID, "snooze");
    const res = await postInsightAction(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
    expect(res.status).toBe(204);
    expect(vi.mocked(markSnoozed)).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT.id,
      INSIGHT_ID,
    );
  });

  it("dismiss: returns 404 when insight not found (InsightNotFoundError)", async () => {
    vi.mocked(markDismissed).mockRejectedValue(new InsightNotFoundError(INSIGHT_ID));
    const req = makeActionRequest(INSIGHT_ID, "dismiss");
    const res = await postInsightAction(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
    expect(res.status).toBe(404);
  });

  it("dismiss: persists — markDismissed is called with merchant-scoped id", async () => {
    const req = makeActionRequest(INSIGHT_ID, "dismiss");
    await postInsightAction(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
    // Verifies the dismiss is scoped to the authenticated merchant (not global)
    expect(vi.mocked(markDismissed)).toHaveBeenCalledWith(
      expect.anything(), // service client
      MERCHANT.id,       // merchantId — tenancy gate
      INSIGHT_ID,        // specific insight
    );
  });

  it("returns 500 on unexpected error", async () => {
    vi.mocked(markDismissed).mockRejectedValue(new Error("unexpected db error"));
    const req = makeActionRequest(INSIGHT_ID, "dismiss");
    const res = await postInsightAction(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cron/insights
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/cron/insights", () => {
  beforeEach(() => {
    vi.mocked(generateRecommendations).mockResolvedValue({ generated: 0, skipped: 0 });
  });

  it("returns 401 when Authorization header is missing", async () => {
    const req = makeNextRequest("https://app.lapsed.ai/api/cron/insights");
    const res = await cronInsights(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 when Authorization header has wrong secret", async () => {
    const req = makeNextRequest("https://app.lapsed.ai/api/cron/insights", "GET", {
      Authorization: "Bearer wrong-secret",
    });
    const res = await cronInsights(req);
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct cron secret and 0 merchants", async () => {
    // merchants table returns empty (service client returns {}; DB mock)
    const { createServiceClient } = await import("@lapsed/db");
    vi.mocked(createServiceClient).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: [], error: null }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>);

    const res = await cronInsights(makeCronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchants).toBe(0);
    expect(body.totalGenerated).toBe(0);
  });

  it("returns 500 when merchants fetch fails", async () => {
    const { createServiceClient } = await import("@lapsed/db");
    vi.mocked(createServiceClient).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ data: null, error: { message: "db error" } }),
      }),
    } as unknown as ReturnType<typeof createServiceClient>);

    const res = await cronInsights(makeCronRequest());
    expect(res.status).toBe(500);
  });
});
