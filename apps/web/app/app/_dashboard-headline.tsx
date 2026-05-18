// Dashboard Section 1 — Headline outcome (chunk 10).
//
// Restored revenue with: counterfactual line, 95% CI, comparison toggle
// (30 / 90 / Lifetime), methodology tooltip, and sparkline chart.
//
// Server component — receives pre-computed stats and chart data as props.
// Period toggle navigates via URL search param (?period=30|90|all) so the
// parent server page can re-fetch the filtered rollup server-side.

import Link from "next/link";
import { HeroMetric, EmptyState, RevenueChart } from "@lapsed/ui";
import type { DashboardPeriod, AttributionPeriodStats } from "./_dashboard-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Methodology tooltip
// ─────────────────────────────────────────────────────────────────────────────

function MethodologyTooltip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="How is this calculated?"
        className="inline-flex h-16 w-16 items-center justify-center rounded-full text-ink-400 transition-colors hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 7v5M8 5.5v-.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-8 w-[280px] -translate-x-1/2 rounded-md bg-ink-900 px-12 py-8 text-mini leading-relaxed text-cream-50 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
        <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-ink-900" />
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Period toggle
// ─────────────────────────────────────────────────────────────────────────────

function PeriodToggle({ current }: { current: DashboardPeriod }) {
  const options: Array<{ value: DashboardPeriod; label: string }> = [
    { value: "30", label: "Last 30 days" },
    { value: "90", label: "Last 90 days" },
    { value: "all", label: "Lifetime" },
  ];
  return (
    <nav aria-label="Reporting period" className="flex gap-2">
      {options.map(({ value, label }) => (
        <Link
          key={value}
          href={`?period=${value}`}
          aria-current={current === value ? "page" : undefined}
          className={[
            "rounded-md px-10 py-5 text-mini font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus",
            current === value
              ? "bg-ink-900 text-cream-50"
              : "text-ink-500 hover:bg-cream-200 hover:text-ink-900",
          ].join(" ")}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Props & component
// ─────────────────────────────────────────────────────────────────────────────

interface DashboardHeadlineProps {
  stats: AttributionPeriodStats;
  period: DashboardPeriod;
  /** Per-day chart data (date ISO string, value in dollars). */
  byDay: Array<{ date: string; value: number }>;
}

const METHODOLOGY_TEXT =
  "Incremental revenue uses a 10% comparison group per campaign. " +
  "Restored revenue = campaign group revenue − comparison group expected baseline, reconciled against Shopify orders within the attribution window. " +
  "The 95% CI is derived from a two-sample statistical comparison across campaign and comparison groups.";

export function DashboardHeadline({ stats, period, byDay }: DashboardHeadlineProps) {
  if (!stats.hasData) {
    return (
      <section aria-label="Restored revenue" className="mb-32">
        <div className="rounded-lg border border-border bg-cream-50 px-32 py-28">
          <div className="mb-4 text-label text-ink-500">Restored revenue</div>
          <EmptyState
            heading="No attribution results yet"
            body="Your first restored revenue figure appears once a campaign's attribution window closes — typically 14 days after launch. The comparison group analysis runs nightly."
            secondaryAction={
              <Link
                href="/preview"
                className="text-meta text-ink-500 underline underline-offset-2 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
              >
                Preview what this looks like
              </Link>
            }
          />
        </div>
      </section>
    );
  }

  const incrementalDollars = Math.round(stats.totalIncrementalCents / 100);
  const ciLowDollars = stats.ciLowCents !== null ? Math.round(stats.ciLowCents / 100) : null;
  const ciHighDollars = stats.ciHighCents !== null ? Math.round(stats.ciHighCents / 100) : null;
  const hasCi = ciLowDollars !== null && ciHighDollars !== null;

  const vsText =
    stats.vsPreviousPeriodPct !== null
      ? stats.vsPreviousPeriodPct >= 0
        ? `↑ ${stats.vsPreviousPeriodPct}% vs previous period`
        : `↓ ${Math.abs(stats.vsPreviousPeriodPct)}% vs previous period`
      : null;

  return (
    <section aria-label="Restored revenue" className="mb-32">
      <div className="mb-12 flex items-center justify-between gap-12">
        <div className="flex items-center gap-6">
          <h2 className="text-label text-ink-500">Restored revenue</h2>
          <MethodologyTooltip text={METHODOLOGY_TEXT} />
        </div>
        <PeriodToggle current={period} />
      </div>

      <HeroMetric
        pulse
        label={
          period === "30"
            ? "Incremental revenue restored · last 30 days"
            : period === "90"
              ? "Incremental revenue restored · last 90 days"
              : "Incremental revenue restored · lifetime"
        }
        currency="$"
        value={incrementalDollars.toLocaleString("en-US")}
        meta={
          <span className="flex flex-wrap items-center gap-x-12 gap-y-4">
            <span>
              Revenue your customers would not have spent without lapsed.ai{" "}
              <span className="text-ink-400">(comparison group adjusted)</span>
            </span>
            {hasCi && (
              <span className="text-ink-400">
                95% CI: ${ciLowDollars!.toLocaleString("en-US")}–${ciHighDollars!.toLocaleString("en-US")}
              </span>
            )}
            {vsText && (
              <span
                className={
                  stats.vsPreviousPeriodPct! >= 0
                    ? "font-medium text-success-600"
                    : "font-medium text-danger-600"
                }
              >
                {vsText}
              </span>
            )}
          </span>
        }
        chart={
          byDay.length > 0 ? (
            <RevenueChart
              data={byDay}
              range="auto"
              height={88}
            />
          ) : undefined
        }
      />
    </section>
  );
}
