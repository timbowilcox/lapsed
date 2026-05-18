"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
  formatCount,
  formatDate,
} from "@lapsed/ui";
import { ArrowRight, ArrowLeft, Check } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupOption {
  slug: string;
  label: string;
  customerCount: number;
  lastCampaignedAt: string | null;
}

interface Props {
  groups: GroupOption[];
}

type StepKey = "audience" | "offer" | "message" | "review";

const steps: Array<{ key: StepKey; label: string; description: string }> = [
  { key: "audience", label: "Group", description: "Who receives this campaign" },
  { key: "offer", label: "Offer", description: "Discount, free shipping or sample" },
  { key: "message", label: "Message", description: "Opening line and tone guidance" },
  { key: "review", label: "Review", description: "Confirm and create" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function groupMeta(groups: GroupOption[], slug: string): GroupOption | undefined {
  return groups.find((g) => g.slug === slug);
}

function offerSummary(offerType: string, discountValue: string): string {
  if (offerType === "discount") return `$${discountValue} off`;
  if (offerType === "shipping") return "Free shipping";
  return "Free sample";
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function CampaignWizard({ groups }: Props) {
  const router = useRouter();
  const [stepIdx, setStepIdx] = useState(0);
  const [audience, setAudience] = useState(groups[0]?.slug ?? "");
  const [offerType, setOfferType] = useState("discount");
  const [discountValue, setDiscountValue] = useState("20");
  const [message, setMessage] = useState(
    "Hi {{first_name}} — we noticed it's been a while. Here's something to make it easy to come back: {{offer}}.",
  );
  const [campaignName, setCampaignName] = useState("New win-back campaign");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const currentStep = steps[stepIdx];
  if (!currentStep) return null;
  const isFirst = stepIdx === 0;
  const isLast = stepIdx === steps.length - 1;

  const audienceMeta = groupMeta(groups, audience);

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/campaigns/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupSlug: audience }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setSubmitError(body.error ?? "Something went wrong. Please try again.");
        return;
      }
      router.push("/app/campaigns");
    } catch {
      setSubmitError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Validate current step before allowing next.
  function canAdvance(): boolean {
    if (currentStep.key === "audience") return audience.length > 0;
    if (currentStep.key === "offer") return discountValue.trim().length > 0;
    if (currentStep.key === "message") return message.trim().length > 0;
    return true;
  }

  return (
    <div className="grid grid-cols-[260px_1fr] gap-32">
      {/* Step nav */}
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
                    ? "bg-success-100 text-ink-900"
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

      {/* Panel */}
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
            {/* ── Step 1: Group picker ─────────────────────────── */}
            {currentStep.key === "audience" && (
              <div className="flex flex-col gap-16">
                {groups.length === 0 ? (
                  <p className="text-body text-ink-500">
                    No customer groups are available yet. Your first scoring run completes within
                    24 hours of installing — check back then.
                  </p>
                ) : (
                  <fieldset className="flex flex-col gap-8">
                    <legend className="mb-8 text-label text-ink-700">
                      Which group should receive this campaign?
                    </legend>
                    {groups.map((group) => {
                      const selected = audience === group.slug;
                      return (
                        <label
                          key={group.slug}
                          className={`flex cursor-pointer items-start gap-12 rounded-md border p-16 transition-colors ${
                            selected
                              ? "border-lavender-500 bg-lavender-50"
                              : "border-border bg-cream-50 hover:bg-cream-100"
                          }`}
                        >
                          <input
                            type="radio"
                            name="audience"
                            value={group.slug}
                            checked={selected}
                            onChange={() => setAudience(group.slug)}
                            className="mt-2 accent-lavender-500"
                          />
                          <div className="flex-1">
                            <div className="text-body-strong text-ink-900">{group.label}</div>
                            <div className="mt-2 text-mini text-ink-500">
                              {formatCount(group.customerCount)} customers
                              {group.lastCampaignedAt
                                ? ` · last campaigned ${formatDate(group.lastCampaignedAt, "short")}`
                                : " · never campaigned"}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </fieldset>
                )}
                <p className="text-meta text-ink-500">
                  Only opted-in, SMS-eligible customers will receive messages.
                </p>
              </div>
            )}

            {/* ── Step 2: Offer ────────────────────────────────── */}
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
                {offerType === "discount" && (
                  <label className="flex flex-col gap-6">
                    <span className="text-label text-ink-700">Discount value (USD)</span>
                    <Input
                      type="number"
                      min={1}
                      value={discountValue}
                      onChange={(e) => setDiscountValue(e.target.value)}
                    />
                  </label>
                )}
                <p className="text-meta text-ink-500">
                  The agent will use this as a starting point when designing the campaign variants.
                </p>
              </div>
            )}

            {/* ── Step 3: Message ──────────────────────────────── */}
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
                  <span className="text-label text-ink-700">Opening message (optional guidance)</span>
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
                    as variables. The agent will create three variants based on your brand voice.
                  </span>
                </label>
              </div>
            )}

            {/* ── Step 4: Review ───────────────────────────────── */}
            {currentStep.key === "review" && (
              <div className="flex flex-col gap-16">
                <Card className="p-20">
                  <div className="text-label text-ink-500">Campaign name</div>
                  <div className="mt-4 text-body-strong text-ink-900">{campaignName}</div>
                </Card>
                <Card className="p-20">
                  <div className="text-label text-ink-500">Group</div>
                  <div className="mt-4 text-body-strong text-ink-900">
                    {audienceMeta?.label ?? audience}
                  </div>
                  {audienceMeta && (
                    <div className="mt-2 text-mini text-ink-500">
                      {formatCount(audienceMeta.customerCount)} customers
                    </div>
                  )}
                </Card>
                <Card className="p-20">
                  <div className="text-label text-ink-500">Offer</div>
                  <div className="mt-4 text-body-strong text-ink-900">
                    {offerSummary(offerType, discountValue)}
                  </div>
                </Card>
                <Card className="p-20">
                  <div className="text-label text-ink-500">Message guidance</div>
                  <div className="mt-4 whitespace-pre-wrap text-body text-ink-900">{message}</div>
                </Card>
                <p className="text-meta text-ink-500">
                  The agent will design three message variants using your brand voice. The
                  campaign appears in your review queue — nothing is sent until you approve it.
                </p>
                {submitError && (
                  <p role="alert" className="text-meta text-danger-700">
                    {submitError}
                  </p>
                )}
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
          {isLast ? (
            <Button
              variant="primary"
              onClick={() => void handleSubmit()}
              disabled={submitting || groups.length === 0}
            >
              {submitting ? "Creating campaign…" : "Create campaign"}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => setStepIdx((i) => Math.min(steps.length - 1, i + 1))}
              disabled={!canAdvance()}
            >
              Continue <ArrowRight strokeWidth={1.75} size={16} />
            </Button>
          )}
        </div>
      </Panel>
    </div>
  );
}
