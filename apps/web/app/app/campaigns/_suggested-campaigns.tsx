"use client";

// Suggested campaigns surface — Sprint 11, chunk 9.
//
// Fetches active cohort-category insights from /api/insights and renders them
// as "suggested campaign" cards above the approval queue. Each card surfaces:
//   - Group name and customer count from the signal data
//   - Merchant-facing reason copy (insight.merchantCopy)
//   - Expected win-back range (static pattern estimate, not a forecast)
//   - "Why suggested" tooltip with the signal context
//   - "Spin up" CTA → /app/campaigns/new pre-filled with the cohort
//   - "Dismiss" to suppress the card for this evaluation cycle
//
// Demo mode: accepts an optional `demoInsights` prop; when provided, skips
// the API fetch and renders from fixture data. No demo data ever bleeds into
// the live path — the prop is only set from the /preview route.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Tag } from "@lapsed/ui";
import { groupLabel } from "./_labels";
import type { DemoInsight } from "@lapsed/core/demo-fixtures";

// Subset of InsightRow used by this component — avoids importing the full
// @lapsed/core bundle into a client component.
interface SuggestionInsight {
  id: string;
  insightKey: string;
  category: string;
  signalValue: number;
  merchantCopy: string;
  ctaAction: { route: string; params?: Record<string, string> };
  priority: "HIGH" | "MEDIUM" | "LOW";
}

// ─────────────────────────────────────────────────────────────────────────────
// Static pattern metadata per insight key prefix
// ─────────────────────────────────────────────────────────────────────────────

interface PatternMeta {
  label: string;
  pattern: string;
  winBackRange: string;
}

const COHORT_PATTERNS: Record<string, PatternMeta> = {
  "cohort:lapsed_vip_dormancy": { // vocab:allow — internal insight key, not user-facing copy
    label: "VIP Recovery",
    pattern: "Exclusive early access + percentage discount",
    winBackRange: "10–15% typically respond",
  },
  "cohort:at_risk_regulars_dormancy": { // vocab:allow — internal insight key, not user-facing copy
    label: "At-risk re-engagement",
    pattern: "Loyalty reward + personal re-engagement message",
    winBackRange: "8–12% typically respond",
  },
};

const DEFAULT_PATTERN: PatternMeta = {
  label: "Win-back",
  pattern: "Personalised discount offer",
  winBackRange: "8–14% typically respond",
};

function getPatternMeta(insightKey: string): PatternMeta {
  return COHORT_PATTERNS[insightKey] ?? DEFAULT_PATTERN;
}

