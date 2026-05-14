import "server-only";

import { MetricCard, formatCount } from "@lapsed/ui";
import { createServiceClient, getMerchantSummary } from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";

export async function DashboardLapsedMetric({ merchantId }: { merchantId: string }) {
  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });
  const summary = await getMerchantSummary(serviceClient, merchantId);

  return (
    <MetricCard
      label="Lapsed group"
      value={formatCount(summary.total_lapsed_count)}
      trend="Cadence scoring in Sprint 04"
      trendDirection="flat"
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
