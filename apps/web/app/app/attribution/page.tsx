// Merchant attribution rollup (Sprint 08, chunk 11). Replaces the Sprint-01
// fixture-backed page with the real cron-materialised numbers.
//
// SPRINT.md chunk 11 names the path `dashboard/attribution/page.tsx`; the live
// merchant-facing route (and the sidebar link) is `/app/attribution`, so the
// rollup replaces this existing page in place rather than spawning an orphan
// route — see HANDOFF deliberate deviations.
//
// Leads with one number — revenue restored — over a 30d / 90d / all-time
// period selector. Incremental, holdout-validated figures only; the per-campaign
// page carries the confidence intervals.

import Link from "next/link";
import {
  Card,
  HeroMetric,
  Panel,
  PanelHeader,
  PanelBody,
  RevenueChart,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Tag,
  EmptyState,
  formatCurrency,
  formatCount,
  formatDate,
} from "@lapsed/ui";
import {
  mintMerchantJwt,
  createMerchantClient,
  getMerchantAttributionRollup,
  type MerchantAttributionCampaign,
} from "@lapsed/db";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../_components/merchant-shell";
import { groupLabel } from "../campaigns/_labels";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

type Period = "30d" | "90d" | "all";
const PERIODS: { id: Period; label: string; days: number | null }[] = [
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
  { id: "all", label: "All time", days: null },
];
const DAY_MS = 86_400_000;

function resolvePeriod(raw: string | string[] | undefined): Period {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "90d" || v === "all" ? v : "30d";
}

