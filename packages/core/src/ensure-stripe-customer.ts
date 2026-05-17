// Merchant Stripe customer provisioning — Sprint 09 chunk 6.
//
// Decision 28: every merchant gets a `stripe_customer_id` at onboarding, before
// they ever subscribe. `ensureStripeCustomer` is the idempotent provisioning
// step: it is called from the Shopify OAuth callback (new merchant) and from a
// one-shot backfill (pre-Sprint-09 merchants).
//
// IDEMPOTENT TWICE OVER:
//   1. In the common case, if `merchants.stripe_customer_id` is already
//      populated, this is a no-op — no Stripe call is made.
//   2. The Stripe call itself (createCustomer) is idempotency-keyed on the
//      merchant id. This is the real backstop: even a race where two
//      onboarding callbacks both read a NULL id and both call createCustomer
//      resolves to the SAME `cus_...`, and the write-back is guarded with
//      `WHERE stripe_customer_id IS NULL` so the first writer wins and the
//      second is a no-op. No duplicate customer can be created.
//
// NON-BLOCKING AT ONBOARDING. The OAuth callback wraps this in try/catch and
// logs a structured `level:critical` event on failure — a Stripe outage must
// not block a merchant from installing the app. A merchant with no customer id
// is re-provisioned on their first subscription attempt or by the backfill.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type { LapsedStripeClient } from "./stripe-client";

export interface EnsureStripeCustomerResult {
  merchantId: string;
  stripeCustomerId: string;
  /** True when this call created the Stripe customer; false when it pre-existed. */
  created: boolean;
}

interface MerchantRow {
  id: string;
  shopify_shop_domain: string;
  stripe_customer_id: string | null;
}

/**
 * Ensures a merchant has a Stripe customer (decision 28). Returns the existing
 * `stripe_customer_id` untouched when one is already stored; otherwise creates
 * the Stripe customer and writes the id back to `merchants`.
 *
 * Throws on a DB error or a Stripe failure — the OAuth-callback caller catches
 * and logs `level:critical` so onboarding is never blocked. The backfill
 * caller counts the failure and continues to the next merchant.
 */
export async function ensureStripeCustomer(
  serviceClient: LapsedSupabaseClient,
  stripeClient: LapsedStripeClient,
  merchantId: string,
): Promise<EnsureStripeCustomerResult> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);

  const { data: merchant, error: readErr } = await serviceClient
    .from("merchants")
    .select("id, shopify_shop_domain, stripe_customer_id")
    .eq("id", merchantId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!merchant) {
    throw new Error(`ensureStripeCustomer: merchant ${merchantId} not found`);
  }
  const row = merchant as MerchantRow;

  // Already provisioned — no Stripe call, no write.
  if (row.stripe_customer_id) {
    return { merchantId, stripeCustomerId: row.stripe_customer_id, created: false };
  }

  // createCustomer is idempotency-keyed on the merchant id (decision 28) — a
  // concurrent onboarding callback resolves to the same Stripe customer.
  const { stripeCustomerId } = await stripeClient.createCustomer({
    id: row.id,
    shopDomain: row.shopify_shop_domain,
  });

  // `WHERE stripe_customer_id IS NULL` — first writer wins. Under a race the
  // second callback's write touches zero rows rather than overwriting the
  // (identical, idempotency-keyed) value already stored.
  const { error: writeErr } = await serviceClient
    .from("merchants")
    .update({ stripe_customer_id: stripeCustomerId })
    .eq("id", merchantId)
    .is("stripe_customer_id", null);
  if (writeErr) throw writeErr;

  return { merchantId, stripeCustomerId, created: true };
}

export interface BackfillStripeCustomersResult {
  /** Merchants examined (those with a null stripe_customer_id). */
  merchantsScanned: number;
  /** Stripe customers created this run. */
  customersCreated: number;
  /** Merchants whose provisioning threw — counted, skipped, run continues. */
  errors: number;
}

/**
 * One-shot backfill: provisions a Stripe customer for every pre-Sprint-09
 * merchant whose `stripe_customer_id` is still NULL. Per-merchant failures are
 * counted and skipped so a single bad merchant cannot abort the run; a re-run
 * is safe (ensureStripeCustomer is idempotent).
 */
export async function backfillStripeCustomers(
  serviceClient: LapsedSupabaseClient,
  stripeClient: LapsedStripeClient,
): Promise<BackfillStripeCustomersResult> {
  const result: BackfillStripeCustomersResult = {
    merchantsScanned: 0,
    customersCreated: 0,
    errors: 0,
  };

  const { data, error } = await serviceClient
    .from("merchants")
    .select("id")
    .is("stripe_customer_id", null);
  if (error) throw error;

  for (const m of (data ?? []) as Array<{ id: string }>) {
    result.merchantsScanned += 1;
    try {
      const r = await ensureStripeCustomer(serviceClient, stripeClient, m.id);
      if (r.created) result.customersCreated += 1;
    } catch (err) {
      result.errors += 1;
      console.error(
        JSON.stringify({
          event: "stripe_customer_backfill_error",
          level: "critical",
          merchant_id: m.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return result;
}
