// POST /api/billing/checkout — Sprint 09 chunk 7.
//
// Creates a Stripe-hosted subscription Checkout session for the authenticated
// merchant at the requested tier and returns the session URL; the client
// redirects the browser to it. The merchant's stripe_customer_id is ensured
// (created if missing — decision 28) before the session is created.
//
// No credit card data ever reaches our server — Stripe Checkout collects and
// tokenises the card on Stripe's hosted page.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@lapsed/db";
import { ensureStripeCustomer, isSubscriptionTier } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { billingStripeClient } from "@/app/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: { tier?: unknown };
  try {
    body = (await request.json()) as { tier?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!isSubscriptionTier(body.tier)) {
    return NextResponse.json({ error: "invalid_tier" }, { status: 400 });
  }
  const tier = body.tier;

  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Decision 29: a merchant who already has a live subscription must NOT start
  // a second Checkout — that would create a duplicate Stripe subscription.
  // Tier changes go through the customer portal (chunk 10). Only a merchant
  // with no subscription, or a previously-canceled one, may check out.
  const { data: existing, error: existingErr } = await serviceClient
    .from("merchants")
    .select("subscription_status")
    .eq("id", merchant.id)
    .maybeSingle();
  if (existingErr) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  const status = existing?.subscription_status;
  if (status && status !== "canceled") {
    return NextResponse.json({ error: "already_subscribed" }, { status: 409 });
  }

  try {
    const stripe = billingStripeClient();
    // Ensure the merchant has a Stripe customer (decision 28) — creates one if
    // onboarding's best-effort provisioning had failed.
    const { stripeCustomerId } = await ensureStripeCustomer(
      serviceClient,
      stripe,
      merchant.id,
    );

    const { url } = await stripe.createCheckoutSession(
      { id: merchant.id, shopDomain: merchant.shopDomain },
      stripeCustomerId,
      tier,
      {
        successUrl: `${env.shopifyAppUrl}/app/billing/success`,
        cancelUrl: `${env.shopifyAppUrl}/app/billing/subscribe`,
      },
      // Per-attempt idempotency key — guards a double-submitted request
      // without the 24h cross-attempt replay trap a static key would create.
      randomUUID(),
    );
    return NextResponse.json({ url });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "billing_checkout_failed",
        merchant_id: merchant.id,
        tier,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "checkout_failed" }, { status: 502 });
  }
}
