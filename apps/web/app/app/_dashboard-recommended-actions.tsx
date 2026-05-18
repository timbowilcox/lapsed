"use client";

// Dashboard Section 3 — Recommended actions (chunk 10).
//
// Renders the top 5 active insights from the insights engine as merchant-
// facing cards with dismiss and snooze CTAs. Initial data is passed from the
// server component to avoid a second fetch on mount (SSR-hydration pattern).
//
// Demo mode: accepts demoInsights prop; when provided, skips the API fetch.

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { Tag } from "@lapsed/ui";
import type { InsightRow } from "@lapsed/db";
import type { DemoInsight } from "@lapsed/core/demo-fixtures";

// Shared subset between InsightRow and DemoInsight
interface ActionInsight {
  id: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  category: string;
  merchantCopy: string;
  ctaAction: { route: string; params?: Record<string, string> };
}

function toActionInsight(row: InsightRow | DemoInsight): ActionInsight {
  return {
    id: row.id,
    priority: row.priority,
    category: row.category,
    merchantCopy: row.merchantCopy,
    ctaAction: row.ctaAction,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Category labels — merchant-facing only (no internal terms)
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_LABEL: Record<string, string> = {
  cohort:       "Customer groups",
  arm:          "Campaign performance",
  opt_out:      "Opt-out signal",
  conversation: "Conversation health",
  payment:      "Account",
};

function categoryLabel(cat: string): string {
  return CATEGORY_LABEL[cat] ?? cat;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual action card
// ─────────────────────────────────────────────────────────────────────────────

function ActionCard({
  insight,
  onDismiss,
  onSnooze,
  dismissing,
  snoozing,
}: {
  insight: ActionInsight;
  onDismiss: (id: string) => void;
  onSnooze: (id: string) => void;
  dismissing: boolean;
  snoozing: boolean;
}) {
  return (
    <div
      className="flex flex-col gap-10 rounded-lg border border-border bg-cream-50 p-16"
      role="article"
      aria-label={`Recommended action: ${insight.merchantCopy}`}
    >
      {/* Header row */}
      <div className="flex items-center gap-8">
        <Tag tone={insight.priority === "HIGH" ? "active" : "stalled"}>
          {categoryLabel(insight.category)}
        </Tag>
        {insight.priority === "HIGH" && (
          <span className="text-mini font-medium text-danger-600">Needs attention</span>
        )}
      </div>

      {/* Copy */}
      <p className="text-meta text-ink-700">{insight.merchantCopy}</p>

      {/* Actions row */}
      <div className="flex items-center justify-between gap-8">
        <Link
          href={insight.ctaAction.route}
          className="inline-flex items-center rounded-md border border-border bg-cream-100 px-12 py-6 text-mini font-medium text-ink-900 transition-colors hover:bg-cream-200 focus-visible:outline-none focus-visible:shadow-focus"
        >
          Take action →
        </Link>
        <div className="flex items-center gap-8">
          <button
            type="button"
            onClick={() => onSnooze(insight.id)}
            disabled={snoozing || dismissing}
            className="text-mini text-ink-400 underline underline-offset-2 transition-colors hover:text-ink-600 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
            aria-label="Snooze this recommendation"
          >
            Snooze 7 days
          </button>
          <span className="text-ink-300" aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => onDismiss(insight.id)}
            disabled={dismissing || snoozing}
            className="text-mini text-ink-400 underline underline-offset-2 transition-colors hover:text-ink-600 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
            aria-label="Dismiss this recommendation"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  /** Server-fetched initial insights (live path). */
  initialInsights?: InsightRow[];
  /** Demo mode — fixture insights; skips API calls. */
  demoInsights?: DemoInsight[];
}

export function DashboardRecommendedActions({ initialInsights, demoInsights }: Props) {
  const isDemo = !!demoInsights;
  const seed: ActionInsight[] = isDemo
    ? demoInsights.slice(0, 5).map(toActionInsight)
    : (initialInsights ?? []).slice(0, 5).map(toActionInsight);

  const mountedRef = useRef(true);
  const [insights, setInsights] = useState<ActionInsight[]>(seed);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [snoozingId, setSnoozingId] = useState<string | null>(null);

  const transition = useCallback(
    async (id: string, action: "dismiss" | "snooze") => {
      const setActive = action === "dismiss" ? setDismissingId : setSnoozingId;
      setActive(id);
      try {
        if (!isDemo) {
          await fetch(`/api/insights/${id}?action=${action}`, { method: "POST" });
        }
        if (mountedRef.current) {
          setInsights((prev) => prev.filter((i) => i.id !== id));
        }
      } catch {
        // non-critical — optimistically remove
        if (mountedRef.current) {
          setInsights((prev) => prev.filter((i) => i.id !== id));
        }
      } finally {
        if (mountedRef.current) setActive(null);
      }
    },
    [isDemo],
  );

  if (insights.length === 0) return null;

  return (
    <section aria-label="Recommended actions" className="mb-32">
      <div className="mb-16 flex items-center justify-between gap-12">
        <h2 className="text-h2 text-ink-900">What needs your attention</h2>
        <span className="text-meta text-ink-400">
          {insights.length} recommendation{insights.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-12 md:grid-cols-2 lg:grid-cols-3">
        {insights.map((insight) => (
          <ActionCard
            key={insight.id}
            insight={insight}
            onDismiss={(id) => void transition(id, "dismiss")}
            onSnooze={(id) => void transition(id, "snooze")}
            dismissing={dismissingId === insight.id}
            snoozing={snoozingId === insight.id}
          />
        ))}
      </div>
    </section>
  );
}
