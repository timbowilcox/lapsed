// Subscription tier plans — Sprint 09. The single source of truth for what
// each flat tier costs and what it entitles a merchant to. The subscribe UI
// (chunk 7) renders from TIER_PLANS; getMerchantEntitlements (chunk 11) derives
// the typed entitlements object from the same data — no drift between the
// price a merchant sees and the access they get.

import type { SubscriptionTier } from "./stripe-client";

/** Support level a tier includes. */
export type SupportTier = "email" | "priority" | "dedicated";

export interface TierPlan {
  tier: SubscriptionTier;
  /** Merchant-facing tier name. */
  displayName: string;
  /** Flat monthly price in whole USD. */
  priceUsdPerMonth: number;
  /** Max campaign proposals a merchant may approve per calendar month. */
  maxCampaignsPerMonth: number;
  /** Max outbound messages per calendar month. */
  maxSendsPerMonth: number;
  /** Support level included. */
  supportTier: SupportTier;
}

/** The three flat tiers ($299 / $799 / $1499 per CLAUDE.md). */
export const TIER_PLANS: Record<SubscriptionTier, TierPlan> = {
  starter: {
    tier: "starter",
    displayName: "Starter",
    priceUsdPerMonth: 299,
    maxCampaignsPerMonth: 3,
    maxSendsPerMonth: 5_000,
    supportTier: "email",
  },
  growth: {
    tier: "growth",
    displayName: "Growth",
    priceUsdPerMonth: 799,
    maxCampaignsPerMonth: 10,
    maxSendsPerMonth: 25_000,
    supportTier: "priority",
  },
  scale: {
    tier: "scale",
    displayName: "Scale",
    priceUsdPerMonth: 1_499,
    maxCampaignsPerMonth: 40,
    maxSendsPerMonth: 100_000,
    supportTier: "dedicated",
  },
};

/** Human-readable label for a support tier. */
export function supportTierLabel(support: SupportTier): string {
  switch (support) {
    case "email":
      return "Email support";
    case "priority":
      return "Priority support";
    case "dedicated":
      return "Dedicated support";
  }
}
