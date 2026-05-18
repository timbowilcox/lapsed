import { HeroMetric, MetricCard, Panel, PanelHeader, PanelBody, CampaignRow, ConversationRow, RevenueChart, formatCount } from "@lapsed/ui";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { DemoShell } from "./_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";

export default function DemoPage() {
  const { merchant, campaigns, conversations, attribution } = demoFixtures;

  const totalRevenueDisplay = formatCount(attribution.totalRestoredRevenue);
  const liveCampaigns = campaigns.filter((c) => c.status === "live").length;
  const pausedCampaigns = campaigns.filter((c) => c.status === "paused").length;
  const activeCampaigns = liveCampaigns + pausedCampaigns;
  const visibleCampaigns = campaigns.slice(0, 4);
  const visibleConversations = conversations.slice(0, 4);

  return (
    <DemoShell>
      <HeroMetric
        label="Restored revenue · last 30 days"
        pulse
        currency="$"
        value={totalRevenueDisplay}
        meta={
          <>
            <span className="font-medium text-success-500">
              ↑ {attribution.vsPreviousPeriodPct}%
            </span>{" "}
            vs previous period · {attribution.totalRestoredOrders} orders
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
          trend={`${liveCampaigns} live · ${pausedCampaigns} paused`}
          trendDirection="flat"
        />
        <MetricCard
          label="Ready to reactivate"
          value={formatCount(merchant.totalLapsedCount)}
          trend={`↑ ${merchant.weeklyLapsedDelta} this week`}
          trendDirection="up"
        />
        <MetricCard
          label="Reactivation rate"
          value={`${merchant.reactivationRate}%`}
          trend={`↑ ${merchant.reactivationRateDeltaPp}pp vs last month`}
          trendDirection="up"
        />
      </section>

      <section className="grid grid-cols-[1.4fr_1fr] gap-16">
        <Panel>
          <PanelHeader
            title="Campaigns"
            action={
              <Link
                href="/preview/campaigns"
                className="inline-flex items-center gap-4 text-meta font-medium text-ink-500 hover:text-ink-900"
              >
                View all <ArrowRight strokeWidth={1.75} size={14} />
              </Link>
            }
          />
          <PanelBody>
            {visibleCampaigns.map((c) => (
              <Link key={c.id} href="/preview/campaigns" className="block">
                <CampaignRow
                  name={c.name}
                  meta={c.meta}
                  status={c.status === "completed" ? "draft" : c.status}
                  statusLabel={c.statusLabel}
                  revenue={c.recoveredRevenueDisplay}
                  revenueLabel={c.status === "draft" || c.status === "completed" ? "pending" : "restored"}
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
                href="/preview/conversations"
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
              const display = last ? `${first} ${last.charAt(0)}.` : (first ?? c.customerName);
              return (
                <Link key={c.id} href={`/preview/conversations/${c.id}`} className="block">
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
    </DemoShell>
  );
}
