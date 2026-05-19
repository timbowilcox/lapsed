// Template library — Sprint 11, chunk 9.
//
// Static picker cards for proven campaign patterns. Clicking a template opens
// the manual wizard with the pattern pre-described. No AI generation here —
// the template sets intent; the wizard's AI step authors the message variants.

import Link from "next/link";
import { Card, Tag } from "@lapsed/ui";

interface Template {
  id: string;
  name: string;
  description: string;
  pattern: string;
  winBackRange: string;
  suggestedGroup: string;
  groupSlug: string;
  offerHint: string;
}

const TEMPLATES: Template[] = [
  {
    id: "60_day_winback",
    name: "60-day win-back",
    description:
      "Re-engage customers who haven't purchased in 60–90 days — before they become deeply lapsed.",
    pattern: "Time-sensitive percentage discount",
    winBackRange: "8–12% respond",
    suggestedGroup: "At-risk regulars",
    groupSlug: "at_risk_regulars",
    offerHint: "10–15% off next order",
  },
  {
    id: "vip_recovery",
    name: "VIP recovery",
    description:
      "Bring back your highest-LTV customers with an exclusive offer that acknowledges their history.",
    pattern: "Exclusive access + loyalty discount",
    winBackRange: "10–15% respond",
    suggestedGroup: "Lapsed VIPs",
    groupSlug: "lapsed_vips",
    offerHint: "Early access or VIP-only discount",
  },
  {
    id: "replenishment",
    name: "Replenishment reminder",
    description: "Catch consumable product buyers when their last order is likely running out.",
    pattern: "Personalised replenishment nudge",
    winBackRange: "12–18% respond",
    suggestedGroup: "Single-purchase converters",
    groupSlug: "single_purchase_converters",
    offerHint: "Free shipping or small bundle discount",
  },
  {
    id: "post_purchase",
    name: "Post-purchase upsell",
    description:
      "Reach recent first-time buyers while your brand is top-of-mind to drive a second purchase.",
    pattern: "Complementary product recommendation",
    winBackRange: "15–22% respond",
    suggestedGroup: "Recent first-time buyers",
    groupSlug: "recent_first_purchasers",
    offerHint: "Curated bundle or related product offer",
  },
  {
    id: "post_holiday",
    name: "Post-holiday reactivation",
    description:
      "Re-engage customers who only buy seasonally with a compelling reason to return year-round.",
    pattern: "Year-round value proposition",
    winBackRange: "7–11% respond",
    suggestedGroup: "Price-sensitive lapsed buyers",
    groupSlug: "price_sensitive_lapsed",
    offerHint: "Fixed-amount discount or free shipping",
  },
  {
    id: "win_back_at_risk",
    name: "Going quiet",
    description:
      "Reach previously won-back customers who are becoming quiet again before they churn.",
    pattern: "Re-engagement with loyalty recognition",
    winBackRange: "9–14% respond",
    suggestedGroup: "Win-backs going quiet",
    groupSlug: "win_backs_at_risk",
    offerHint: "Loyalty reward or personalised offer",
  },
];

export function TemplateLibrary() {
  return (
    <section aria-label="Campaign template library" className="mt-40">
      <div className="mb-16">
        <h2 className="text-h2 text-ink-900">Proven patterns</h2>
        <p className="mt-4 text-meta text-ink-500">
          Start with a pattern, then the AI tailors the message to your brand voice and group.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-16 md:grid-cols-2 lg:grid-cols-3">
        {TEMPLATES.map((t) => (
          <Card key={t.id} className="flex flex-col gap-10 p-20">
            <div>
              <div className="text-h3 text-ink-900">{t.name}</div>
              <p className="mt-4 text-meta text-ink-500">{t.description}</p>
            </div>

            <div className="flex flex-wrap gap-6">
              <Tag tone="stalled">{t.suggestedGroup}</Tag>
            </div>

            <div className="rounded-sm bg-cream-100 px-12 py-8">
              <div className="text-mini text-ink-500">Suggested offer</div>
              <div className="mt-2 text-meta text-ink-700">{t.offerHint}</div>
              <div className="mt-4 text-mini text-ink-400">{t.winBackRange}</div>
            </div>

            <div className="mt-auto">
              <Link
                href={`/app/campaigns/new?groupSlug=${t.groupSlug}`}
                className="inline-flex w-full items-center justify-center rounded-md border border-border bg-cream-50 px-16 py-10 text-label text-ink-900 transition-colors hover:bg-cream-100 focus-visible:outline-none focus-visible:shadow-focus"
              >
                Use this pattern
              </Link>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
