import Link from "next/link";
import { Card, Button, Badge, EmptyState, formatDate } from "@lapsed/ui";
import { createServiceClient } from "@lapsed/db";
import { TIER_PLANS, type SubscriptionTier } from "@lapsed/core";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../../_components/merchant-shell";
import { ManageBillingButton } from "./manage-billing-button";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Maps a mirror status to calm, plain-language merchant copy (tenet 7). */
function statusNote(status: string): { label: string; note: string | null } {
  switch (status) {
    case "active":
      return { label: "Active", note: null };
    case "trialing":
      return { label: "Trial", note: null };
    case "past_due":
      return {
        label: "Payment due",
        note: "A recent payment did not go through. Update your payment method in the billing portal to keep your plan active.",
      };
    case "suspended":
      return {
        label: "Suspended",
        note: "Your plan is suspended after an unpaid invoice. Existing campaigns continue to run; new sends and approvals resume once payment is updated.",
      };
    default:
      return { label: status, note: null };
  }
}

/**
 * Billing settings — Sprint 09 chunk 10. Shows the merchant's current plan and
 * a "Manage billing" link into the Stripe-hosted Customer Portal (tier changes,
 * payment method, cancellation). The portal's changes sync back via the Stripe
 * webhook. A merchant with no live plan is sent to the subscribe page instead.
 */
export default async function SettingsBillingPage({ searchParams }: PageProps) {
  const merchant = await requireMerchant({ searchParams: await searchParams });

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });
  const { data: sub } = await client
    .from("merchant_subscriptions")
    .select("tier, status, current_period_end")
    .eq("merchant_id", merchant.id)
    .maybeSingle();

  const hasPlan = sub != null && sub.status !== "canceled";
  const plan = hasPlan ? TIER_PLANS[sub.tier as SubscriptionTier] : null;
  const status = hasPlan ? statusNote(sub.status) : null;

  return (
    <MerchantShell pageTitle="Billing">
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">Billing</h2>
        <p className="text-meta text-ink-500">
          Your subscription plan and payment management.
        </p>
      </div>

      <Card className="flex flex-col gap-16 p-24">
        {hasPlan && plan && status ? (
          <>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-body-strong text-ink-900">{plan.displayName} plan</h3>
                <p className="mt-4 text-display text-ink-900 tabular-nums">
                  ${plan.priceUsdPerMonth.toLocaleString("en-US")}
                  <span className="ml-2 text-meta font-normal text-ink-500">/ month</span>
                </p>
              </div>
              <Badge tone="neutral">{status.label}</Badge>
            </div>
            {sub?.current_period_end ? (
              <p className="text-meta text-ink-500">
                Current period ends {formatDate(sub.current_period_end, "short")}
              </p>
            ) : null}
            {status.note ? (
              <p className="text-meta text-ink-500">{status.note}</p>
            ) : null}
            <ManageBillingButton />
          </>
        ) : (
          <>
            {/* Preview of the plan card structure the merchant will see once subscribed */}
            <div className="mb-16 grid grid-cols-3 gap-12 opacity-40 select-none" aria-hidden="true">
              {["Starter", "Growth", "Scale"].map((tier) => (
                <div key={tier} className="rounded-md border border-border p-16">
                  <div className="mb-8 h-[14px] w-[56px] rounded bg-cream-300" />
                  <div className="mb-12 h-[28px] w-[80px] rounded bg-cream-300" />
                  <div className="h-[12px] w-full rounded bg-cream-300" />
                </div>
              ))}
            </div>
            <EmptyState
              heading="No active plan"
              body="Choose a plan to start running win-back campaigns. Your plan appears here once you subscribe."
              cta={
                <Button asChild variant="primary">
                  <Link href="/app/billing/subscribe">Choose a plan</Link>
                </Button>
              }
            />
          </>
        )}
      </Card>
    </MerchantShell>
  );
}
