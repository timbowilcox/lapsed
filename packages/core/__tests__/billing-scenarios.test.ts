// Constructed billing scenarios — Sprint 09 chunk 12. The flow-defensibility
// gate for subscription billing: the chunk-5..11 modules are exercised
// end-to-end across full subscription lifecycles with known expected states.
//
// Scenarios:
//   1. Stripe customer creation idempotency
//   2. Subscription lifecycle — create → upgrade → downgrade → cancel
//   3. Failed payment → grace → recovery
//   4. Failed payment → grace expiry → suspension
//   5. Webhook idempotency (same event id twice)
//   6. Webhook signature validation (tampered = rejected)
//   7. Entitlements per tier + suspended forces read-only
//
// The Stripe SDK is a hand-mocked StripeSdkLike — no real key, no network.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStripeClient,
  StripeWebhookSignatureError,
  type StripeClientConfig,
  type StripeSdkLike,
  type StripeWebhookEvent,
} from "../src/stripe-client";
import { ensureStripeCustomer } from "../src/ensure-stripe-customer";
import { handleStripeWebhookEvent, type StripeWebhookHandlerConfig } from "../src/stripe-webhook";
import { runBillingGraceSweep } from "../src/billing-grace";
import { getMerchantEntitlements, _clearEntitlementsCache } from "../src/entitlements";
import { TIER_PLANS } from "../src/subscription-tiers";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

beforeEach(() => _clearEntitlementsCache());

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CUSTOMER = "cus_scenario";
const SUB = "sub_scenario";

const PRICE_IDS = { starter: "price_starter", growth: "price_growth", scale: "price_scale" };
const WEBHOOK_CONFIG: StripeWebhookHandlerConfig = { priceIds: PRICE_IDS };
const STRIPE_CONFIG: StripeClientConfig = {
  secretKey: "sk_test_x",
  webhookSecret: "whsec_x",
  priceIds: PRICE_IDS,
};

const unix = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

/** Builds a customer.subscription.* webhook event (recent item-shaped period). */
function subEvent(
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted",
  opts: { eventId: string; tier?: keyof typeof PRICE_IDS; status?: string },
): StripeWebhookEvent {
  return {
    id: opts.eventId,
    type,
    data: {
      object: {
        id: SUB,
        customer: CUSTOMER,
        status: opts.status ?? "active",
        cancel_at: null,
        canceled_at: type === "customer.subscription.deleted" ? unix("2026-05-20") : null,
        items: {
          data: [
            {
              price: { id: PRICE_IDS[opts.tier ?? "growth"] },
              current_period_start: unix("2026-05-01"),
              current_period_end: unix("2026-06-01"),
            },
          ],
        },
      },
    },
  };
}

function invoiceEvent(
  type: "invoice.payment_succeeded" | "invoice.payment_failed",
  eventId: string,
): StripeWebhookEvent {
  return {
    id: eventId,
    type,
    data: { object: { id: "in_x", customer: CUSTOMER, subscription: SUB } },
  };
}

