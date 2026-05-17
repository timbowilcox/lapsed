// Stripe webhook handler tests — Sprint 09 chunk 8.
//
// Signature verification is the ROUTE's job (and is tested in
// stripe-client.test.ts); these tests cover handleStripeWebhookEvent — the
// idempotent application of a verified event to the local mirror.

import { describe, expect, it } from "vitest";
import {
  handleStripeWebhookEvent,
  type StripeWebhookHandlerConfig,
} from "../src/stripe-webhook";
import type { StripeWebhookEvent } from "../src/stripe-client";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CUSTOMER = "cus_demo";
const SUB = "sub_demo";

const CONFIG: StripeWebhookHandlerConfig = {
  priceIds: { starter: "price_starter", growth: "price_growth", scale: "price_scale" },
};

const unix = (isoDay: string): number => Math.floor(new Date(isoDay).getTime() / 1000);

function subscriptionEvent(
  type: "customer.subscription.created" | "customer.subscription.updated" | "customer.subscription.deleted",
  opts: {
    eventId?: string;
    status?: string;
    priceId?: string;
    cancelAt?: number | null;
    canceledAt?: number | null;
    /** When true, place the period fields at the top level (older API shape). */
    topLevelPeriod?: boolean;
  } = {},
): StripeWebhookEvent {
  const periodStart = unix("2026-05-01");
  const periodEnd = unix("2026-06-01");
  // Recent Stripe API versions carry current_period_* on each item, not the
  // top-level Subscription object — the default fixture matches that shape.
  const item: Record<string, unknown> = { price: { id: opts.priceId ?? "price_growth" } };
  const object: Record<string, unknown> = {
    id: SUB,
    customer: CUSTOMER,
    status: opts.status ?? "active",
    cancel_at: opts.cancelAt ?? null,
    canceled_at: opts.canceledAt ?? null,
  };
  if (opts.topLevelPeriod) {
    object.current_period_start = periodStart;
    object.current_period_end = periodEnd;
  } else {
    item.current_period_start = periodStart;
    item.current_period_end = periodEnd;
  }
  object.items = { data: [item] };
  return { id: opts.eventId ?? "evt_1", type, data: { object } };
}

function invoiceEvent(
  type: "invoice.payment_succeeded" | "invoice.payment_failed",
  eventId = "evt_inv",
): StripeWebhookEvent {
  return {
    id: eventId,
    type,
    data: { object: { id: "in_demo", customer: CUSTOMER, subscription: SUB } },
  };
}

function seed(extra: { merchantSubscriptions?: FakeRow[] } = {}) {
  return makeFakeSupabase({
    merchants: [
      {
        id: MERCHANT,
        shopify_shop_domain: "demo.myshopify.com",
        stripe_customer_id: CUSTOMER,
        subscription_tier: null,
        subscription_status: null,
      },
    ],
    merchant_subscriptions: extra.merchantSubscriptions ?? [],
    subscription_events: [],
  });
}

