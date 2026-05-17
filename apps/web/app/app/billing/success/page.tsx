import Link from "next/link";
import { Card, Button } from "@lapsed/ui";
import { MerchantShell } from "../../_components/merchant-shell";

export const dynamic = "force-dynamic";

/**
 * Stripe Checkout success landing — Sprint 09 chunk 7. Stripe redirects here
 * after a completed subscription checkout. The subscription state itself
 * arrives via the Stripe webhook (chunk 8), so this page confirms the checkout
 * and tells the merchant activation is in progress — it does not read or
 * assert subscription state.
 */
export default function BillingSuccessPage() {
  return (
    <MerchantShell pageTitle="Subscription confirmed">
      <Card className="mx-auto flex max-w-md flex-col gap-16 p-24">
        <h2 className="text-h1 text-ink-900">Subscription confirmed</h2>
        <p className="text-meta text-ink-500">
          Checkout is complete. Your plan is being activated — this usually
          takes a few moments. The billing settings page will show your active
          plan once Stripe confirms it.
        </p>
        <div>
          <Button asChild variant="primary">
            <Link href="/app/settings/billing">Go to billing settings</Link>
          </Button>
        </div>
      </Card>
    </MerchantShell>
  );
}
