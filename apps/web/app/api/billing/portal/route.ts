// POST /api/billing/portal — Sprint 09 chunk 10.
//
// Creates a Stripe Customer Portal session for the authenticated merchant and
// returns its URL; the client redirects the browser to it. The portal is
// Stripe-hosted — tier changes, payment-method updates, and cancellation all
// happen there, and the resulting state syncs back via the Stripe webhook
// (chunk 8). No card data touches our server.

import { NextResponse } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { ensureStripeCustomer } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { billingStripeClient } from "@/app/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  try {
    const stripe = billingStripeClient();
    // The portal needs a Stripe customer; ensure one exists (decision 28).
    const { stripeCustomerId } = await ensureStripeCustomer(
      serviceClient,
      stripe,
      merchant.id,
    );
    const { url } = await stripe.createPortalSession(
      stripeCustomerId,
      `${env.shopifyAppUrl}/app/settings/billing`,
    );
    return NextResponse.json({ url });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "billing_portal_failed",
        merchant_id: merchant.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "portal_failed" }, { status: 502 });
  }
}