describe("handleStripeWebhookEvent — subscription lifecycle", () => {
  it("customer.subscription.created upserts the mirror and caches tier/status on merchants", async () => {
    const { client, tables } = seed();
    const result = await handleStripeWebhookEvent(client, subscriptionEvent("customer.subscription.created"), CONFIG);

    expect(result.status).toBe("processed");
    expect(result.merchantId).toBe(MERCHANT);

    const sub = tables.merchant_subscriptions![0]!;
    expect(sub.merchant_id).toBe(MERCHANT);
    expect(sub.stripe_subscription_id).toBe(SUB);
    expect(sub.tier).toBe("growth");
    expect(sub.status).toBe("active");
    expect(sub.grace_period_started_at).toBeNull();

    const merchant = tables.merchants![0]!;
    expect(merchant.subscription_tier).toBe("growth");
    expect(merchant.subscription_status).toBe("active");

    // The event is recorded in the audit log.
    expect(tables.subscription_events).toHaveLength(1);
    expect(tables.subscription_events![0]!.stripe_event_id).toBe("evt_1");
  });

  it("customer.subscription.updated → past_due sets grace_period_started_at", async () => {
    const { client, tables } = seed();
    await handleStripeWebhookEvent(
      client,
      subscriptionEvent("customer.subscription.updated", { status: "past_due" }),
      CONFIG,
      { now: () => new Date("2026-05-20T00:00:00Z") },
    );
    const sub = tables.merchant_subscriptions![0]!;
    expect(sub.status).toBe("past_due");
    expect(sub.grace_period_started_at).toBe("2026-05-20T00:00:00.000Z");
    expect(tables.merchants![0]!.subscription_status).toBe("past_due");
  });

  it("maps a tier from the subscription's price id", async () => {
    const { client, tables } = seed();
    await handleStripeWebhookEvent(
      client,
      subscriptionEvent("customer.subscription.created", { priceId: "price_scale" }),
      CONFIG,
    );
    expect(tables.merchant_subscriptions![0]!.tier).toBe("scale");
  });

  it("reads current_period_* from the subscription item (recent Stripe API shape)", async () => {
    const { client, tables } = seed();
    await handleStripeWebhookEvent(client, subscriptionEvent("customer.subscription.created"), CONFIG);
    expect(tables.merchant_subscriptions![0]!.current_period_start).toBe("2026-05-01T00:00:00.000Z");
    expect(tables.merchant_subscriptions![0]!.current_period_end).toBe("2026-06-01T00:00:00.000Z");
  });

  it("falls back to top-level current_period_* for an older Stripe API shape", async () => {
    const { client, tables } = seed();
    await handleStripeWebhookEvent(
      client,
      subscriptionEvent("customer.subscription.created", { topLevelPeriod: true }),
      CONFIG,
    );
    // The mirror row is still written — the period was read from the top level.
    expect(tables.merchant_subscriptions).toHaveLength(1);
    expect(tables.merchant_subscriptions![0]!.current_period_start).toBe("2026-05-01T00:00:00.000Z");
  });

  it("maps trialing and unpaid Stripe statuses onto the mirror enum", async () => {
    const trial = seed();
    await handleStripeWebhookEvent(
      trial.client,
      subscriptionEvent("customer.subscription.created", { status: "trialing", eventId: "evt_t" }),
      CONFIG,
    );
    expect(trial.tables.merchant_subscriptions![0]!.status).toBe("trialing");

    const unpaid = seed();
    await handleStripeWebhookEvent(
      unpaid.client,
      subscriptionEvent("customer.subscription.updated", { status: "unpaid", eventId: "evt_u" }),
      CONFIG,
    );
    // `unpaid` collapses onto past_due.
    expect(unpaid.tables.merchant_subscriptions![0]!.status).toBe("past_due");
  });

  it("does NOT re-stamp grace_period_started_at on a repeated past_due update", async () => {
    // Decision 31: the 7-day grace window anchors at the FIRST failed payment.
    // A second past_due update (e.g. a metadata change) must preserve the
    // original grace start, not extend the window.
    const firstGrace = "2026-05-10T00:00:00.000Z";
    const { client, tables } = seed({
      merchantSubscriptions: [
        {
          merchant_id: MERCHANT,
          stripe_subscription_id: SUB,
          tier: "growth",
          status: "past_due",
          current_period_start: "2026-05-01T00:00:00.000Z",
          current_period_end: "2026-06-01T00:00:00.000Z",
          grace_period_started_at: firstGrace,
          cancel_at: null,
          canceled_at: null,
        },
      ],
    });
    await handleStripeWebhookEvent(
      client,
      subscriptionEvent("customer.subscription.updated", { status: "past_due", eventId: "evt_again" }),
      CONFIG,
      { now: () => new Date("2026-05-25T00:00:00Z") }, // a much later clock
    );
    // The grace start is unchanged — the window was not silently extended.
    expect(tables.merchant_subscriptions![0]!.grace_period_started_at).toBe(firstGrace);
  });

  it("customer.subscription.deleted marks the mirror canceled", async () => {
    const { client, tables } = seed({
      merchantSubscriptions: [
        {
          merchant_id: MERCHANT,
          stripe_subscription_id: SUB,
          tier: "growth",
          status: "active",
          current_period_start: "2026-05-01T00:00:00.000Z",
          current_period_end: "2026-06-01T00:00:00.000Z",
          grace_period_started_at: null,
          cancel_at: null,
          canceled_at: null,
        },
      ],
    });
    await handleStripeWebhookEvent(
      client,
      subscriptionEvent("customer.subscription.deleted", { eventId: "evt_del" }),
      CONFIG,
    );
    expect(tables.merchant_subscriptions![0]!.status).toBe("canceled");
    expect(tables.merchant_subscriptions![0]!.canceled_at).not.toBeNull();
    expect(tables.merchants![0]!.subscription_status).toBe("canceled");
  });

  it("does not write a CHECK-invalid mirror row for an `incomplete` subscription", async () => {
    const { client, tables } = seed();
    const result = await handleStripeWebhookEvent(
      client,
      subscriptionEvent("customer.subscription.created", { status: "incomplete" }),
      CONFIG,
    );
    // Event recorded, but no mirror row (incomplete maps to null status).
    expect(result.status).toBe("processed");
    expect(tables.subscription_events).toHaveLength(1);
    expect(tables.merchant_subscriptions ?? []).toHaveLength(0);
  });
});

