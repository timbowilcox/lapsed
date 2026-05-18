import { Suspense } from "react";
import {
  HeroMetric,
  MetricCard,
  Panel,
  PanelHeader,
  PanelBody,
} from "@lapsed/ui";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { MerchantShell } from "./_components/merchant-shell";
import { requireMerchant } from "@/app/lib/session";
import { DashboardLapsedMetric, DashboardLapsedMetricSkeleton } from "./_dashboard-lapsed-metric";

export const dynamic = "force-dynamic";

type RawSearchParams = Record<string, string | string[] | undefined>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const merchant = await requireMerchant({ searchParams: await searchParams });

  return (
    <MerchantShell pageTitle="Dashboard">
      <HeroMetric
        label="Restored revenue · last 30 days"
        currency="$"
        value="0"
        meta="Figures appear here once a campaign's attribution window closes."
        className="mb-16"
      />

      <section className="mb-32 grid grid-cols-3 gap-12">
        <MetricCard
          label="Active campaigns"
          value="0"
          trend="No active campaigns yet"
          trendDirection="flat"
        />
        <Suspense fallback={<DashboardLapsedMetricSkeleton />}>
          <DashboardLapsedMetric merchantId={merchant.id} />
        </Suspense>
        <MetricCard
          label="Reactivation rate"
          value="—"
          trend="Available after 30 days of campaign activity"
          trendDirection="flat"
        />
      </section>

      <section className="grid grid-cols-[1.4fr_1fr] gap-16">
        <Panel>
          <PanelHeader
            title="Campaigns"
            action={
              <Link
                href="/app/campaigns"
                className="inline-flex items-center gap-4 text-meta font-medium text-ink-500 hover:text-ink-900"
              >
                View all <ArrowRight strokeWidth={1.75} size={14} />
              </Link>
            }
          />
          <PanelBody>
            <div className="flex flex-col items-center gap-8 px-22 py-32 text-center">
              <p className="text-body text-ink-700">No active campaigns yet.</p>
              <p className="text-meta text-ink-500">
                Once the agent prepares a campaign from your scored customer groups, it will appear
                here for your approval.
              </p>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Active conversations"
            action={
              <Link
                href="/app/conversations"
                className="inline-flex items-center gap-4 text-meta font-medium text-ink-500 hover:text-ink-900"
              >
                View all <ArrowRight strokeWidth={1.75} size={14} />
              </Link>
            }
          />
          <PanelBody>
            <div className="flex flex-col items-center gap-8 px-22 py-32 text-center">
              <p className="text-body text-ink-700">No conversations yet.</p>
              <p className="text-meta text-ink-500">
                Threads appear here once an approved campaign sends its first message.
              </p>
            </div>
          </PanelBody>
        </Panel>
      </section>
    </MerchantShell>
  );
}
