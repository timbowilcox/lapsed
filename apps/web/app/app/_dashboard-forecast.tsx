// Dashboard Section 4 — Forecast (chunk 10).
//
// Projected restored revenue for the next 30 days (carried forward from the
// current-period trend), plus customer readiness milestone.
//
// The projection is a conservative carry-forward — not a model — and is
// labelled clearly as "projected" per design tenet 4 (honest numbers).
// "Restored revenue" is reserved for holdout-validated figures (Sprint 08).
//
// Server component — receives pre-computed stats as props.

import Link from "next/link";
import { formatCurrency } from "@lapsed/ui";
import type { ForecastStats } from "./_dashboard-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Methodology tooltip (duplicated inline — forecast has its own phrasing)
// ─────────────────────────────────────────────────────────────────────────────

function ForecastTooltip() {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="How is the forecast calculated?"
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
        This projection carries the current 30-day incremental revenue forward without adjustment. It is not a statistical model or guarantee. Actual results depend on campaign send volume, customer group response rates, and attribution window timing.
        <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-ink-900" />
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Props & component
// ─────────────────────────────────────────────────────────────────────────────

interface DashboardForecastProps {
  forecast: ForecastStats;
  /** Total lapsed customers ready for campaigns (from getReadyToReactivateCount). */
  lapsedCount: number;
  /** Whether nightly scoring has run at least once. */
  hasScored: boolean;
}

export function DashboardForecast({ forecast, lapsedCount, hasScored }: DashboardForecastProps) {
  const showProjection = forecast.hasData && forecast.projectedNextMonthCents !== null;
  const showMilestone = hasScored && lapsedCount > 0;

  if (!showProjection && !showMilestone) {
    return (
      <section aria-label="Forecast" className="mb-32">
        <div className="rounded-lg border border-border bg-cream-50 px-24 py-20">
          <h2 className="mb-8 text-h2 text-ink-900">What&apos;s coming</h2>
          <p className="text-meta text-ink-400">
            Your projected restored revenue appears once your first campaign has been running for at least 14 days.
          </p>
        </div>
      </section>
    );
  }

  const projectedDisplay = showProjection
    ? formatCurrency(forecast.projectedNextMonthCents!)
    : null;

  return (
    <section aria-label="Forecast" className="mb-32">
      <h2 className="mb-16 text-h2 text-ink-900">What&apos;s coming</h2>
      <div className="grid grid-cols-1 gap-12 sm:grid-cols-2">
        {/* Projection card */}
        {showProjection && (
          <div className="rounded-lg border border-border bg-cream-50 px-24 py-20">
            <div className="mb-6 flex items-center gap-6">
              <span className="text-label text-ink-500">Projected next 30 days</span>
              <ForecastTooltip />
            </div>
            <div className="font-serif text-[36px] leading-tight text-ink-900">{projectedDisplay}</div>
            <p className="mt-6 text-mini text-ink-400">
              Carry-forward estimate · not a statistical model
            </p>
          </div>
        )}

        {/* Customer milestone card */}
        {showMilestone && (
          <div className="rounded-lg border border-border bg-cream-50 px-24 py-20">
            <div className="mb-6 text-label text-ink-500">Ready to win back</div>
            <div className="font-serif text-[36px] leading-tight text-ink-900">
              {lapsedCount.toLocaleString("en-US")}
            </div>
            <p className="mt-6 text-mini text-ink-400">
              Customers classified as dormant and ready for outreach.{" "}
              <Link
                href="/app/lapsed"
                className="underline underline-offset-2 hover:text-ink-600 focus-visible:outline-none focus-visible:shadow-focus"
              >
                View all
              </Link>
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
