// Unit tests for GET /api/campaigns/groups.
//
// Covers: auth gate, 500 error path, response shape, cross-merchant isolation
// (the route uses getMerchantFromSession — a different merchant's session can
// never reach another merchant's group data).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMerchant } from "../app/lib/session";
import type { CustomerGroupSize } from "@lapsed/db";

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn().mockReturnValue({}),
  getCustomerGroupSizes: vi.fn(),
}));

vi.mock("@/app/lib/env", () => ({
  serverEnv: vi.fn().mockReturnValue({
    supabaseUrl: "https://example.supabase.co",
    supabaseSecretKey: "service-key",
  }),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { getCustomerGroupSizes } from "@lapsed/db";
import { GET } from "../app/api/campaigns/groups/route";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT_A: SessionMerchant = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  shopDomain: "shop-a.myshopify.com",
  shopName: "Shop A",
  shopInitials: "SA",
  plan: "starter",
  planLabel: "Starter · 5k msgs",
  onboardingState: "completed" as const,
  installedAt: "2026-05-16T09:00:00.000Z",
};

const MERCHANT_B: SessionMerchant = {
  id: "660e8400-e29b-41d4-a716-446655440002",
  shopDomain: "shop-b.myshopify.com",
  shopName: "Shop B",
  shopInitials: "SB",
  plan: "growth",
  planLabel: "Growth · 25k msgs",
  onboardingState: "completed" as const,
  installedAt: "2026-05-16T09:00:00.000Z",
};

const GROUP_SIZES: CustomerGroupSize[] = [
  { slug: "lapsed_vips", customerCount: 120, lastCampaignedAt: "2026-04-01T10:00:00.000Z" },
  { slug: "at_risk_regulars", customerCount: 340, lastCampaignedAt: null },
  { slug: "single_purchase_converters", customerCount: 210, lastCampaignedAt: null },
  { slug: "price_sensitive_lapsed", customerCount: 80, lastCampaignedAt: "2026-03-15T08:00:00.000Z" },
  { slug: "recent_first_purchasers", customerCount: 55, lastCampaignedAt: null },
  { slug: "win_backs_at_risk", customerCount: 190, lastCampaignedAt: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT_A);
  vi.mocked(getCustomerGroupSizes).mockResolvedValue(GROUP_SIZES);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/campaigns/groups — auth", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Your session has expired. Please refresh and try again.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Success — response shape
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/campaigns/groups — success", () => {
  it("returns 200 with a groups array", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { groups: unknown[] };
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.groups).toHaveLength(6);
  });

  it("each group has slug, label, customerCount and lastCampaignedAt fields", async () => {
    const res = await GET();
    const body = (await res.json()) as {
      groups: Array<{
        slug: string;
        label: string;
        customerCount: number;
        lastCampaignedAt: string | null;
      }>;
    };
    for (const g of body.groups) {
      expect(typeof g.slug).toBe("string");
      expect(typeof g.label).toBe("string");
      expect(typeof g.customerCount).toBe("number");
      // lastCampaignedAt is string or null
      expect(g.lastCampaignedAt === null || typeof g.lastCampaignedAt === "string").toBe(true);
    }
  });

  it("label is a human-readable string (not the raw slug)", async () => {
    const res = await GET();
    const body = (await res.json()) as { groups: Array<{ slug: string; label: string }> };
    const vips = body.groups.find((g) => g.slug === "lapsed_vips");
    expect(vips).toBeDefined();
    expect(vips!.label).not.toBe("lapsed_vips");
    expect(vips!.label.length).toBeGreaterThan(0);
  });

  it("passes the merchant id from the session to getCustomerGroupSizes", async () => {
    await GET();
    expect(vi.mocked(getCustomerGroupSizes)).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT_A.id,
      expect.any(Array),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-merchant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/campaigns/groups — cross-merchant isolation", () => {
  it("uses the authenticated merchant id, not a query parameter", async () => {
    // Merchant B is authenticated. The route must use MERCHANT_B.id.
    vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT_B);
    await GET();
    expect(vi.mocked(getCustomerGroupSizes)).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT_B.id,
      expect.any(Array),
    );
    // Merchant A's id must never appear.
    const calls = vi.mocked(getCustomerGroupSizes).mock.calls;
    expect(calls.every((c) => c[1] !== MERCHANT_A.id)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/campaigns/groups — errors", () => {
  it("returns 500 when getCustomerGroupSizes throws", async () => {
    vi.mocked(getCustomerGroupSizes).mockRejectedValue(new Error("db exploded"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Something went wrong. Please try again.");
  });
});
