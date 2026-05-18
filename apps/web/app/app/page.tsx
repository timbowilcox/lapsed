// Dashboard — four-section morning standup pattern (chunk 10).
//
// 1. Headline outcome — incremental revenue, counterfactual, 95% CI, period toggle
// 2. Active state   — lifecycle pipeline + approved campaign health rows
// 3. Recommended actions — top 3 insights from the insights engine (by priority)
// 4. Forecast        — projected next-30-day revenue + customer milestone

import { Suspense } from "react";
import { MerchantShell } from "./_components/merchant-shell";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import {
  createServiceClient,
  getMerchantAttributionRollup,
  getLifecyclePipelineCounts,
  getProposalsByStatus,
  getActiveInsights,
  getReadyToReactivateCount,
  getLatestScoringRun,
} from "@lapsed/db";
import { DashboardHeadline } from "./_dashboard-headline";
import { DashboardLifecycle } from "./_dashboard-lifecycle";
import { DashboardRecommendedActions } from "./_dashboard-recommended-actions";
import { DashboardForecast } from "./_dashboard-forecast";
import {
  parsePeriod,
  computePeriodStats,
  computeForecast,
  deriveCampaignHealthRows,
} from "./_dashboard-utils";
import { groupLabel } from "./campaigns/_labels";

export const dynamic = "force-dynamic";

type RawSearchParams = Record<string, string | string[] | undefined>;

// Priority order for sorting insights before slicing to top 3.
const INSIGHT_PRIORITY_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  // Await searchParams once to avoid double-resolution.
  const sp = await searchParams;
  const merchant = await requireMerchant({ searchParams: sp });

  const period = parsePeriod(
    Array.isArray(sp.period) ? sp.period[0] : sp.period,
  );

  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Parallel data fetch — all independent.
  const [rollup, lifecycleCounts, approvedCampaigns, activeInsights, readyCount, latestRun] =
    await Promise.all([
      getMerchantAttributionRollup(serviceClient, merchant.id).catch(() => ({ campaigns: [] })),
      getLifecyclePipelineCounts(serviceClient, merchant.id).catch(() => ({
        new: 0, engaged: 0, at_risk: 0, lapsed: 0, won_back: 0, churned: 0,
      })),
      getProposalsByStatus(serviceClient, merchant.id, "approved").catch(() => []),
      getActiveInsights(serviceClient, merchant.id).catch(() => []),
      getReadyToReactivateCount(serviceClient, merchant.id, env.propensityReadyThreshold).catch(() => 0),
      getLatestScoringRun(serviceClient, merchant.id).catch(() => null),
    ]);

  const now = new Date();
  const periodStats = computePeriodStats(rollup.campaigns, period, now);
  const forecast = computeForecast(rollup.campaigns, now);

  // Build by-day chart data scoped to the active period so the sparkline
  // matches the headline number — not an all-time view.
  const msPerDay = 24 * 60 * 60 * 1000;
  const periodCutoff =
    period === "all"
      ? null
      : new Date(now.getTime() - (period === "30" ? 30 : 90) * msPerDay);

  const byDay = rollup.campaigns
    .filter(
      (c) =>
        c.incrementalRevenueCents > 0 &&
        (periodCutoff === null || new Date(c.windowCloseDate) >= periodCutoff),
    )
    .map((c) => ({
      date: c.windowCloseDate,
      value: Math.round(c.incrementalRevenueCents / 100),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Sort insights by priority (HIGH first) before passing to section 3.
  const sortedInsights = [...activeInsights].sort(
    (a, b) =>
      (INSIGHT_PRIORITY_ORDER[a.priority] ?? 3) -
      (INSIGHT_PRIORITY_ORDER[b.priority] ?? 3),
  );

  const campaignHealthRows = deriveCampaignHealthRows(
    approvedCampaigns,
    groupLabel,
    now,
  );

  return (
    <MerchantShell pageTitle="Dashboard">
      {/* Section 1 — Headline outcome */}
      <DashboardHeadline
        stats={periodStats}
        period={period}
        byDay={byDay}
      />

      {/* Section 2 — Active state */}
      <DashboardLifecycle
        lifecycleCounts={lifecycleCounts}
        campaigns={campaignHealthRows}
      />

      {/* Section 3 — Recommended actions (client component, SSR-hydrated, top 3 by priority) */}
      <Suspense fallback={null}>
        <DashboardRecommendedActions initialInsights={sortedInsights} />
      </Suspense>

      {/* Section 4 — Forecast */}
      <DashboardForecast
        forecast={forecast}
        lapsedCount={readyCount}
        hasScored={latestRun !== null}
      />
    </MerchantShell>
  );
}
