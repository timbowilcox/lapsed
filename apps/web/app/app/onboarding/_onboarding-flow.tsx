"use client";

import { useState } from "react";
import { Button, Card, Panel, PanelHeader, PanelBody } from "@lapsed/ui";
import { Check, ArrowRight, Plug, Clock4, Send } from "lucide-react";
import { OnboardingVoiceStep } from "./_onboarding-voice-step";

const steps = [
  {
    key: "connect",
    title: "Connect Shopify",
    description: "lapsed.ai back-fills the last 24 months of orders, customers and products.",
    icon: Plug,
    cta: "Confirm connection",
  },
  {
    key: "cadence",
    title: "Set purchase cadence",
    description:
      "Detected repeat-buyer cadence: 38 days. Adjust if your category needs a different threshold.",
    icon: Clock4,
    cta: "Use 38 days",
  },
  {
    key: "first-campaign",
    title: "Launch your first campaign",
    description:
      "The agent has drafted a 60-day win-back targeting 812 repeat buyers with a $20 offer.",
    icon: Send,
    cta: "Launch (mock)",
  },
];

export function OnboardingFlow() {
  const [stepIdx, setStepIdx] = useState(0);
  const isLast = stepIdx === steps.length - 1;

  return (
    <div className="mx-auto max-w-[640px]">
      <div className="mb-24 text-center">
        <h2 className="text-h1 text-ink-900">Welcome to lapsed.</h2>
        <p className="mt-4 text-meta text-ink-500">
          Three steps to your first win-back.
        </p>
      </div>

      <div className="mb-16 flex items-center justify-center gap-8">
        {steps.map((s, idx) => (
          <div key={s.key} className="flex items-center gap-8">
            <span
              className={`flex h-24 w-24 items-center justify-center rounded-pill text-mini font-semibold ${
                idx < stepIdx
                  ? "bg-success-100 text-success-500"
                  : idx === stepIdx
                    ? "bg-ink-900 text-cream-50"
                    : "bg-cream-200 text-ink-700"
              }`}
            >
              {idx < stepIdx ? <Check strokeWidth={2} size={14} /> : idx + 1}
            </span>
            {idx < steps.length - 1 && (
              <span className="h-px w-32 bg-cream-300" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>

      {steps.map((step, idx) => {
        if (idx !== stepIdx) return null;
        const IconComp = step.icon;
        return (
          <Panel key={step.key} className="rounded-xl">
            <PanelHeader title={step.title} />
            <PanelBody>
              <div className="flex flex-col items-center gap-20 p-32 text-center">
                <div className="flex h-64 w-64 items-center justify-center rounded-lg bg-lavender-100 text-lavender-700">
                  <IconComp strokeWidth={1.75} size={28} />
                </div>
                <p className="max-w-[420px] text-body text-ink-700">{step.description}</p>
                {step.key === "connect" ? (
                  <OnboardingVoiceStep />
                ) : (
                  <Card className="w-full bg-cream-100 p-16 text-left">
                    <div className="text-mini font-semibold uppercase tracking-wide text-ink-500">
                      Step {idx + 1} preview
                    </div>
                    <div className="mt-6 text-body text-ink-900">
                      {step.key === "cadence" &&
                        "Detected cadence: 38 days. 2,847 customers currently past their typical reorder window."}
                      {step.key === "first-campaign" &&
                        "Group: lapsed 60–90 days repeat buyers · Offer: $20 off · Estimated revenue lift: $18,400"}
                    </div>
                  </Card>
                )}
                <div className="flex w-full justify-between">
                  <Button
                    variant="secondary"
                    disabled={stepIdx === 0}
                    onClick={() => setStepIdx((s) => Math.max(0, s - 1))}
                  >
                    Back
                  </Button>
                  <Button onClick={() => setStepIdx((s) => Math.min(steps.length - 1, s + 1))}>
                    {isLast ? "Finish" : step.cta}
                    {!isLast && <ArrowRight strokeWidth={1.75} size={16} />}
                  </Button>
                </div>
              </div>
            </PanelBody>
          </Panel>
        );
      })}
    </div>
  );
}
