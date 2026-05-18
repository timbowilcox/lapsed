// Dashboard Section 2 — Active state (chunk 10).
//
// Two subsections:
//   A. Lifecycle pipeline — horizontal stage bars showing customer counts
//      across new → engaged → at-risk → lapsed → won back → churned.
//   B. Campaign health rows — one row per approved campaign with days running,
//      variant count, and status.
//
// Server component — receives pre-computed data as props.

import Link from "next/link";
import { formatCount } from "@lapsed/ui";
import type { LifecycleStageCounts } from "@lapsed/db";
import type { CampaignHealthRow } from "./_dashboard-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle pipeline
// ─────────────────────────────────────────────────────────────────────────────

interface Stage {
  key: keyof LifecycleStageCounts;
  label: string;
  /** Tailwind bg token for the bar fill. */
  barClass: string;
  /** Tailwind text token for the count. */
  countClass: string;
}

const STAGES: Stage[] = [
  { key: "new",      label: "New",        barClass: "bg-lavender-400", countClass: "text-ink-700" },
  { key: "engaged",  label: "Engaged",    barClass: "bg-success-500",  countClass: "text-ink-700" },
  { key: "at_risk",  label: "At-risk",    barClass: "bg-warning-400",  countClass: "text-ink-700" },
  { key: "lapsed",   label: "Lapsed",     barClass: "bg-danger-400",   countClass: "text-ink-700" },
  { key: "won_back", label: "Restored",   barClass: "bg-success-600",  countClass: "text-ink-700" },
  { key: "churned",  label: "Churned",    barClass: "bg-ink-300",      countClass: "text-ink-500" },
];

function LifecyclePipeline({ counts }: { counts: LifecycleStageCounts }) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const hasData = total > 0;
  const max = hasData ? Math.max(...STAGES.map((s) => counts[s.key])) : 1;

  return (
    <div>
      <h3 className="mb-12 text-label font-medium text-ink-700">Customer lifecycle</h3>
      {!hasData ? (
        <p className="text-meta text-ink-400">
          Lifecycle stages appear once the nightly scoring run has classified your customers — typically within 24 hours of installing.
        </p>
      ) : (
        <div className="space-y-8" role="list" aria-label="Customer lifecycle stages">
          {STAGES.map(({ key, label, barClass, countClass }) => {
            const count = counts[key];
            const pct = max > 0 ? Math.round((count / max) * 100) : 0;
            return (
              <div key={key} className="flex items-center gap-12" role="listitem">
                <div className="w-[80px] shrink-0 text-right text-mini text-ink-500">{label}</div>
                <div className="flex flex-1 items-center gap-8">
                  <div
                    className={`h-18 rounded-sm transition-all ${barClass}`}
                    style={{ width: `${pct}%`, minWidth: count > 0 ? "4px" : "0" }}
                    aria-hidden="true"
                  />
                  <span className={`text-mini font-medium tabular-nums ${countClass}`}>
                    {count > 0 ? formatCount(count) : "—"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Campaign health rows
// ─────────────────────────────────────────────────────────────────────────────

function CampaignHealthTable({ campaigns }: { campaigns: CampaignHealthRow[] }) {
  if (campaigns.length === 0) {
    return (
      <p className="text-meta text-ink-400">
        Campaign health rows appear once you approve your first campaign. The agent will propose one once your customers are scored.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-mini" aria-label="Active campaign health">
        <thead>
          <tr className="border-b border-border text-left text-ink-400">
            <th className="pb-8 pr-16 font-medium">Campaign</th>
            <th className="pb-8 pr-16 font-medium tabular-nums">Days running</th>
            <th className="pb-8 font-medium tabular-nums">Variants</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((row) => (
            <tr key={row.proposalId} className="border-b border-border last:border-0">
              <td className="py-10 pr-16 font-medium text-ink-900">{row.name}</td>
              <td className="py-10 pr-16 tabular-nums text-ink-600">
                {row.daysRunning > 0 ? `${row.daysRunning}d` : "Today"}
              </td>
              <td className="py-10 tabular-nums text-ink-600">{row.variantCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface DashboardLifecycleProps {
  lifecycleCounts: LifecycleStageCounts;
  campaigns: CampaignHealthRow[];
}

export function DashboardLifecycle({ lifecycleCounts, campaigns }: DashboardLifecycleProps) {
  return (
    <section aria-label="Active state" className="mb-32">
      <h2 className="mb-16 text-h2 text-ink-900">What&apos;s happening now</h2>
      <div className="grid grid-cols-1 gap-20 lg:grid-cols-[1fr_1.2fr]">
        {/* Lifecycle pipeline */}
        <div className="rounded-lg border border-border bg-cream-50 p-20">
          <LifecyclePipeline counts={lifecycleCounts} />
        </div>

        {/* Campaign health rows */}
        <div className="rounded-lg border border-border bg-cream-50 p-20">
          <div className="mb-12 flex items-center justify-between gap-8">
            <h3 className="text-label font-medium text-ink-700">Active campaigns</h3>
            <Link
              href="/app/campaigns"
              className="text-mini text-ink-400 underline underline-offset-2 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
            >
              View all
            </Link>
          </div>
          <CampaignHealthTable campaigns={campaigns} />
        </div>
      </div>
    </section>
  );
}
