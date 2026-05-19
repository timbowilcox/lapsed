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
import type { ProposalVariant } from "@lapsed/db";
import { ArrowRight, ArrowLeft, Check, Loader2, Sparkles } from "lucide-react";

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
  merchantId: string;
  /** Cohort slug to pre-select (set when arriving from a suggested campaign). */
  initialGroupSlug?: string;
}

type Phase = "form" | "generating" | "preview" | "approving";

interface ProposalPreview {
  proposalId: string;
  variants: ProposalVariant[];
  customerCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard steps (form phase only)
// ─────────────────────────────────────────────────────────────────────────────

const FORM_STEPS = [
  { key: "audience" as const, label: "Group", description: "Who receives this campaign" },
  { key: "offer" as const, label: "Offer", description: "Discount, free shipping or sample" },
] as const;

type FormStepKey = (typeof FORM_STEPS)[number]["key"];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const VARIANT_LABELS = ["A", "B", "C"] as const;

function offerDisplay(offerType: string, offerValue: string): string {
  if (offerType === "percentage" || offerType === "discount") return `${offerValue}% off`;
  if (offerType === "fixed") return `$${offerValue} off`;
  if (offerType === "free_shipping" || offerType === "shipping") return "Free shipping";
  if (offerType === "free_sample" || offerType === "sample") return "Free sample";
  return `${offerType} — ${offerValue}`;
}

function toneLabel(tone: string): string {
  return tone.charAt(0).toUpperCase() + tone.slice(1).replace(/_/g, " ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function CampaignWizard({ groups, merchantId, initialGroupSlug }: Props) {
  const router = useRouter();

  // Form state
  const [stepIdx, setStepIdx] = useState(0);
  const [audience, setAudience] = useState(
    initialGroupSlug && groups.some((g) => g.slug === initialGroupSlug)
      ? initialGroupSlug
      : (groups[0]?.slug ?? ""),
  );
  const [offerType, setOfferType] = useState("discount");
  const [discountValue, setDiscountValue] = useState("20");

  // Phase machine
  const [phase, setPhase] = useState<Phase>("form");
  const [preview, setPreview] = useState<ProposalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentStep = FORM_STEPS[stepIdx] as (typeof FORM_STEPS)[number] | undefined;
  const isFirstStep = stepIdx === 0;
  const isLastStep = stepIdx === FORM_STEPS.length - 1;
  const audienceMeta = groups.find((g) => g.slug === audience);

  function canAdvance(): boolean {
    const key: FormStepKey | undefined = currentStep?.key;
    if (key === "audience") return audience.length > 0;
    if (key === "offer") return offerType !== "discount" || discountValue.trim().length > 0;
    return true;
  }

  // ── Generate: create proposal then load variants ─────────────────────────────

  async function handleGenerate() {
    setError(null);
    setPhase("generating");
    try {
      const createRes = await fetch("/api/campaigns/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupSlug: audience }),
      });
      if (!createRes.ok) {
        const body = (await createRes.json()) as { error?: string };
        setError(body.error ?? "Something went wrong. Please try again.");
        setPhase("form");
        return;
      }
      const { proposalId } = (await createRes.json()) as { proposalId: string };

      const detailRes = await fetch(`/api/campaigns/${proposalId}`);
      if (!detailRes.ok) {
        // Proposal created — redirect to the queue; user can review it there.
        router.push("/app/campaigns");
        return;
      }
      const detail = (await detailRes.json()) as {
        proposalId: string;
        variants: ProposalVariant[];
        customerCount: number;
      };
      setPreview({ proposalId, variants: detail.variants, customerCount: detail.customerCount });
      setPhase("preview");
    } catch {
      setError("Something went wrong. Please try again.");
      setPhase("form");
    }
  }

  // ── Approve ──────────────────────────────────────────────────────────────────

  async function handleApprove() {
    if (!preview) return;
    setError(null);
    setPhase("approving");
    try {
      const res = await fetch(`/api/campaigns/${preview.proposalId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: merchantId }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        if (res.status === 401) {
          setError("Your session has expired. Please refresh and try again.");
        } else if (body.error === "billing_gate") {
          setError(
            "Your current plan doesn't allow approving campaigns. Check your subscription in Settings.",
          );
        } else {
          setError("Something went wrong. Please try again.");
        }
        setPhase("preview");
        return;
      }
      router.push("/app/campaigns");
    } catch {
      setError("Something went wrong. Please try again.");
      setPhase("preview");
    }
  }

  // ── Loading overlay (generating / approving) ─────────────────────────────────

  if (phase === "generating" || phase === "approving") {
    const label =
      phase === "generating"
        ? "The agent is designing your campaign variants…"
        : "Approving your campaign…";
    return (
      <Panel>
        <PanelBody>
          <div className="flex flex-col items-center gap-16 py-64 text-center">
            <Loader2 className="animate-spin text-ink-500" size={32} strokeWidth={1.5} />
            <p className="text-body text-ink-500">{label}</p>
          </div>
        </PanelBody>
      </Panel>
    );
  }

  // ── Preview phase ─────────────────────────────────────────────────────────────

  if (phase === "preview" && preview) {
    return (
      <div className="flex flex-col gap-24">
        <div>
          <h2 className="text-h2 text-ink-900">Campaign variants</h2>
          <p className="mt-4 text-body text-ink-500">
            The agent designed three variants for{" "}
            <span className="font-medium text-ink-900">{audienceMeta?.label ?? audience}</span>.
            Review each below — nothing is sent until you approve.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-16 lg:grid-cols-3">
          {preview.variants.map((v, i) => {
            const impact = v.expectedImpact as {
              estimated_response_rate?: number;
              estimated_recovered_revenue?: number;
            } | null;
            return (
              <Card key={v.armId} className="flex flex-col gap-12 p-20">
                <div className="flex items-center justify-between">
                  <span className="flex h-24 w-24 items-center justify-center rounded-pill bg-lavender-100 text-mini font-semibold text-lavender-800">
                    {VARIANT_LABELS[i] ?? String(i + 1)}
                  </span>
                  <span className="text-mini text-ink-500">{toneLabel(v.tone)}</span>
                </div>
                <p className="text-body text-ink-900">{v.messageDraft}</p>
                <div className="mt-auto flex flex-col gap-4 border-t border-border pt-12">
                  <div className="flex items-center justify-between text-mini text-ink-500">
                    <span>Offer</span>
                    <span>{offerDisplay(v.offerType, v.offerValue)}</span>
                  </div>
                  <div className="flex items-center justify-between text-mini text-ink-500">
                    <span>Send window</span>
                    <span>{v.sendTimeWindow}</span>
                  </div>
                  {typeof impact?.estimated_response_rate === "number" && (
                    <div className="flex items-center justify-between text-mini text-ink-500">
                      <span>Est. response rate</span>
                      <span>{(impact.estimated_response_rate * 100).toFixed(1)}%</span>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>

        {error && (
          <p role="alert" className="text-meta text-danger-700">
            {error}
          </p>
        )}

        <div className="flex items-center justify-between">
          <Button
            variant="secondary"
            onClick={() => {
              setPreview(null);
              setError(null);
              setPhase("form");
            }}
          >
            Start over
          </Button>
          <Button variant="primary" onClick={() => void handleApprove()}>
            Approve campaign
          </Button>
        </div>
      </div>
    );
  }

  // ── Form phase ────────────────────────────────────────────────────────────────

  if (!currentStep) return null;

  return (
    <div className="grid grid-cols-[260px_1fr] gap-32">
      {/* Step nav — forward-jumping is blocked; completed steps can be revisited. */}
      <nav aria-label="Wizard steps" className="flex flex-col gap-2">
        {FORM_STEPS.map((step, idx) => {
          const isActive = idx === stepIdx;
          const isDone = idx < stepIdx;
          const isFuture = idx > stepIdx;
          return (
            <button
              key={step.key}
              type="button"
              disabled={isFuture}
              onClick={() => {
                if (!isFuture) setStepIdx(idx);
              }}
              className={`flex items-start gap-12 rounded-md p-12 text-left transition-colors ${
                isActive
                  ? "border border-border bg-cream-50"
                  : isFuture
                    ? "cursor-not-allowed opacity-40"
                    : "hover:bg-cream-200"
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
              label={`Step ${stepIdx + 1} of ${FORM_STEPS.length}`}
            />
          }
        />
        <PanelBody>
          <div className="p-24">
            {/* ── Group picker ─────────────────────────────────────── */}
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

            {/* ── Offer ────────────────────────────────────────────── */}
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
                  The agent uses your preference as a starting point when designing variants.
                </p>
                {error && (
                  <p role="alert" className="text-meta text-danger-700">
                    {error}
                  </p>
                )}
              </div>
            )}
          </div>
        </PanelBody>

        <div className="flex items-center justify-between border-t border-border px-24 py-16">
          <Button
            variant="secondary"
            disabled={isFirstStep}
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
          >
            <ArrowLeft strokeWidth={1.75} size={16} /> Back
          </Button>
          {isLastStep ? (
            <Button
              variant="primary"
              onClick={() => void handleGenerate()}
              disabled={!canAdvance() || groups.length === 0}
            >
              <Sparkles strokeWidth={1.75} size={16} /> Generate variants
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => setStepIdx((i) => Math.min(FORM_STEPS.length - 1, i + 1))}
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
