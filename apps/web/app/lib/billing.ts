// Billing seam helpers for apps/web — Sprint 09.
//
// Builds the @lapsed/core Stripe client from billingEnv(). Every billing route
// (onboarding customer creation, checkout, webhook, portal, grace cron) goes
// through here so the env→config wiring lives in exactly one place.

import { createStripeClient, type LapsedStripeClient } from "@lapsed/core";
import { billingEnv } from "./env";

/**
 * Constructs the LapsedStripeClient from the billing env. Throws (via
 * billingEnv's required()) if the Stripe keys are not provisioned — billing
 * routes catch this and surface a 5xx / log critical; non-billing routes never
 * call it.
 */
export function billingStripeClient(): LapsedStripeClient {
  const env = billingEnv();
  return createStripeClient({
    secretKey: env.stripeSecretKey,
    webhookSecret: env.stripeWebhookSecret,
    priceIds: env.stripePriceIds,
  });
}
