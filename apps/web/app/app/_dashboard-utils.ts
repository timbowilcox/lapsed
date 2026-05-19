// Pure utility functions for the dashboard reframe (chunk 10).
// No imports from Next.js or React — keeps these fully unit-testable.

import type { MerchantAttributionCampaign } from "@lapsed/db";

// ─────────────────────────────────────────────────────────────────────────────
// Period type
// ─────────────────────────────────────────────────────────────────────────────

export type DashboardPeriod = "30" | "90" | "all";

export function parsePeriod(raw: string | undefined): DashboardPeriod {
  if (raw === "90" || raw === "all") return raw;
  return "30"; // default
}

// ─────────────────────────────────────────────────────────────────────────────
// Period stats aggregation
// ─────────────────────────────────────────────────────────────────────────────

export interface AttributionPeriodStats {
  totalIncrementalCents: number;
  ciLowCents: number | null;
  ciHighCents: number | null;
  campaignCount: number;
  hasData: boolean;
  /** Percentage change vs previous equal-length period. Null when no prior data. */
  vsPreviousPeriodPct: number | null;
}

/**
 * Aggregates attribution campaign rows into a period stats summary.
 *
 * For 30/90 periods, filters by windowCloseDate within the past N days and
 * compares to the immediately preceding equal-length window (for vsPercent).
 * For "all", includes everything and skips vsPercent.
 *
 * CI aggregation: we sum CI bounds as an approximation. Individual campaign
 * CIs are not statistically independent, so this is an upper-bound estimate
 * displayed as "estimated range". Labelled as such in the UI.
 *
 * @param campaigns  All attribution campaigns from getMerchantAttributionRollup
 * @param period     "30" | "90" | "all"
 * @param now        Injectable for deterministic tests (default: Date.now())
 */
export function computePeriodStats(
  campaigns: MerchantAttributionCampaign[],
  period: DashboardPeriod,
  now: Date = new Date(),
): AttributionPeriodStats {
  if (campaigns.length === 0) {
    return { totalIncrementalCents: 0, ciLowCents: null, ciHighCents: null, campaignCount: 0, hasData: false, vsPreviousPeriodPct: null };
  }

  if (period === "all") {
    const total = campaigns.reduce((s, c) => s + c.incrementalRevenueCents, 0);
    const hasCi = campaigns.every((c) => c.ciLowCents !== null && c.ciHighCents !== null);
    return {
      totalIncrementalCents: total,
      ciLowCents: hasCi ? campaigns.reduce((s, c) => s + (c.ciLowCents ?? 0), 0) : null,
      ciHighCents: hasCi ? campaigns.reduce((s, c) => s + (c.ciHighCents ?? 0), 0) : null,
      campaignCount: campaigns.length,
      hasData: total > 0,
      vsPreviousPeriodPct: null,
    };
  }

  const days = period === "30" ? 30 : 90;
  const msPerDay = 24 * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - days * msPerDay);
  const prevCutoff = new Date(now.getTime() - 2 * days * msPerDay);

  const current = campaigns.filter((c) => new Date(c.windowCloseDate) >= cutoff);
  const previous = campaigns.filter(
    (c) => new Date(c.windowCloseDate) >= prevCutoff && new Date(c.windowCloseDate) < cutoff,
  );

  const currentTotal = current.reduce((s, c) => s + c.incrementalRevenueCents, 0);
  const previousTotal = previous.reduce((s, c) => s + c.incrementalRevenueCents, 0);

  let vsPct: number | null = null;
  if (previousTotal > 0) {
    vsPct = Math.round(((currentTotal - previousTotal) / previousTotal) * 100);
  }

  const hasCi = current.length > 0 && current.every((c) => c.ciLowCents !== null && c.ciHighCents !== null);

  return {
    totalIncrementalCents: currentTotal,
    ciLowCents: hasCi ? current.reduce((s, c) => s + (c.ciLowCents ?? 0), 0) : null,
    ciHighCents: hasCi ? current.reduce((s, c) => s + (c.ciHighCents ?? 0), 0) : null,
    campaignCount: current.length,
    hasData: currentTotal > 0,
    vsPreviousPeriodPct: vsPct,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Forecast projection
// ─────────────────────────────────────────────────────────────────────────────

export interface ForecastStats {
  projectedNextMonthCents: number | null;
  hasData: boolean;
}

/**
 * Projects next-30-day restored revenue from the last 30 days.
 * No extrapolation — simply carries forward the current-period average.
 * Returns null when no attribution data exists.
 */
export function computeForecast(
  campaigns: MerchantAttributionCampaign[],
  now: Date = new Date(),
): ForecastStats {
  const current = computePeriodStats(campaigns, "30", now);
  if (!current.hasData) return { projectedNextMonthCents: null, hasData: false };
  return {
    projectedNextMonthCents: current.totalIncrementalCents,
    hasData: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign health derivation
// ─────────────────────────────────────────────────────────────────────────────

export interface CampaignHealthRow {
  proposalId: string;
  name: string;
  daysRunning: number;
  cohortSize: number;
  variantCount: number;
}

/**
 * Derives dashboard health rows from approved campaign list items.
 *
 * @param items    CampaignListItem[] filtered to status="approved"
 * @param now      Injectable for tests
 */
export function deriveCampaignHealthRows(
  items: Array<{ proposalId: string; groupSlug: string; approvedAt: string | null; variantCount: number }>,
  groupLabel: (slug: string) => string,
  now: Date = new Date(),
): CampaignHealthRow[] {
  return items.map((item) => {
    const msRunning = item.approvedAt
      ? now.getTime() - new Date(item.approvedAt).getTime()
      : 0;
    const daysRunning = Math.max(0, Math.floor(msRunning / (24 * 60 * 60 * 1000)));
    return {
      proposalId: item.proposalId,
      name: groupLabel(item.groupSlug),
      daysRunning,
      cohortSize: 0, // cohort size not available from list query; shown as "—" in UI
      variantCount: item.variantCount,
    };
  });
}
