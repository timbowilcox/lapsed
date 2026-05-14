import { Suspense } from "react";
import {
  HeroMetric,
  MetricCard,
  Panel,
  PanelHeader,
  PanelBody,
  CampaignRow,
  ConversationRow,
  RevenueChart,
  formatCount,
} from "@lapsed/ui";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { MerchantShell } from "./_components/merchant-shell";
import { campaigns, conversations, attribution } from "@lapsed/fixtures";
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

  const totalRevenue = formatCount(attribution.totalRecoveredRevenue);
  const totalOrders = attribution.totalRecoveredOrders;
  const liveCampaigns = campaigns.filter((c) => c.status === "live").length;
  const pausedCampaigns = campaigns.filter((c) => c.status === "paused").length;
  const activeCampaigns = liveCampaigns + pausedCampaigns;
  const visibleCampaigns = campaigns.slice(0, 4);
  const visibleConversations = conversations.slice(0, 4);

  return (
    <MerchantShell pageTitle="Dashboard">
      <HeroMetric
        label="Recovered revenue · last 30 days [demo data]"
        pulse
        currency="$"
        value={totalRevenue}
        meta={
          <>
            <span className="font-medium text-success-500">
              ↑ {attribution.vsPreviousPeriodPct}%
            </span>{" "}
            vs previous period · {totalOrders} orders
          </>
        }
        chart={
          <RevenueChart
            data={attribution.byDay.map((d) => ({ date: d.date, value: d.recoveredRevenue }))}
            range="compact"
            height={80}
          />
        }
        className="mb-16"
      />

      <section className="mb-32 grid grid-cols-3 gap-12">
        <MetricCard
          label="Active campaigns"
          value={activeCampaigns.toString()}
          trend={`${liveCampaigns} live · ${pausedCampaigns} paused [demo data]`}
          trendDirection="flat"
        />
        <Suspense fallback={<DashboardLapsedMetricSkeleton />}>
          <DashboardLapsedMetric merchantId={merchant.id} />
        </Suspense>
        <MetricCard
          label="Reactivation rate"
          value="—"
          trend="Attribution in Sprint 08"
          trendDirection="flat"
        />
      </section>

      <section className="grid grid-cols-[1.4fr_1fr] gap-16">
        <Panel>
          <PanelHeader
            title="Campaigns"
            action={
              <div className="flex items-center gap-12">
                <span className="text-mini text-ink-400">[demo data]</span>
                <Link
                  href="/app/campaigns"
                  className="inline-flex items-center gap-4 text-meta font-medium text-ink-500 hover:text-ink-900"
                >
                  View all <ArrowRight strokeWidth={1.75} size={14} />
                </Link>
              </div>
            }
          />
          <PanelBody>
            {visibleCampaigns.map((c) => (
              <Link key={c.id} href={`/app/campaigns/${c.id}`} className="block">
                <CampaignRow
                  name={c.name}
                  meta={c.meta}
                  status={c.status}
                  statusLabel={c.statusLabel}
                  revenue={c.recoveredRevenueDisplay}
                  revenueLabel={c.status === "draft" ? "pending" : "recovered"}
                />
              </Link>
            ))}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Active conversations"
            action={
              <div className="flex items-center gap-12">
                <span className="text-mini text-ink-400">[demo data]</span>
                <Link
                  href="/app/conversations"
                  className="inline-flex items-center gap-4 text-meta font-medium text-ink-500 hover:text-ink-900"
                >
                  View all <ArrowRight strokeWidth={1.75} size={14} />
                </Link>
              </div>
            }
          />
          <PanelBody>
            {visibleConversations.map((c) => {
              const [first, ...rest] = c.customerName.split(" ");
              const last = rest.at(-1) ?? "";
              const display = last ? `${first} ${last.charAt(0)}.` : first ?? c.customerName;
              return (
                <Link key={c.id} href={`/app/conversations/${c.id}`} className="block">
                  <ConversationRow
                    initials={c.initials}
                    name={display}
                    time={c.time}
                    preview={c.preview}
                    tagTone={c.tagTone}
                    tagLabel={c.tagLabel}
                  />
                </Link>
              );
            })}
          </PanelBody>
        </Panel>
      </section>
    </MerchantShell>
  );
}
