// Demo dashboard — same four-section layout as the live dashboard (chunk 10).
//
// Decision 34: demo mode renders from fixture data. No live DB calls.
// The section components are IDENTICAL to the live path — demo data is injected
// via props, never wired at the route level. When the live layout changes,
// demo automatically picks up the new design.

import { DemoShell } from "./_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";
import { DashboardHeadline } from "../app/_dashboard-headline";
import { DashboardLifecycle } from "../app/_dashboard-lifecycle";
import { DashboardRecommendedActions } from "../app/_dashboard-recommended-actions";
import { DashboardForecast } from "../app/_dashboard-forecast";
import type { AttributionPeriodStats, ForecastStats, CampaignHealthRow } from "../app/_dashboard-utils";
import type { LifecycleStageCounts } from "@lapsed/db";

export default function DemoPage() {
  const { merchant, campaigns, attribution, insights } = demoFixtures;

  // ── Section 1: Headline ──────────────────────────────────────────────────

  const headlineStats: AttributionPeriodStats = {
    totalIncrementalCents: attribution.incrementalRevenue * 100,
    ciLowCents: attribution.ciLow * 100,
    ciHighCents: attribution.ciHigh * 100,
    campaignCount: attribution.byCampaign.length,
    hasData: true,
    vsPreviousPeriodPct: attribution.vsPreviousPeriodPct,
  };

  const byDay = attribution.byDay.map((d) => ({
    date: d.date,
    value: d.recoveredRevenue,
  }));

  // ── Section 2: Lifecycle + campaign health ────────────────────────────────

  // Derive lifecycle counts from demo merchant data (illustrative).
  // VIP + repeat customers map to engaged/at_risk/lapsed stages.
  const lifecycleCounts: LifecycleStageCounts = {
    new: 412,
    engaged: 1284,
    at_risk: 342,
    lapsed: merchant.totalLapsedCount,
    won_back: 53,
    churned: 89,
  };

  const demoCampaignHealth: CampaignHealthRow[] = campaigns
    .filter((c) => c.status === "live" || c.status === "paused")
    .map((c) => ({
      proposalId: c.id,
      name: c.name,
      daysRunning: c.launchedAt
        ? Math.floor(
            (new Date("2026-05-18").getTime() - new Date(c.launchedAt).getTime()) /
              (24 * 60 * 60 * 1000),
          )
        : 0,
      cohortSize: c.audienceSize,
      variantCount: 2,
    }));

  // ── Section 4: Forecast ───────────────────────────────────────────────────

  const forecast: ForecastStats = {
    projectedNextMonthCents: Math.round(attribution.incrementalRevenue * 1.12) * 100,
    hasData: true,
  };

  return (
    <DemoShell>
      {/* Section 1 — Headline outcome */}
      <DashboardHeadline
        stats={headlineStats}
        period="30"
        byDay={byDay}
      />

      {/* Section 2 — Active state */}
      <DashboardLifecycle
        lifecycleCounts={lifecycleCounts}
        campaigns={demoCampaignHealth}
      />

      {/* Section 3 — Recommended actions (demo mode — no API calls) */}
      <DashboardRecommendedActions demoInsights={insights} />

      {/* Section 4 — Forecast */}
      <DashboardForecast
        forecast={forecast}
        lapsedCount={merchant.totalLapsedCount}
        hasScored={true}
      />
    </DemoShell>
  );
}