function getGroupSlug(insight: SuggestionInsight): string | null {
  return insight.ctaAction.params?.groupSlug ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tooltip — lightweight, no Radix dep. Accessible via focus-within.
// ─────────────────────────────────────────────────────────────────────────────

function WhySuggestedTooltip({ copy }: { copy: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="Why is this suggested?"
        className="inline-flex h-18 w-18 items-center justify-center rounded-full text-ink-400 transition-colors hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
      >
        {/* Inline SVG info icon — avoids Icon component's size constraints */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M8 7v5M8 5.5v-.01"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-8 w-[260px] -translate-x-1/2 rounded-md bg-ink-900 px-12 py-8 text-mini leading-relaxed text-cream-50 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {copy}
        {/* Arrow */}
        <span className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-ink-900" />
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Suggestion card
// ─────────────────────────────────────────────────────────────────────────────

function SuggestionCard({
  insight,
  onSpinUp,
  onDismiss,
  dismissing,
}: {
  insight: SuggestionInsight;
  onSpinUp: (insight: SuggestionInsight) => void;
  onDismiss: (insight: SuggestionInsight) => void;
  dismissing: boolean;
}) {
  const groupSlug = getGroupSlug(insight);
  const displayName = groupSlug ? groupLabel(groupSlug) : insight.insightKey;
  const meta = getPatternMeta(insight.insightKey);
  const customerCount = Math.round(insight.signalValue);

  return (
    <Card className="flex flex-col gap-12 p-20">
      {/* Header row */}
      <div className="flex items-start justify-between gap-12">
        <div className="flex items-center gap-8">
          <Tag tone={insight.priority === "HIGH" ? "active" : "stalled"}>
            {insight.priority === "HIGH" ? "High priority" : "Medium priority"}
          </Tag>
          <WhySuggestedTooltip copy={insight.merchantCopy} />
        </div>
        <button
          type="button"
          onClick={() => onDismiss(insight)}
          disabled={dismissing}
          aria-label="Dismiss this suggestion"
          className="text-mini text-ink-400 underline underline-offset-2 transition-colors hover:text-ink-600 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>

      {/* Group info */}
      <div>
        <div className="text-h3 text-ink-900">{displayName}</div>
        <div className="mt-2 text-meta text-ink-500">
          {customerCount.toLocaleString()} customers ready to re-engage
        </div>
      </div>

      {/* Pattern row */}
      <div className="rounded-sm bg-cream-100 px-12 py-10">
        <div className="text-label text-ink-700">{meta.label}</div>
        <div className="mt-2 text-meta text-ink-500">{meta.pattern}</div>
        <div className="mt-4 text-mini text-ink-400">{meta.winBackRange}</div>
      </div>

      {/* CTA */}
      <div className="mt-auto">
        <Button
          className="w-full"
          onClick={() => onSpinUp(insight)}
          disabled={dismissing}
        >
          Spin up this campaign
        </Button>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  /** Injected from the /preview route for demo mode. When set, skips the API fetch. */
  demoInsights?: DemoInsight[];
}

export function SuggestedCampaigns({ demoInsights }: Props) {
  const router = useRouter();
  const mountedRef = useRef(true);
  const [insights, setInsights] = useState<SuggestionInsight[]>([]);
  const [loading, setLoading] = useState(!demoInsights);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    if (demoInsights) {
      // Demo mode — use fixture data directly, no API fetch.
      setInsights(demoInsights.filter((i) => i.category === "cohort").slice(0, 4));
      return;
    }
    void (async () => {
      try {
        const res = await fetch("/api/insights", { cache: "no-store" });
        if (!mountedRef.current) return;
        if (!res.ok) return; // silent — suggestions are non-critical
        const body = (await res.json()) as { insights: SuggestionInsight[] };
        if (!mountedRef.current) return;
        const cohortInsights = body.insights.filter((i) => i.category === "cohort").slice(0, 4);
        setInsights(cohortInsights);
      } catch {
        // non-critical — page still works without suggestions
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, [demoInsights]);

  // Spin up → open the campaign wizard with this cohort pre-selected. The
  // merchant reviews the offer and the generated messages before anything is
  // created; no proposal exists until they complete the wizard.
  const handleSpinUp = useCallback(
    (insight: SuggestionInsight) => {
      const groupSlug = getGroupSlug(insight);
      if (!groupSlug) return;
      router.push(`/app/campaigns/new?groupSlug=${encodeURIComponent(groupSlug)}`);
    },
    [router],
  );

  const handleDismiss = useCallback(
    async (insight: SuggestionInsight) => {
      if (demoInsights) {
        // Demo mode — just remove from local state.
        setInsights((prev) => prev.filter((i) => i.id !== insight.id));
        return;
      }
      setDismissingId(insight.id);
      try {
        await fetch(`/api/insights/${insight.id}?action=dismiss`, { method: "POST" });
        if (!mountedRef.current) return;
        setInsights((prev) => prev.filter((i) => i.id !== insight.id));
      } catch {
        // non-critical — optimistically remove
        if (mountedRef.current) setInsights((prev) => prev.filter((i) => i.id !== insight.id));
      } finally {
        if (mountedRef.current) setDismissingId(null);
      }
    },
    [demoInsights],
  );

  // Skeleton while loading
  if (loading) {
    return (
      <section aria-label="Suggested campaigns" className="mb-32">
        <h2 className="mb-16 text-h2 text-ink-900">Suggested for you</h2>
        <div className="grid grid-cols-1 gap-16 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-[200px] rounded-md bg-cream-200 motion-safe:animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  // Nothing to show — collapse section entirely
  if (insights.length === 0) return null;

  return (
    <section aria-label="Suggested campaigns" className="mb-32">
      <div className="mb-16 flex items-center justify-between">
        <h2 className="text-h2 text-ink-900">Suggested for you</h2>
        <span className="text-meta text-ink-500">Based on your current customer data</span>
      </div>

      <div className="grid grid-cols-1 gap-16 md:grid-cols-2">
        {insights.map((insight) => (
          <SuggestionCard
            key={insight.id}
            insight={insight}
            onSpinUp={handleSpinUp}
            onDismiss={(i) => void handleDismiss(i)}
            dismissing={dismissingId === insight.id}
          />
        ))}
      </div>
    </section>
  );
}