describe("handleStripeWebhookEvent — invoice events", () => {
  it("invoice.payment_succeeded clears grace_period_started_at", async () => {
    const { client, tables } = seed({
      merchantSubscriptions: [
        {
          merchant_id: MERCHANT,
          stripe_subscription_id: SUB,
          tier: "growth",
          status: "past_due",
          current_period_start: "2026-05-01T00:00:00.000Z",
          current_period_end: "2026-06-01T00:00:00.000Z",
          grace_period_started_at: "2026-05-15T00:00:00.000Z",
          cancel_at: null,
          canceled_at: null,
        },
      ],
    });
    await handleStripeWebhookEvent(client, invoiceEvent("invoice.payment_succeeded"), CONFIG);
    expect(tables.merchant_subscriptions![0]!.grace_period_started_at).toBeNull();
  });

  it("invoice.payment_failed records the event but changes no mirror state", async () => {
    const { client, tables } = seed({
      merchantSubscriptions: [
        {
          merchant_id: MERCHANT,
          stripe_subscription_id: SUB,
          tier: "growth",
          status: "active",
          current_period_start: "2026-05-01T00:00:00.000Z",
          current_period_end: "2026-06-01T00:00:00.000Z",
          grace_period_started_at: null,
          cancel_at: null,
          canceled_at: null,
        },
      ],
    });
    const result = await handleStripeWebhookEvent(
      client,
      invoiceEvent("invoice.payment_failed"),
      CONFIG,
    );
    expect(result.status).toBe("processed");
    expect(tables.subscription_events).toHaveLength(1);
    // The paired subscription.updated carries the transition — status untouched here.
    expect(tables.merchant_subscriptions![0]!.status).toBe("active");
  });
});

describe("handleStripeWebhookEvent — idempotency + edge cases", () => {
  it("is idempotent — a re-delivered event id is a no-op", async () => {
    const { client, tables } = seed();
    const event = subscriptionEvent("customer.subscription.created", { eventId: "evt_dup" });

    const first = await handleStripeWebhookEvent(client, event, CONFIG);
    expect(first.status).toBe("processed");

    const second = await handleStripeWebhookEvent(client, event, CONFIG);
    expect(second.status).toBe("duplicate");

    // Exactly one audit row, one mirror row — no double application.
    expect(tables.subscription_events).toHaveLength(1);
    expect(tables.merchant_subscriptions).toHaveLength(1);
  });

  it("returns `ignored` for an unhandled event type and writes nothing", async () => {
    const { client, tables } = seed();
    const result = await handleStripeWebhookEvent(
      client,
      { id: "evt_x", type: "customer.updated", data: { object: { customer: CUSTOMER } } },
      CONFIG,
    );
    expect(result.status).toBe("ignored");
    expect(tables.subscription_events ?? []).toHaveLength(0);
    expect(tables.merchant_subscriptions ?? []).toHaveLength(0);
  });

  it("returns `no_merchant` when the Stripe customer matches no merchant", async () => {
    const { client, tables } = seed();
    const event = subscriptionEvent("customer.subscription.created");
    event.data.object.customer = "cus_unknown";
    const result = await handleStripeWebhookEvent(client, event, CONFIG);
    expect(result.status).toBe("no_merchant");
    expect(tables.subscription_events ?? []).toHaveLength(0);
  });
});
