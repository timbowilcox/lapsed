import {
  HeroMetric,
  MetricCard,
  Panel,
  PanelHeader,
  PanelBody,
  CampaignRow,
  ConversationRow,
} from "@lapsed/ui";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { MerchantShell } from "./_components/merchant-shell";
import { HeroChart } from "./_components/hero-chart";
import { campaigns, conversations, attribution, merchant } from "@lapsed/fixtures";
import { requireMerchant } from "@/app/lib/session";

export const dynamic = "force-dynamic";

type RawSearchParams = Record<string, string | string[] | undefined>;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireMerchant({ searchParams: await searchParams });
  const totalRevenue = attribution.totalRecoveredRevenue.toLocaleString();
  const totalOrders = attribution.totalRecoveredOrders;
  const liveCampaigns = campaigns.filter((c) => c.status === "live").length;
  const pausedCampaigns = campaigns.filter((c) => c.status === "paused").length;
  const activeCampaigns = liveCampaigns + pausedCampaigns;
  const visibleCampaigns = campaigns.slice(0, 4);
  const visibleConversations = conversations.slice(0, 4);

  return (
    <MerchantShell pageTitle="Dashboard">
      <HeroMetric
        label="Recovered revenue · last 30 days"
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
        chart={<HeroChart />}
        className="mb-16"
      />

      <section className="mb-32 grid grid-cols-3 gap-12">
        <MetricCard
          label="Active campaigns"
          value={activeCampaigns.toString()}
          trend={`${liveCampaigns} live · ${pausedCampaigns} paused`}
          trendDirection="flat"
        />
        <MetricCard
          label="Lapsed cohort"
          value={merchant.totalLapsedCount.toLocaleString()}
          trend={`↑ ${merchant.weeklyLapsedDelta} this week`}
          trendDirection="up"
        />
        <MetricCard
          label="Reactivation rate"
          value={`${merchant.reactivationRate.toFixed(1)}%`}
          trend={`↑ ${merchant.reactivationRateDeltaPp}pp vs avg`}
          trendDirection="up"
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
              <Link
                href="/app/conversations"
                className="inline-flex items-center gap-4 text-meta font-medium text-ink-500 hover:text-ink-900"
              >
                View all <ArrowRight strokeWidth={1.75} size={14} />
              </Link>
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