export default async function AttributionRollupPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const period = resolvePeriod(sp.period);

  const merchant = await requireMerchant({ searchParams: sp });
  const env = serverEnv();
  const jwt = await mintMerchantJwt({
    shopDomain: merchant.shopDomain,
    jwtSecret: env.supabaseJwtSecret,
  });
  const client = createMerchantClient({
    url: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    merchantJwt: jwt,
  });

  const rollup = await getMerchantAttributionRollup(client, merchant.id);

  // Period filter — windowCloseDate is YYYY-MM-DD; string compare is sound.
  const periodDef = PERIODS.find((p) => p.id === period)!;
  const cutoff =
    periodDef.days === null
      ? null
      : new Date(Date.now() - periodDef.days * DAY_MS).toISOString().slice(0, 10);
  const inPeriod = rollup.campaigns.filter(
    (c) => cutoff === null || c.windowCloseDate >= cutoff,
  );

  const revenueRestoredCents = inPeriod.reduce((s, c) => s + c.incrementalRevenueCents, 0);
  const ltvRestoredCents = inPeriod.reduce((s, c) => s + c.ltvRestoredCents, 0);

  const topCampaigns = [...inPeriod]
    .sort((a, b) => b.incrementalRevenueCents - a.incrementalRevenueCents)
    .slice(0, 5);

  const holdout = holdoutEffectiveness(inPeriod, env.holdoutRate);
  const weekly = weeklySeries(rollup.campaigns);

  return (
    <MerchantShell pageTitle="Attribution">
      <div className="mb-24">
        <h1 className="mb-4 text-h1 text-ink-900">Revenue restored</h1>
        <p className="text-meta text-ink-500">
          Incremental revenue from campaign-driven conversations, measured against each
          campaign&rsquo;s matched comparison group and reconciled against Shopify orders.
        </p>
      </div>

      {rollup.campaigns.length === 0 ? (
        <Panel>
          <EmptyState
            heading="No attribution results yet"
            body="Figures appear here once a campaign's attribution window closes and the nightly batch has run. Attribution windows are typically 14 days after a campaign sends."
            secondaryAction={
              <Link
                href="/preview/attribution"
                className="text-meta text-ink-500 underline underline-offset-2 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
              >
                Preview what attribution looks like
              </Link>
            }
          />
        </Panel>
      ) : (
        <>
          {/* Period selector — shown only when attribution data exists.
              A set of navigating links, not an ARIA tablist: each link
              reloads the route with a new ?period; aria-current marks the
              active period without promising tab-widget interaction. */}
          <nav className="mb-16 flex gap-4" aria-label="Reporting period">
            {PERIODS.map((p) => {
              const active = p.id === period;
              return (
                <Link
                  key={p.id}
                  href={`/app/attribution?period=${p.id}`}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-sm px-12 py-6 text-meta transition-colors focus-visible:outline-none focus-visible:shadow-focus ${
                    active
                      ? "bg-lavender-50 text-lavender-700"
                      : "text-ink-500 hover:text-ink-900"
                  }`}
                >
                  {p.label}
                </Link>
              );
            })}
          </nav>
          <HeroMetric
            label={`Revenue restored · ${periodDef.label.toLowerCase()}`}
            value={formatCurrency(revenueRestoredCents)}
            meta={
              <>
                across {formatCount(inPeriod.length)}{" "}
                {inPeriod.length === 1 ? "campaign" : "campaigns"}
              </>
            }
            className="mb-12"
          />

          {/* LTV restored — the second headline measure (decision 23). Shown
              as a card, not a co-equal hero, to keep one number first
              (tenet 6 — progressive disclosure). */}
          <div className="mb-16 grid grid-cols-2 gap-12">
            <Card className="p-20">
              <div className="text-label text-ink-500">
                LTV restored · {periodDef.label.toLowerCase()}
              </div>
              <div className="mt-8 text-display text-ink-900 tabular-nums">
                {formatCurrency(ltvRestoredCents)}
              </div>
            </Card>
            <Card className="p-20">
              <div className="text-label text-ink-500">Campaigns measured</div>
              <div className="mt-8 text-display text-ink-900 tabular-nums">
                {formatCount(inPeriod.length)}
              </div>
            </Card>
          </div>

          <Panel className="mb-16">
            <PanelHeader title="Top campaigns by incremental revenue" />
            <PanelBody>
              {topCampaigns.length === 0 ? (
                <p className="px-16 py-32 text-center text-meta text-ink-500">
                  No campaigns in this period.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign</TableHead>
                      <TableHead>Window closed</TableHead>
                      <TableHead className="text-right">Incremental revenue</TableHead>
                      <TableHead className="text-right">LTV restored</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {topCampaigns.map((c) => (
                      <TableRow key={`${c.campaignId}-${c.windowCloseDate}`}>
                        <TableCell>
                          <Link
                            href={`/app/campaigns/${c.campaignId}/attribution`}
                            className="text-ink-900 transition-colors hover:text-lavender-700 focus-visible:outline-none focus-visible:shadow-focus"
                          >
                            {groupLabel(c.groupSlug)}
                          </Link>
                          {c.insufficientEvidence && (
                            <span className="ml-8">
                              <Tag tone="stalled">Insufficient evidence</Tag>
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-ink-500">
                          {formatDate(c.windowCloseDate, "short")}
                        </TableCell>
                        <TableCell className="text-right text-ink-900 tabular-nums">
                          {formatCurrency(c.incrementalRevenueCents)}
                        </TableCell>
                        <TableCell className="text-right text-ink-900 tabular-nums">
                          {formatCurrency(c.ltvRestoredCents)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </PanelBody>
          </Panel>

          <div className="mb-16 grid grid-cols-[2fr_1fr] gap-16">
            <Panel>
              <PanelHeader title="Revenue restored — last 12 weeks" />
              <PanelBody>
                <div className="p-24">
                  <RevenueChart data={weekly} />
                </div>
              </PanelBody>
            </Panel>
            <HoldoutCheck holdout={holdout} />
          </div>
        </>
      )}
    </MerchantShell>
  );
}

interface HoldoutStat {
  realisedRate: number;
  configuredRate: number;
  skewed: boolean;
  campaignCount: number;
}

/**
 * Realised holdout rate across the period's campaigns vs the configured rate.
 * A divergence over 10% (relative) suggests holdout assignment may be skewed.
 */
function holdoutEffectiveness(
  campaigns: MerchantAttributionCampaign[],
  configuredRate: number,
): HoldoutStat {
  const rates = campaigns
    .map((c) => {
      const total = c.treatmentCohortSize + c.holdoutCohortSize;
      return total > 0 ? c.holdoutCohortSize / total : null;
    })
    .filter((r): r is number => r !== null);
  const realisedRate =
    rates.length > 0 ? rates.reduce((s, r) => s + r, 0) / rates.length : configuredRate;
  const skewed =
    configuredRate > 0 &&
    Math.abs(realisedRate - configuredRate) / configuredRate > 0.1;
  return { realisedRate, configuredRate, skewed, campaignCount: rates.length };
}

function HoldoutCheck({ holdout }: { holdout: HoldoutStat }) {
  const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
  return (
    <Card className="p-24">
      <div className="text-label text-ink-500">Measurement check</div>
      <div className="mt-8 text-display text-ink-900 tabular-nums">
        {pct(holdout.realisedRate)}
      </div>
      <div className="mt-4 text-mini text-ink-500">
        observed across {formatCount(holdout.campaignCount)}{" "}
        {holdout.campaignCount === 1 ? "campaign" : "campaigns"} · target{" "}
        {pct(holdout.configuredRate)}
      </div>
      {holdout.skewed && (
        <p className="mt-12 text-mini text-ink-700">
          The observed comparison-group assignment diverges from the target by more than 10%.
          Worth reviewing to ensure measurement accuracy.
        </p>
      )}
    </Card>
  );
}

/**
 * Buckets incremental revenue into the last 12 rolling 7-day weeks (anchored at
 * now) by window-close date. RevenueChart expects `value` in DOLLARS — its
 * tooltip does formatCurrency(value × 100) — so the cent totals are divided by
 * 100 here. Returns oldest-first.
 */
function weeklySeries(
  campaigns: MerchantAttributionCampaign[],
): Array<{ date: string; value: number }> {
  const WEEKS = 12;
  const now = Date.now();
  const buckets = new Array<number>(WEEKS).fill(0);
  for (const c of campaigns) {
    const closedMs = new Date(c.windowCloseDate).getTime();
    if (!Number.isFinite(closedMs)) continue;
    const weeksAgo = Math.floor((now - closedMs) / (7 * DAY_MS));
    if (weeksAgo < 0 || weeksAgo >= WEEKS) continue;
    buckets[WEEKS - 1 - weeksAgo]! += c.incrementalRevenueCents;
  }
  return buckets.map((cents, i) => {
    const weekStartMs = now - (WEEKS - 1 - i) * 7 * DAY_MS;
    // RevenueChart's value unit is dollars (it renders formatCurrency(v × 100)).
    return { date: new Date(weekStartMs).toISOString().slice(0, 10), value: cents / 100 };
  });
}
