// Merchant entitlements — Sprint 09 chunk 11 (decision 30).
//
// `getMerchantEntitlements` is the SINGLE way to check a merchant's feature
// access. It reads the cached `merchants.subscription_tier` / `subscription_status`
// and returns a typed entitlements object derived (purely) from the shared
// TIER_PLANS table — there is no separate entitlements table (decision 30).
//
// SUSPENDED → READ-ONLY. A `suspended` merchant (grace window elapsed,
// decision 31) gets `writesAllowed = false` regardless of tier: existing
// campaigns keep running, but no new approvals, no new sends, no exports. A
// merchant with no plan (null / canceled) is likewise write-blocked.
//
// CACHE. Entitlements are cached in-process for ~5 minutes. The Stripe webhook
// handler (chunk 8) calls `invalidateMerchantEntitlements` after every event
// so a tier or status change is reflected immediately, not up to 5 minutes
// later.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { TIER_PLANS, type SupportTier } from "./subscription-tiers";
import type { SubscriptionTier } from "./stripe-client";

export interface MerchantEntitlements {
  /** The merchant's tier, or null when they have no subscription. */
  tier: SubscriptionTier | null;
  /** Cached subscription status (trialing/active/past_due/canceled/suspended/null). */
  status: string | null;
  /**
   * False when the merchant is suspended or has no live plan. EVERY write path
   * (campaign approval, outbound send, proposal creation, data export) must
   * check this before mutating.
   */
  writesAllowed: boolean;
  /** Max campaign approvals per calendar month (0 when write-blocked). */
  maxCampaignsPerMonth: number;
  /** Max outbound messages per calendar month (0 when write-blocked). */
  maxSendsPerMonth: number;
  /** Support level, or "none" when there is no live plan. */
  supportTier: SupportTier | "none";
  /** Whether the merchant may export data (false when write-blocked). */
  canExportData: boolean;
}

/** The entitlements of a write-blocked merchant (suspended or no plan). */
function readOnlyEntitlements(
  tier: SubscriptionTier | null,
  status: string | null,
): MerchantEntitlements {
  return {
    tier,
    status,
    writesAllowed: false,
    maxCampaignsPerMonth: 0,
    maxSendsPerMonth: 0,
    supportTier: "none",
    canExportData: false,
  };
}

/** Statuses under which a merchant retains full write access. */
const WRITE_ENABLED_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Derives entitlements from a tier + status. Pure (decision 30) — the same
 * inputs always yield the same object. `past_due` keeps full access: the
 * merchant is inside the grace window; only after grace expiry does the
 * billing-grace cron move them to `suspended` and write access drop.
 */
function deriveEntitlements(
  tier: SubscriptionTier | null,
  status: string | null,
): MerchantEntitlements {
  if (!tier || !status || !WRITE_ENABLED_STATUSES.has(status)) {
    // suspended, canceled, or no plan → read-only.
    return readOnlyEntitlements(tier, status);
  }
  const plan = TIER_PLANS[tier];
  return {
    tier,
    status,
    writesAllowed: true,
    maxCampaignsPerMonth: plan.maxCampaignsPerMonth,
    maxSendsPerMonth: plan.maxSendsPerMonth,
    supportTier: plan.supportTier,
    canExportData: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// In-process cache
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: MerchantEntitlements;
  expiresAt: number;
}

const entitlementsCache = new Map<string, CacheEntry>();

/**
 * Drops the cached entitlements for a merchant. Called by the Stripe webhook
 * handler after every event so a tier/status change takes effect immediately.
 */
export function invalidateMerchantEntitlements(merchantId: string): void {
  entitlementsCache.delete(merchantId);
}

/** Test-only: clears the whole cache so suites do not leak state into each other. */
export function _clearEntitlementsCache(): void {
  entitlementsCache.clear();
}

interface MerchantSubscriptionFields {
  subscription_tier: string | null;
  subscription_status: string | null;
}

/**
 * Resolves a merchant's entitlements (decision 30). Reads the cached tier +
 * status off `merchants`, derives the typed entitlements, and caches the
 * result for ~5 minutes. `opts.skipCache` forces a fresh read (used by tests).
 */
export async function getMerchantEntitlements(
  client: LapsedSupabaseClient,
  merchantId: string,
  opts: { skipCache?: boolean } = {},
): Promise<MerchantEntitlements> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);

  if (!opts.skipCache) {
    const cached = entitlementsCache.get(merchantId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  const { data, error } = await client
    .from("merchants")
    .select("subscription_tier, subscription_status")
    .eq("id", merchantId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`getMerchantEntitlements: merchant ${merchantId} not found`);
  const row = data as MerchantSubscriptionFields;

  const value = deriveEntitlements(
    row.subscription_tier as SubscriptionTier | null,
    row.subscription_status,
  );
  entitlementsCache.set(merchantId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature gates
// ─────────────────────────────────────────────────────────────────────────────

/** UTC start-of-month ISO for the month containing `d`. */
function startOfUtcMonth(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export type CampaignApprovalDenialReason =
  | "suspended"
  | "no_plan"
  | "monthly_limit_reached";

export interface CampaignApprovalGateResult {
  allowed: boolean;
  reason?: CampaignApprovalDenialReason;
  entitlements: MerchantEntitlements;
  /** campaign_approved events the merchant has recorded this calendar month. */
  approvedThisMonth: number;
}

/**
 * Decides whether a merchant may approve another campaign this month — the
 * gate the campaign-approval route enforces (decision 30/31). Denied when the
 * merchant is write-blocked (suspended / no plan) or has already used their
 * tier's monthly campaign allowance.
 */
export async function checkCampaignApprovalAllowed(
  client: LapsedSupabaseClient,
  merchantId: string,
  opts: { now?: () => Date } = {},
): Promise<CampaignApprovalGateResult> {
  const now = opts.now ?? (() => new Date());
  // skipCache: this is a billing-critical write gate — it must read the live
  // suspension state, never a (possibly stale, possibly cross-instance) cache.
  const entitlements = await getMerchantEntitlements(client, merchantId, { skipCache: true });

  if (!entitlements.writesAllowed) {
    return {
      allowed: false,
      reason: entitlements.status === "suspended" ? "suspended" : "no_plan",
      entitlements,
      approvedThisMonth: 0,
    };
  }

  // Count campaign_approved events in the current calendar month. The month
  // filter is pushed into the query (not JS-filtered) so the result cannot be
  // silently truncated by the PostgREST row limit and under-count approvals.
  const monthStart = startOfUtcMonth(now());
  const { data, error } = await client
    .from("campaign_events")
    .select("occurred_at")
    .eq("merchant_id", merchantId)
    .eq("event_type", "campaign_approved")
    .gte("occurred_at", monthStart);
  if (error) throw error;
  const approvedThisMonth = (data ?? []).length;

  if (approvedThisMonth >= entitlements.maxCampaignsPerMonth) {
    return { allowed: false, reason: "monthly_limit_reached", entitlements, approvedThisMonth };
  }
  return { allowed: true, entitlements, approvedThisMonth };
}
