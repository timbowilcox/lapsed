import { Card, formatCount } from "@lapsed/ui";
import { TIER_PLANS, SUBSCRIPTION_TIERS, supportTierLabel } from "@lapsed/core";
import { MerchantShell } from "../../_components/merchant-shell";
import { SubscribeButton } from "./subscribe-button";

export const dynamic = "force-dynamic";

/**
 * Subscription tier selection — Sprint 09 chunk 7. Three tier cards; selecting
 * one starts a Stripe-hosted Checkout session (the card never collects payment
 * details — Stripe does). Tier data is read from the shared TIER_PLANS source
 * so the price shown here is the price the entitlements function enforces.
 */
export default function SubscribePage() {
  return (
    <MerchantShell pageTitle="Choose a plan">
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">Choose a plan</h2>
        <p className="text-meta text-ink-500">
          Pick a subscription tier. Payment is handled securely by Stripe — card
          details are never stored by lapsed.ai.
        </p>
      </div>

      <ul className="grid grid-cols-3 gap-16">
        {SUBSCRIPTION_TIERS.map((tier) => {
          const plan = TIER_PLANS[tier];
          return (
            <li key={tier}>
              <Card className="flex h-full flex-col gap-16 p-24">
                <div>
                  <h3 className="text-body-strong text-ink-900">{plan.displayName}</h3>
                  <p className="mt-4 text-display text-ink-900 tabular-nums">
                    ${plan.priceUsdPerMonth.toLocaleString("en-US")}
                    <span className="ml-2 text-meta font-normal text-ink-500">/ month</span>
                  </p>
                </div>
                <ul className="flex flex-col gap-8 text-meta text-ink-500">
                  <li>Up to {plan.maxCampaignsPerMonth} campaigns per month</li>
                  <li>{formatCount(plan.maxSendsPerMonth)} messages per month</li>
                  <li>{supportTierLabel(plan.supportTier)}</li>
                </ul>
                <div className="mt-auto">
                  <SubscribeButton tier={tier} label={`Select ${plan.displayName}`} />
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </MerchantShell>
  );
}
