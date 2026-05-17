// Merchant entitlements tests — Sprint 09 chunk 11 (decisions 30/31).

import { beforeEach, describe, expect, it } from "vitest";
import {
  getMerchantEntitlements,
  invalidateMerchantEntitlements,
  checkCampaignApprovalAllowed,
  _clearEntitlementsCache,
} from "../src/entitlements";
import { TIER_PLANS } from "../src/subscription-tiers";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const M = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => _clearEntitlementsCache());

function seed(
  tier: string | null,
  status: string | null,
  campaignEvents: FakeRow[] = [],
) {
  return makeFakeSupabase({
    merchants: [
      {
        id: M,
        shopify_shop_domain: "demo.myshopify.com",
        subscription_tier: tier,
        subscription_status: status,
      },
    ],
    campaign_events: campaignEvents,
  });
}

describe("getMerchantEntitlements — per tier", () => {
  for (const tier of ["starter", "growth", "scale"] as const) {
    it(`returns the ${tier} tier's limits for an active subscription`, async () => {
      const { client } = seed(tier, "active");
      const ent = await getMerchantEntitlements(client, M, { skipCache: true });
      const plan = TIER_PLANS[tier];
      expect(ent.tier).toBe(tier);
      expect(ent.writesAllowed).toBe(true);
      expect(ent.maxCampaignsPerMonth).toBe(plan.maxCampaignsPerMonth);
      expect(ent.maxSendsPerMonth).toBe(plan.maxSendsPerMonth);
      expect(ent.supportTier).toBe(plan.supportTier);
      expect(ent.canExportData).toBe(true);
    });
  }

  it("keeps write access for a past_due subscription (still inside grace)", async () => {
    const { client } = seed("growth", "past_due");
    const ent = await getMerchantEntitlements(client, M, { skipCache: true });
    expect(ent.writesAllowed).toBe(true);
    expect(ent.maxCampaignsPerMonth).toBe(TIER_PLANS.growth.maxCampaignsPerMonth);
  });

  it("grants full write access for a trialing subscription", async () => {
    const { client } = seed("growth", "trialing");
    const ent = await getMerchantEntitlements(client, M, { skipCache: true });
    expect(ent.writesAllowed).toBe(true);
    expect(ent.maxSendsPerMonth).toBe(TIER_PLANS.growth.maxSendsPerMonth);
  });
});

describe("getMerchantEntitlements — write-blocked states", () => {
  it("forces read-only for a suspended merchant regardless of tier", async () => {
    const { client } = seed("scale", "suspended");
    const ent = await getMerchantEntitlements(client, M, { skipCache: true });
    expect(ent.writesAllowed).toBe(false);
    expect(ent.maxCampaignsPerMonth).toBe(0);
    expect(ent.maxSendsPerMonth).toBe(0);
    expect(ent.supportTier).toBe("none");
    expect(ent.canExportData).toBe(false);
    // The tier is still reported (for display) even though access is revoked.
    expect(ent.tier).toBe("scale");
  });

  it("forces read-only for a canceled subscription", async () => {
    const { client } = seed("growth", "canceled");
    const ent = await getMerchantEntitlements(client, M, { skipCache: true });
    expect(ent.writesAllowed).toBe(false);
  });

  it("forces read-only for a merchant with no subscription", async () => {
    const { client } = seed(null, null);
    const ent = await getMerchantEntitlements(client, M, { skipCache: true });
    expect(ent.writesAllowed).toBe(false);
    expect(ent.tier).toBeNull();
  });

  it("throws when the merchant does not exist", async () => {
    const { client } = makeFakeSupabase({ merchants: [] });
    await expect(getMerchantEntitlements(client, M, { skipCache: true })).rejects.toThrow(
      /not found/,
    );
  });
});

describe("getMerchantEntitlements — caching + invalidation", () => {
  it("caches the result and serves the cached value until invalidated", async () => {
    const { client } = seed("starter", "active");
    const first = await getMerchantEntitlements(client, M);
    expect(first.tier).toBe("starter");

    // Change the underlying row to a different tier.
    await client.from("merchants").update({ subscription_tier: "scale" }).eq("id", M);

    // A cached read still returns the original value.
    const cached = await getMerchantEntitlements(client, M);
    expect(cached.tier).toBe("starter");

    // After invalidation (what the Stripe webhook calls), the fresh value loads.
    invalidateMerchantEntitlements(M);
    const fresh = await getMerchantEntitlements(client, M);
    expect(fresh.tier).toBe("scale");
  });
});

describe("checkCampaignApprovalAllowed", () => {
  const now = () => new Date("2026-05-20T12:00:00Z");

  function approvedEvent(occurredAt: string): FakeRow {
    return {
      merchant_id: M,
      event_type: "campaign_approved",
      occurred_at: occurredAt,
      ingested_at: occurredAt,
      payload: { user_id: "u1" },
    };
  }

  it("allows approval when under the monthly limit", async () => {
    // starter allows 3/month; 1 approved so far this month.
    const { client } = seed("starter", "active", [approvedEvent("2026-05-05T00:00:00Z")]);
    const gate = await checkCampaignApprovalAllowed(client, M, { now });
    expect(gate.allowed).toBe(true);
    expect(gate.approvedThisMonth).toBe(1);
  });

  it("denies approval when the tier's monthly limit is reached", async () => {
    // starter allows 3/month; 3 already approved this month.
    const { client } = seed("starter", "active", [
      approvedEvent("2026-05-02T00:00:00Z"),
      approvedEvent("2026-05-09T00:00:00Z"),
      approvedEvent("2026-05-15T00:00:00Z"),
    ]);
    const gate = await checkCampaignApprovalAllowed(client, M, { now });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("monthly_limit_reached");
    expect(gate.approvedThisMonth).toBe(3);
  });

  it("counts only the current calendar month — last month's approvals do not count", async () => {
    const { client } = seed("starter", "active", [
      approvedEvent("2026-04-28T00:00:00Z"), // previous month — excluded
      approvedEvent("2026-04-30T00:00:00Z"), // previous month — excluded
      approvedEvent("2026-05-03T00:00:00Z"), // this month
    ]);
    const gate = await checkCampaignApprovalAllowed(client, M, { now });
    expect(gate.allowed).toBe(true);
    expect(gate.approvedThisMonth).toBe(1);
  });

  it("denies a suspended merchant with reason `suspended`", async () => {
    const { client } = seed("growth", "suspended");
    const gate = await checkCampaignApprovalAllowed(client, M, { now });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("suspended");
  });

  it("denies a merchant with no plan with reason `no_plan`", async () => {
    const { client } = seed(null, null);
    const gate = await checkCampaignApprovalAllowed(client, M, { now });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toBe("no_plan");
  });
});
