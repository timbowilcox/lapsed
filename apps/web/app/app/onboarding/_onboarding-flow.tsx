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
    ctaLabel: "Continue",
  },
  {
    key: "customers",
    title: "Your customers, classified",
    body: "Tonight's scoring run groups your customers by how recently they bought and how likely they are to buy again. Tomorrow morning you'll see them here — grouped by win-back potential.",
    icon: Users,
    ctaLabel: "Continue",
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
    ctaLabel: "Continue",
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
//
// Uses role="progressbar" — the correct semantic for a visual position
// indicator. The dots are aria-hidden (decorative); position is conveyed
// via aria-valuenow + aria-valuemax and the "Step N of 5" text in the card.
// ─────────────────────────────────────────────────────────────────────────────

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div
      className="flex items-center gap-6"
      role="progressbar"
      aria-valuenow={current + 1}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-label={`Step ${current + 1} of ${total}`}
    >
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          aria-hidden="true"
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
  // Focus management: focus the step heading when the step changes so
  // screen readers announce the new step content automatically.
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Mark onboarding as in_progress on first render. Fire-and-forget —
    // the terminal complete() call is the authoritative state write.
    fetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "in_progress" }),
    }).catch(() => {
      // Non-fatal: state will be set correctly when complete() fires.
    });
    return () => { mountedRef.current = false; };
  }, []);

  // Move focus to the new step heading on step transitions. Skip on mount
  // (stepIdx === 0 is the initial render; no focus steal on page load).
  useEffect(() => {
    if (stepIdx > 0) stepHeadingRef.current?.focus();
  }, [stepIdx]);

  // Wraps the terminal state write + navigation. Resets transitioning on
  // failure so the merchant is never permanently locked out of the UI.
  const complete = useCallback(
    async (state: "completed" | "skipped") => {
      if (transitioning) return;
      setTransitioning(true);
      try {
        const res = await fetch("/api/onboarding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (mountedRef.current) router.push("/app");
      } catch {
        // Network failure or non-2xx — reset so the merchant can retry.
        if (mountedRef.current) setTransitioning(false);
      }
    },
    [router, transitioning],
  );

  const step = STEPS[stepIdx]!;
  const isLast = stepIdx === STEPS.length - 1;
  const IconComp = step.icon;

  return (
    <div className="mx-auto max-w-[600px]">
      {/* Header — "Skip tour" only on Step 1 where the decision to engage is being made. */}
      <div className="mb-32 flex items-center justify-between">
        <div className="text-display font-bold tracking-[-0.04em] text-ink-900">lapsed.</div>
        {stepIdx === 0 && (
          <button
            type="button"
            onClick={() => void complete("skipped")}
            disabled={transitioning}
            className="text-mini text-ink-500 underline underline-offset-2 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
          >
            Skip tour
          </button>
        )}
      </div>

      {/* Progress dots */}
      <div className="mb-24 flex justify-center">
        <StepDots total={STEPS.length} current={stepIdx} />
      </div>

      {/* Step card */}
      <div className="rounded-xl border border-border bg-cream-50 p-32">
        {/* Icon — decorative; aria-hidden on the SVG via the wrapper */}
        <div
          className="mb-20 flex h-56 w-56 items-center justify-center rounded-lg bg-lavender-50 text-lavender-700"
          aria-hidden="true"
        >
          <IconComp strokeWidth={1.75} size={24} />
        </div>

        {/* Step counter — ink-500 for WCAG 1.4.3 (4.5:1 on cream-50) */}
        <div className="mb-8 text-micro uppercase tracking-widest text-ink-500">
          Step {stepIdx + 1} of {STEPS.length}
        </div>

        {/* Title — receives focus on step transition for screen reader announcement */}
        <h2
          ref={stepHeadingRef}
          tabIndex={-1}
          className="mb-12 text-h2 text-ink-900 focus-visible:outline-none"
        >
          {step.title}
        </h2>

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
              className="text-mini text-ink-500 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
            >
              ← Back
            </button>
          ) : (
            <span /> /* spacer */
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

      {/* Reassurance footer — steps 2+ include a low-weight skip link.
          ink-500 for WCAG 1.4.3 compliance on cream-100 background. */}
      <p className="mt-16 text-center text-meta text-ink-500">
        Nothing sends until you approve a campaign.{" "}
        {stepIdx > 0 && (
          <button
            type="button"
            onClick={() => void complete("skipped")}
            disabled={transitioning}
            className="underline underline-offset-2 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
          >
            Skip tour
          </button>
        )}{" "}
        You can return to this tour from Settings.
      </p>
    </div>
  );
}
