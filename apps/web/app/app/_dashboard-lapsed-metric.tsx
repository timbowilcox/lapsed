import "server-only";

import { MetricCard, formatCount } from "@lapsed/ui";
import { createServiceClient, getMerchantSummary, getReadyToReactivateCount } from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";

export async function DashboardLapsedMetric({ merchantId }: { merchantId: string }) {
  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const [summary, readyCount] = await Promise.all([
    getMerchantSummary(serviceClient, merchantId),
    getReadyToReactivateCount(serviceClient, merchantId, env.propensityReadyThreshold),
  ]);

  const trendText =
    readyCount > 0
      ? `${formatCount(readyCount)} ready to reactivate`
      : "No scored customers yet";

  return (
    <MetricCard
      label="Lapsed group"
      value={formatCount(summary.total_lapsed_count)}
      trend={trendText}
      trendDirection={readyCount > 0 ? "up" : "flat"}
    />
  );
}

export function DashboardLapsedMetricSkeleton() {
  return (
    <div className="animate-pulse rounded-md border border-border bg-cream-50 p-20">
      <div className="mb-12 h-10 w-24 rounded bg-ink-100" />
      <div className="mb-8 h-24 w-20 rounded bg-ink-100" />
      <div className="h-10 w-32 rounded bg-ink-100" />
    </div>
  );
}
