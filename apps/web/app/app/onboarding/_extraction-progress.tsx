"use client";

// Onboarding progress UI (Sprint 05, chunk 9). Polls /api/voice/status
// every 2 seconds while the voice extraction is in progress and renders a
// four-step indicator. Stops polling on `ready` or `failed`.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@lapsed/ui";
import { Check, AlertCircle, Loader2 } from "lucide-react";

type ExtractionPhase = "analyzing" | "extracting" | "generating" | "ready" | "failed";

interface ExtractionStatus {
  phase: ExtractionPhase;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  voiceVersionId: string | null;
}

const STEPS: { phase: Exclude<ExtractionPhase, "failed">; label: string; help: string }[] = [
  {
    phase: "analyzing",
    label: "Analyzing storefront",
    help: "Reading your about page, product descriptions and policies.",
  },
  {
    phase: "extracting",
    label: "Extracting brand voice",
    help: "Synthesizing tone, register and signature phrases.",
  },
  {
    phase: "generating",
    label: "Generating agent identity",
    help: "Choosing a role descriptor and channel preferences.",
  },
  {
    phase: "ready",
    label: "Ready",
    help: "Your brand voice profile is set.",
  },
];

const POLL_INTERVAL_MS = 2000;

type StepState = "done" | "active" | "future" | "error";

/** Index of a phase within STEPS; -1 for `failed`. */
function phaseIndex(phase: ExtractionPhase): number {
  if (phase === "failed") return -1;
  return STEPS.findIndex((s) => s.phase === phase);
}

/** Human-readable copy for an extraction_failed reason. */
function describeError(reason: string | null): string {
  switch (reason) {
    case "daily_cap_exhausted":
      return "You've reached today's brand-voice extraction limit. Please try again tomorrow.";
    case "all_resources_failed":
      return "We couldn't read your storefront. Check that your store is published, then try again.";
    default:
      return "Something went wrong while building your brand voice. You can try again.";
  }
}

function stepStateFor(idx: number, phase: ExtractionPhase, failedStep: number): StepState {
  if (phase === "failed") {
    if (idx < failedStep) return "done";
    if (idx === failedStep) return "error";
    return "future";
  }
  if (phase === "ready") return "done";
  const current = phaseIndex(phase);
  if (idx < current) return "done";
  if (idx === current) return "active";
  return "future";
}

export interface ExtractionProgressProps {
  /** Called once when the extraction reaches the `ready` phase. */
  onComplete?: (voiceVersionId: string | null) => void;
}

export function ExtractionProgress({ onComplete }: ExtractionProgressProps) {
  const [status, setStatus] = useState<ExtractionStatus | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [runToken, setRunToken] = useState(0);

  // Last non-terminal step seen — marks which step shows the error icon when
  // the run fails (the failed event itself doesn't carry the in-progress step).
  const lastActiveStepRef = useRef(0);
  const completedFiredRef = useRef(false);

  const phase: ExtractionPhase = status?.phase ?? "analyzing";

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async (): Promise<void> => {
      let result: ExtractionPhase | null = null;
      try {
        const res = await fetch("/api/voice/status", { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const next = (await res.json()) as ExtractionStatus;
        if (cancelled) return;
        setReconnecting(false);
        setStatus(next);
        result = next.phase;
        if (next.phase !== "failed" && next.phase !== "ready") {
          lastActiveStepRef.current = Math.max(0, phaseIndex(next.phase));
        }
      } catch {
        // Transient network error — keep polling, surface a soft notice.
        if (cancelled) return;
        setReconnecting(true);
      }
      if (cancelled) return;
      if (result === "ready" || result === "failed") return;
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    // On retry (runToken > 0) the orchestrator needs a moment to write the
    // new extraction_started event — delay the first poll so it isn't read
    // as the stale `failed` state of the previous run.
    if (runToken === 0) {
      void tick();
    } else {
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runToken]);

  // Fire onComplete exactly once when the run reaches `ready`.
  useEffect(() => {
    if (phase === "ready" && !completedFiredRef.current) {
      completedFiredRef.current = true;
      onComplete?.(status?.voiceVersionId ?? null);
    }
  }, [phase, status?.voiceVersionId, onComplete]);

  const handleRetry = useCallback(async () => {
    completedFiredRef.current = false;
    lastActiveStepRef.current = 0;
    // Optimistically show the first step so the failed state doesn't flash.
    setStatus({
      phase: "analyzing",
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      voiceVersionId: null,
    });
    setReconnecting(false);
    try {
      await fetch("/api/voice/status", { method: "POST" });
    } catch {
      setReconnecting(true);
    }
    setRunToken((token) => token + 1);
  }, []);

  const failedStep = lastActiveStepRef.current;
  const activeLabel =
    phase === "failed"
      ? "Brand voice extraction failed"
      : phase === "ready"
        ? "Brand voice ready"
        : `${STEPS[phaseIndex(phase)]?.label ?? "Analyzing storefront"}…`;

  return (
    <div className="w-full">
      {/* Screen-reader announcement of the current phase. */}
      <p className="sr-only" aria-live="polite">
        {activeLabel}
      </p>

      <ol className="flex flex-col gap-4">
        {STEPS.map((step, idx) => {
          const state = stepStateFor(idx, phase, failedStep);
          return (
            <li
              key={step.phase}
              aria-current={state === "active" ? "step" : undefined}
              className="flex items-start gap-12 rounded-lg bg-cream-100 p-16"
            >
              <span
                className={`flex h-32 w-32 shrink-0 items-center justify-center rounded-pill ${
                  state === "done"
                    ? "bg-success-100 text-success-500"
                    : state === "active"
                      ? "bg-lavender-100 text-lavender-700"
                      : state === "error"
                        ? "bg-danger-100 text-danger-500"
                        : "bg-cream-200 text-ink-300"
                }`}
              >
                {state === "done" && <Check strokeWidth={2.25} size={16} aria-hidden="true" />}
                {state === "active" && (
                  <Loader2
                    strokeWidth={2}
                    size={16}
                    className="animate-spin"
                    role="status"
                    aria-label="In progress"
                  />
                )}
                {state === "error" && (
                  <AlertCircle strokeWidth={2.25} size={16} aria-hidden="true" />
                )}
                {state === "future" && (
                  <span className="text-mini font-semibold" aria-hidden="true">
                    {idx + 1}
                  </span>
                )}
              </span>
              <span className="flex flex-col gap-2">
                <span
                  className={`text-body-strong ${
                    state === "future" ? "text-ink-300" : "text-ink-900"
                  }`}
                >
                  {step.label}
                </span>
                <span className="text-meta text-ink-500">{step.help}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {reconnecting && phase !== "failed" && (
        <p className="mt-12 text-meta text-ink-500" aria-live="polite">
          Reconnecting…
        </p>
      )}

      {phase === "failed" && (
        <div
          role="alert"
          className="mt-16 flex flex-col gap-12 rounded-lg bg-danger-100 p-16"
        >
          <div className="flex items-start gap-8">
            <AlertCircle
              strokeWidth={2}
              size={18}
              className="mt-2 shrink-0 text-danger-500"
              aria-hidden="true"
            />
            <p className="text-body text-ink-900">{describeError(status?.errorMessage ?? null)}</p>
          </div>
          {status?.errorMessage !== "daily_cap_exhausted" && (
            <div>
              <Button variant="secondary" onClick={() => void handleRetry()}>
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
