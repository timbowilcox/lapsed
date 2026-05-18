import "server-only";

import { MetricCard, formatCount } from "@lapsed/ui";
import { createServiceClient, getMerchantSummary, getReadyToReactivateCount, getLatestScoringRun } from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";

export async function DashboardLapsedMetric({ merchantId }: { merchantId: string }) {
  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const [summary, readyCount, latestRun] = await Promise.all([
    getMerchantSummary(serviceClient, merchantId),
    getReadyToReactivateCount(serviceClient, merchantId, env.propensityReadyThreshold),
    getLatestScoringRun(serviceClient, merchantId),
  ]);

  // Design tenet 4: honest numbers.
  // "—" when scoring has never run (true unknown); show count once data exists.
  const heroValue = latestRun === null ? "—" : formatCount(readyCount);
  const satelliteTrend =
    latestRun === null
      ? "Your first scoring run completes within 24 hours of installing"
      : `${formatCount(summary.total_lapsed_count)} total lapsed`;

  return (
    <MetricCard
      label="Ready to reactivate"
      value={heroValue}
      trend={satelliteTrend}
      trendDirection="flat"
    />
  );
}

export function DashboardLapsedMetricSkeleton() {
  return (
    <div className="motion-safe:animate-pulse rounded-md border border-border bg-cream-50 p-20">
      <div className="mb-12 h-10 w-24 rounded bg-ink-100" />
      <div className="mb-8 h-24 w-20 rounded bg-ink-100" />
      <div className="h-10 w-32 rounded bg-ink-100" />
    </div>
  );
}
