"use client";

// First-run onboarding tour (Sprint 11, Chunk 12).
//
// 5 steps, skippable at any point, persists state via /api/onboarding.
// Fires on first authenticated app load post-install (see page.tsx redirect).
// Step 3 embeds the brand voice extraction flow from _onboarding-voice-step.tsx.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@lapsed/ui";
import {
  Check,
  ArrowRight,
  Users,
  Mic,
  Zap,
  LayoutDashboard,
  Store,
} from "lucide-react";
import { OnboardingVoiceStep } from "./_onboarding-voice-step";

// ─────────────────────────────────────────────────────────────────────────────
// Step definitions
// ─────────────────────────────────────────────────────────────────────────────

interface StepDef {
  key: string;
  title: string;
  body: string;
  icon: React.ComponentType<{ strokeWidth?: number; size?: number }>;
  ctaLabel: string;
  /** Rendered below the body paragraph. Used for voice step embed. */
  embed?: "voice";
}

const STEPS: StepDef[] = [
  {
    key: "welcome",
    title: "Your store is connected",
    body: "lapsed.ai identifies customers who've stopped buying and wins them back through personalised AI conversations. Here's what happens next.",
    icon: Store,
    ctaLabel: "Show me",
  },
  {
    key: "customers",
    title: "Your customers, classified",
    body: "Tonight's scoring run groups your customers by how recently they bought and how likely they are to buy again. Tomorrow morning you'll see them here — grouped by urgency, sorted by win-back potential.",
    icon: Users,
    ctaLabel: "Got it",
  },
  {
    key: "voice",
    title: "Your brand voice",
    body: "The agent writes in your brand's voice, not a generic template. Extract it now (about 60 seconds) or skip — you can always do it from Settings.",
    icon: Mic,
    ctaLabel: "Continue",
    embed: "voice",
  },
  {
    key: "campaign",
    title: "Your first campaign",
    body: "Once your customers are classified, lapsed.ai suggests a win-back campaign targeting your highest-potential group. You review and approve before anything sends — nothing goes out automatically.",
    icon: Zap,
    ctaLabel: "Got it",
  },
  {
    key: "dashboard",
    title: "Your dashboard",
    body: "This is where you'll see restored revenue, campaign performance, and what to do next. Every metric is traceable to real orders — no estimated or modelled numbers.",
    icon: LayoutDashboard,
    ctaLabel: "Go to dashboard",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Progress indicator
// ─────────────────────────────────────────────────────────────────────────────

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-6" role="tablist" aria-label="Onboarding progress">
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          role="tab"
          aria-selected={i === current}
          aria-label={`Step ${i + 1}${i < current ? " (completed)" : i === current ? " (current)" : ""}`}
          className={`transition-all ${
            i < current
              ? "h-8 w-8 rounded-pill bg-success-500"
              : i === current
                ? "h-8 w-20 rounded-pill bg-ink-900"
                : "h-8 w-8 rounded-pill bg-cream-300"
          }`}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export function OnboardingFlow() {
  const router = useRouter();
  const [stepIdx, setStepIdx] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Mark onboarding as in_progress on first render.
    void fetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "in_progress" }),
    });
    return () => { mountedRef.current = false; };
  }, []);

  const complete = useCallback(
    async (state: "completed" | "skipped") => {
      if (transitioning) return;
      setTransitioning(true);
      await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (mountedRef.current) router.push("/app");
    },
    [router, transitioning],
  );

  const step = STEPS[stepIdx]!;
  const isLast = stepIdx === STEPS.length - 1;
  const IconComp = step.icon;

  return (
    <div className="mx-auto max-w-[600px]">
      {/* Header */}
      <div className="mb-32 flex items-center justify-between">
        <div className="text-h1 font-bold tracking-[-0.04em] text-ink-900">lapsed.</div>
        <button
          type="button"
          onClick={() => void complete("skipped")}
          disabled={transitioning}
          className="text-mini text-ink-400 underline underline-offset-2 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
        >
          Skip tour
        </button>
      </div>

      {/* Progress dots */}
      <div className="mb-24 flex justify-center">
        <StepDots total={STEPS.length} current={stepIdx} />
      </div>

      {/* Step card */}
      <div className="rounded-xl border border-border bg-cream-50 p-32">
        {/* Icon */}
        <div className="mb-20 flex h-56 w-56 items-center justify-center rounded-lg bg-lavender-50 text-lavender-700">
          <IconComp strokeWidth={1.75} size={24} />
        </div>

        {/* Step counter */}
        <div className="mb-8 text-micro uppercase tracking-widest text-ink-400">
          Step {stepIdx + 1} of {STEPS.length}
        </div>

        {/* Title */}
        <h2 className="mb-12 text-h2 text-ink-900">{step.title}</h2>

        {/* Body */}
        <p className="mb-20 text-body text-ink-600">{step.body}</p>

        {/* Embedded voice step */}
        {step.embed === "voice" && (
          <div className="mb-24">
            <OnboardingVoiceStep />
          </div>
        )}

        {/* Navigation */}
        <div className="flex items-center justify-between gap-12">
          {stepIdx > 0 ? (
            <button
              type="button"
              onClick={() => setStepIdx((s) => Math.max(0, s - 1))}
              disabled={transitioning}
              className="text-mini text-ink-400 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
            >
              ← Back
            </button>
          ) : (
            <span /> /* spacer */
          )}

          <div className="flex items-center gap-8">
            {/* Completed indicator for prior steps */}
            {stepIdx > 0 && (
              <span className="flex items-center gap-4 text-mini text-success-500">
                <Check strokeWidth={2} size={12} />
                {stepIdx} of {STEPS.length} done
              </span>
            )}

            <Button
              onClick={() => {
                if (isLast) {
                  void complete("completed");
                } else {
                  setStepIdx((s) => s + 1);
                }
              }}
              disabled={transitioning}
            >
              {step.ctaLabel}
              {!isLast && <ArrowRight strokeWidth={1.75} size={16} className="ml-4" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Reassurance footer */}
      <p className="mt-16 text-center text-meta text-ink-400">
        Nothing sends until you approve a campaign. You can return to this tour from Settings.
      </p>
    </div>
  );
}
