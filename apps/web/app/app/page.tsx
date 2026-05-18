import { Suspense } from "react";
import {
  HeroMetric,
  MetricCard,
  Panel,
  PanelHeader,
  PanelBody,
  EmptyState,
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
            <EmptyState
              heading="No campaigns yet"
              body="Your first campaign appears here once the agent prepares one for your approval. The agent analyses your scored customer groups and proposes campaigns — nothing is sent until you approve it."
              secondaryAction={
                <Link
                  href="/preview/campaigns"
                  className="text-meta text-ink-500 underline underline-offset-2 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
                >
                  Preview what campaigns look like
                </Link>
              }
            />
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
            <EmptyState
              heading="No conversations yet"
              body="Threads appear here once an approved campaign sends its first message. Each thread is a two-way conversation between your customers and your agent."
              secondaryAction={
                <Link
                  href="/preview/conversations"
                  className="text-meta text-ink-500 underline underline-offset-2 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
                >
                  Preview sample conversations
                </Link>
              }
            />
          </PanelBody>
        </Panel>
      </section>
    </MerchantShell>
  );
}
