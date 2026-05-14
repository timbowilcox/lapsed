"use client";

import { useState } from "react";
import {
  Button,
  Card,
  Input,
  Panel,
  PanelHeader,
  PanelBody,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  StatusDot,
} from "@lapsed/ui";
import { ArrowRight, ArrowLeft, Check } from "lucide-react";

type StepKey = "audience" | "offer" | "message" | "review";

const steps: Array<{ key: StepKey; label: string; description: string }> = [
  { key: "audience", label: "Audience", description: "Who receives this campaign" },
  { key: "offer", label: "Offer", description: "Discount, free shipping or sample" },
  { key: "message", label: "Message", description: "Opening line and tone guidance" },
  { key: "review", label: "Review", description: "Confirm and launch" },
];

export function CampaignWizard() {
  const [stepIdx, setStepIdx] = useState(0);
  const [audience, setAudience] = useState("60d");
  const [offerType, setOfferType] = useState("discount");
  const [discountValue, setDiscountValue] = useState("20");
  const [message, setMessage] = useState(
    "Hi {{first_name}} — Bondi Goods here. Quick check-in — want a one-tap link with {{offer}}?",
  );
  const [campaignName, setCampaignName] = useState("New win-back campaign");

  const currentStep = steps[stepIdx];
  if (!currentStep) return null;
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === steps.length - 1;

  return (
    <div className="grid grid-cols-[260px_1fr] gap-32">
      <nav aria-label="Wizard steps" className="flex flex-col gap-2">
        {steps.map((step, idx) => {
          const isActive = idx === stepIdx;
          const isDone = idx < stepIdx;
          return (
            <button
              key={step.key}
              type="button"
              onClick={() => setStepIdx(idx)}
              className={`flex items-start gap-12 rounded-md p-12 text-left transition-colors ${
                isActive ? "bg-cream-50 border border-border" : "hover:bg-cream-200"
              }`}
            >
              <span
                className={`mt-2 flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-pill text-mini font-semibold ${
                  isDone
                    ? "bg-success-100 text-success-500"
                    : isActive
                      ? "bg-ink-900 text-cream-50"
                      : "bg-cream-200 text-ink-700"
                }`}
              >
                {isDone ? <Check strokeWidth={2} size={12} /> : idx + 1}
              </span>
              <div>
                <div className="text-body-strong text-ink-900">{step.label}</div>
                <div className="text-mini text-ink-500">{step.description}</div>
              </div>
            </button>
          );
        })}
      </nav>

      <Panel>
        <PanelHeader
          title={currentStep.label}
          action={
            <StatusDot
              status="draft"
              label={`Step ${stepIdx + 1} of ${steps.length}`}
            />
          }
        />
        <PanelBody>
          <div className="p-24">
            {currentStep.key === "audience" && (
              <div className="flex flex-col gap-16">
                <label className="flex flex-col gap-6">
                  <span className="text-label text-ink-700">Group</span>
                  <Select value={audience} onValueChange={setAudience}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="60d">Lapsed 60 days · 812 customers</SelectItem>
                      <SelectItem value="90d">Lapsed 90 days · 446 customers</SelectItem>
                      <SelectItem value="vip">VIP 90+ days · 214 customers</SelectItem>
                      <SelectItem value="replenish">
                        Replenishment due · 312 customers
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-meta text-ink-500">
                    Only opted-in, SMS-eligible customers will receive messages.
                  </span>
                </label>
              </div>
            )}

            {currentStep.key === "offer" && (
              <div className="flex flex-col gap-16">
                <label className="flex flex-col gap-6">
                  <span className="text-label text-ink-700">Offer type</span>
                  <Select value={offerType} onValueChange={setOfferType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="discount">Percentage / dollar discount</SelectItem>
                      <SelectItem value="shipping">Free shipping</SelectItem>
                      <SelectItem value="sample">Free sample with order</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex flex-col gap-6">
                  <span className="text-label text-ink-700">Discount value (USD)</span>
                  <Input
                    type="number"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                  />
                </label>
              </div>
            )}

            {currentStep.key === "message" && (
              <div className="flex flex-col gap-16">
                <label className="flex flex-col gap-6">
                  <span className="text-label text-ink-700">Campaign name</span>
                  <Input
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-6">
                  <span className="text-label text-ink-700">Opening message</span>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={4}
                    className="rounded-sm border border-cream-300 bg-cream-50 p-12 text-body text-ink-900 focus-visible:outline-none focus-visible:shadow-focus"
                  />
                  <span className="text-meta text-ink-500">
                    Use{" "}
                    <code className="rounded-sm bg-cream-200 px-4 py-1 text-mini">
                      {"{{first_name}}"}
                    </code>{" "}
                    and{" "}
                    <code className="rounded-sm bg-cream-200 px-4 py-1 text-mini">
                      {"{{offer}}"}
                    </code>{" "}
                    as variables.
                  </span>
                </label>
              </div>
            )}

            {currentStep.key === "review" && (
              <div className="flex flex-col gap-16">
                <Card className="p-20">
                  <div className="text-label text-ink-500">Name</div>
                  <div className="mt-4 text-body-strong text-ink-900">{campaignName}</div>
                </Card>
                <Card className="p-20">
                  <div className="text-label text-ink-500">Audience</div>
                  <div className="mt-4 text-body-strong text-ink-900">{audience}</div>
                </Card>
                <Card className="p-20">
                  <div className="text-label text-ink-500">Offer</div>
                  <div className="mt-4 text-body-strong text-ink-900">
                    {offerType === "discount"
                      ? `$${discountValue} off`
                      : offerType === "shipping"
                        ? "Free shipping"
                        : "Free sample"}
                  </div>
                </Card>
                <Card className="p-20">
                  <div className="text-label text-ink-500">Message</div>
                  <div className="mt-4 whitespace-pre-wrap text-body text-ink-900">{message}</div>
                </Card>
                <p className="text-meta text-ink-500">
                  Sprint 01 is design-only — launching is not wired up. In Sprint 03–05 this
                  button starts the campaign.
                </p>
              </div>
            )}
          </div>
        </PanelBody>

        <div className="flex items-center justify-between border-t border-border px-24 py-16">
          <Button
            variant="secondary"
            disabled={isFirst}
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
          >
            <ArrowLeft strokeWidth={1.75} size={16} /> Back
          </Button>
          <Button
            variant="primary"
            onClick={() => setStepIdx((i) => Math.min(steps.length - 1, i + 1))}
            disabled={isLast}
          >
            {isLast ? "Launch (mock)" : "Continue"}
            {!isLast && <ArrowRight strokeWidth={1.75} size={16} />}
          </Button>
        </div>
      </Panel>
    </div>
  );
}