/** A merchant with a Stripe customer already provisioned. */
function seedMerchant(extra: Record<string, FakeRow[]> = {}) {
  return makeFakeSupabase({
    merchants: [
      {
        id: MERCHANT,
        shopify_shop_domain: "scenario.myshopify.com",
        stripe_customer_id: CUSTOMER,
        subscription_tier: null,
        subscription_status: null,
      },
    ],
    merchant_subscriptions: [],
    subscription_events: [],
    ...extra,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Stripe customer creation idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 1 — Stripe customer creation idempotency", () => {
  it("provisions exactly one Stripe customer across repeated onboarding", async () => {
    const { client } = makeFakeSupabase({
      merchants: [
        { id: MERCHANT, shopify_shop_domain: "s.myshopify.com", stripe_customer_id: null },
      ],
    });
    const createCustomer = vi.fn(async () => ({ stripeCustomerId: CUSTOMER }));
    const stripe = { createCustomer } as unknown as Parameters<typeof ensureStripeCustomer>[1];

    const first = await ensureStripeCustomer(client, stripe, MERCHANT);
    const second = await ensureStripeCustomer(client, stripe, MERCHANT);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false); // already provisioned — no second call
    expect(first.stripeCustomerId).toBe(second.stripeCustomerId);
    expect(createCustomer).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — subscription lifecycle: create → upgrade → downgrade → cancel
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 2 — subscription lifecycle", () => {
  it("tracks tier + entitlements through create, upgrade, downgrade, cancel", async () => {
    const { client, tables } = seedMerchant();

    // create → growth/active
    await handleStripeWebhookEvent(client, subEvent("customer.subscription.created", { eventId: "e1", tier: "growth" }), WEBHOOK_CONFIG);
    let ent = await getMerchantEntitlements(client, MERCHANT);
    expect(ent.tier).toBe("growth");
    expect(ent.writesAllowed).toBe(true);
    expect(ent.maxSendsPerMonth).toBe(TIER_PLANS.growth.maxSendsPerMonth);

    // upgrade → scale
    await handleStripeWebhookEvent(client, subEvent("customer.subscription.updated", { eventId: "e2", tier: "scale" }), WEBHOOK_CONFIG);
    ent = await getMerchantEntitlements(client, MERCHANT);
    expect(ent.tier).toBe("scale");
    expect(ent.maxCampaignsPerMonth).toBe(TIER_PLANS.scale.maxCampaignsPerMonth);

    // downgrade → starter
    await handleStripeWebhookEvent(client, subEvent("customer.subscription.updated", { eventId: "e3", tier: "starter" }), WEBHOOK_CONFIG);
    ent = await getMerchantEntitlements(client, MERCHANT);
    expect(ent.tier).toBe("starter");

    // cancel
    await handleStripeWebhookEvent(client, subEvent("customer.subscription.deleted", { eventId: "e4" }), WEBHOOK_CONFIG);
    ent = await getMerchantEntitlements(client, MERCHANT);
    expect(ent.writesAllowed).toBe(false); // canceled → read-only
    expect(tables.merchant_subscriptions![0]!.status).toBe("canceled");
    // Every lifecycle event is in the audit log.
    expect(tables.subscription_events).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — failed payment → grace → recovery
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 3 — failed payment, grace, recovery", () => {
  it("stamps grace on past_due, keeps access in grace, clears grace on recovery", async () => {
    const { client, tables } = seedMerchant();
    await handleStripeWebhookEvent(client, subEvent("customer.subscription.created", { eventId: "c1", tier: "growth" }), WEBHOOK_CONFIG);

    // Payment fails → subscription goes past_due → grace window stamped.
    await handleStripeWebhookEvent(
      client,
      subEvent("customer.subscription.updated", { eventId: "c2", tier: "growth", status: "past_due" }),
      WEBHOOK_CONFIG,
      { now: () => new Date("2026-05-10T00:00:00Z") },
    );
    expect(tables.merchant_subscriptions![0]!.grace_period_started_at).toBe("2026-05-10T00:00:00.000Z");
    // In grace, the merchant still has full write access (decision 31).
    const inGrace = await getMerchantEntitlements(client, MERCHANT);
    expect(inGrace.writesAllowed).toBe(true);

    // Payment recovers → invoice.payment_succeeded clears the grace window...
    await handleStripeWebhookEvent(client, invoiceEvent("invoice.payment_succeeded", "c3"), WEBHOOK_CONFIG);
    expect(tables.merchant_subscriptions![0]!.grace_period_started_at).toBeNull();

    // ...and the paired subscription.updated → active completes the recovery.
    await handleStripeWebhookEvent(
      client,
      subEvent("customer.subscription.updated", { eventId: "c4", tier: "growth", status: "active" }),
      WEBHOOK_CONFIG,
    );
    expect(tables.merchant_subscriptions![0]!.status).toBe("active");
    const recovered = await getMerchantEntitlements(client, MERCHANT);
    expect(recovered.writesAllowed).toBe(true);
    expect(recovered.tier).toBe("growth");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — failed payment → grace expiry → suspension
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 4 — grace expiry → suspension", () => {
  it("suspends after the grace window and drops entitlements to read-only", async () => {
    const { client, tables } = seedMerchant();
    await handleStripeWebhookEvent(client, subEvent("customer.subscription.created", { eventId: "g1", tier: "growth" }), WEBHOOK_CONFIG);
    await handleStripeWebhookEvent(
      client,
      subEvent("customer.subscription.updated", { eventId: "g2", tier: "growth", status: "past_due" }),
      WEBHOOK_CONFIG,
      { now: () => new Date("2026-05-10T00:00:00Z") },
    );

    // The grace cron runs 8 days later — past the 7-day window.
    const sweep = await runBillingGraceSweep(client, {
      gracePeriodDays: 7,
      now: () => new Date("2026-05-18T07:00:00Z"),
    });
    expect(sweep.suspended).toBe(1);
    expect(tables.merchants![0]!.subscription_status).toBe("suspended");

    // Entitlements are now read-only — no new sends, no new approvals.
    const ent = await getMerchantEntitlements(client, MERCHANT, { skipCache: true });
    expect(ent.writesAllowed).toBe(false);
    expect(ent.maxSendsPerMonth).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — webhook idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 5 — webhook idempotency", () => {
  it("processing the same Stripe event id twice yields one row, one state", async () => {
    const { client, tables } = seedMerchant();
    const event = subEvent("customer.subscription.created", { eventId: "dup-evt", tier: "growth" });

    const first = await handleStripeWebhookEvent(client, event, WEBHOOK_CONFIG);
    const second = await handleStripeWebhookEvent(client, event, WEBHOOK_CONFIG);

    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect(tables.subscription_events).toHaveLength(1);
    expect(tables.merchant_subscriptions).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — webhook signature validation
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 6 — webhook signature validation", () => {
  function sdkWith(constructEvent: StripeSdkLike["webhooks"]["constructEvent"]): StripeSdkLike {
    return {
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent },
    } as unknown as StripeSdkLike;
  }

  it("rejects a tampered signature (the route would return 400, no DB writes)", async () => {
    const stripe = createStripeClient(
      STRIPE_CONFIG,
      sdkWith(() => {
        throw new Error("No signatures found matching the expected signature for payload");
      }),
    );
    expect(() => stripe.verifyWebhookEvent("{}", "t=1,v1=tampered")).toThrow(
      StripeWebhookSignatureError,
    );
  });

  it("accepts a valid signature and returns the parsed event", async () => {
    const stripe = createStripeClient(
      STRIPE_CONFIG,
      sdkWith(() => ({ id: "evt_ok", type: "customer.subscription.updated", data: { object: {} } })),
    );
    const event = stripe.verifyWebhookEvent("{}", "t=1,v1=valid");
    expect(event.id).toBe("evt_ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7 — entitlements per tier + suspended read-only
// ─────────────────────────────────────────────────────────────────────────────

describe("Scenario 7 — entitlements per tier", () => {
  for (const tier of ["starter", "growth", "scale"] as const) {
    it(`active ${tier} subscription grants the ${tier} tier's limits`, async () => {
      const { client } = makeFakeSupabase({
        merchants: [
          {
            id: MERCHANT,
            shopify_shop_domain: "s.myshopify.com",
            stripe_customer_id: CUSTOMER,
            subscription_tier: tier,
            subscription_status: "active",
          },
        ],
      });
      const ent = await getMerchantEntitlements(client, MERCHANT, { skipCache: true });
      expect(ent.maxCampaignsPerMonth).toBe(TIER_PLANS[tier].maxCampaignsPerMonth);
      expect(ent.maxSendsPerMonth).toBe(TIER_PLANS[tier].maxSendsPerMonth);
      expect(ent.writesAllowed).toBe(true);
    });
  }

  it("a suspended merchant is read-only regardless of tier", async () => {
    const { client } = makeFakeSupabase({
      merchants: [
        {
          id: MERCHANT,
          shopify_shop_domain: "s.myshopify.com",
          stripe_customer_id: CUSTOMER,
          subscription_tier: "scale",
          subscription_status: "suspended",
        },
      ],
    });
    const ent = await getMerchantEntitlements(client, MERCHANT, { skipCache: true });
    expect(ent.writesAllowed).toBe(false);
    expect(ent.maxCampaignsPerMonth).toBe(0);
    expect(ent.canExportData).toBe(false);
  });
});
