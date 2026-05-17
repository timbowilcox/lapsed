// Stripe client wrapper tests — Sprint 09 chunk 5. A hand-mocked StripeSdkLike
// is injected; no real Stripe key or network call is made.

import { describe, expect, it, vi } from "vitest";
import {
  createStripeClient,
  isSubscriptionTier,
  SUBSCRIPTION_TIERS,
  StripeWebhookSignatureError,
  type StripeClientConfig,
  type StripeSdkLike,
  type StripeWebhookEvent,
} from "../src/stripe-client";

const CONFIG: StripeClientConfig = {
  secretKey: "sk_test_fake",
  webhookSecret: "whsec_fake",
  priceIds: { starter: "price_starter", growth: "price_growth", scale: "price_scale" },
};

const MERCHANT = { id: "550e8400-e29b-41d4-a716-446655440000", shopDomain: "demo.myshopify.com" };

/** A StripeSdkLike fake with vi.fn spies; callers override per test. */
function fakeSdk(overrides: Partial<StripeSdkLike> = {}): StripeSdkLike {
  return {
    customers: {
      create: vi.fn(async () => ({ id: "cus_fake" })),
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ id: "cs_fake", url: "https://checkout.stripe.com/c/fake" })),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async () => ({ url: "https://billing.stripe.com/p/fake" })),
      },
    },
    webhooks: {
      constructEvent: vi.fn((): StripeWebhookEvent => ({
        id: "evt_fake",
        type: "customer.subscription.updated",
        data: { object: {} },
      })),
    },
    ...overrides,
  };
}

describe("isSubscriptionTier", () => {
  it("accepts the three valid tiers and rejects everything else", () => {
    for (const t of SUBSCRIPTION_TIERS) expect(isSubscriptionTier(t)).toBe(true);
    for (const bad of ["enterprise", "", "Starter", null, undefined, 1]) {
      expect(isSubscriptionTier(bad)).toBe(false);
    }
  });
});

describe("createCustomer", () => {
  it("creates a customer with a merchant-deterministic idempotency key", async () => {
    const sdk = fakeSdk();
    const client = createStripeClient(CONFIG, sdk);
    const result = await client.createCustomer(MERCHANT);

    expect(result.stripeCustomerId).toBe("cus_fake");
    const call = (sdk.customers.create as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // Metadata carries the merchant identity.
    expect(call[0]).toMatchObject({
      metadata: { merchant_id: MERCHANT.id, shop_domain: MERCHANT.shopDomain },
    });
    // Idempotency key is deterministic on the merchant id (decision 28) — a
    // re-run of onboarding cannot create a duplicate customer.
    expect(call[1]).toEqual({ idempotencyKey: `lapsed-customer:${MERCHANT.id}` });
  });

  it("wraps a Stripe failure in StripeClientError, preserving the code", async () => {
    const sdk = fakeSdk({
      customers: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("rate limited"), { code: "rate_limit", type: "StripeRateLimitError" });
        }),
      },
    });
    const client = createStripeClient(CONFIG, sdk);
    await expect(client.createCustomer(MERCHANT)).rejects.toMatchObject({
      name: "StripeClientError",
      code: "rate_limit",
      stripeType: "StripeRateLimitError",
    });
  });
});

describe("createCheckoutSession", () => {
  it("creates a subscription session with Stripe Tax enabled and the tier price", async () => {
    const sdk = fakeSdk();
    const client = createStripeClient(CONFIG, sdk);
    const result = await client.createCheckoutSession(
      MERCHANT,
      "cus_fake",
      "growth",
      {
        successUrl: "https://app.lapsed.ai/app/billing/success",
        cancelUrl: "https://app.lapsed.ai/app/billing/subscribe",
      },
      "attempt-nonce-123",
    );

    expect(result.url).toBe("https://checkout.stripe.com/c/fake");
    const call = (sdk.checkout.sessions.create as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toMatchObject({
      mode: "subscription",
      customer: "cus_fake",
      line_items: [{ price: "price_growth", quantity: 1 }],
      automatic_tax: { enabled: true }, // decision 33
      billing_address_collection: "required",
      metadata: { merchant_id: MERCHANT.id, tier: "growth" },
    });
    // A caller-supplied per-attempt idempotency key is forwarded as-is.
    expect(call[1]).toEqual({ idempotencyKey: "attempt-nonce-123" });
  });

  it("omits the idempotency key when the caller supplies none", async () => {
    const sdk = fakeSdk();
    const client = createStripeClient(CONFIG, sdk);
    await client.createCheckoutSession(MERCHANT, "cus_fake", "starter", {
      successUrl: "https://x",
      cancelUrl: "https://y",
    });
    const call = (sdk.checkout.sessions.create as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1]).toBeUndefined();
  });

  it("throws when the session is created without a URL", async () => {
    const sdk = fakeSdk({
      checkout: { sessions: { create: vi.fn(async () => ({ id: "cs_fake", url: null })) } },
    });
    const client = createStripeClient(CONFIG, sdk);
    await expect(
      client.createCheckoutSession(MERCHANT, "cus_fake", "starter", {
        successUrl: "https://x",
        cancelUrl: "https://y",
      }),
    ).rejects.toThrow(/without a URL/);
  });

  it("wraps a Stripe API error from checkout.sessions.create, preserving the code", async () => {
    const sdk = fakeSdk({
      checkout: {
        sessions: {
          create: vi.fn(async () => {
            throw Object.assign(new Error("api down"), { code: "api_error", type: "StripeAPIError" });
          }),
        },
      },
    });
    const client = createStripeClient(CONFIG, sdk);
    await expect(
      client.createCheckoutSession(MERCHANT, "cus_fake", "growth", {
        successUrl: "https://x",
        cancelUrl: "https://y",
      }),
    ).rejects.toMatchObject({ name: "StripeClientError", code: "api_error" });
  });
});

describe("createPortalSession", () => {
  it("creates a portal session for the customer and returns the hosted URL", async () => {
    const sdk = fakeSdk();
    const client = createStripeClient(CONFIG, sdk);
    const result = await client.createPortalSession("cus_fake", "https://app.lapsed.ai/app/settings/billing");
    expect(result.url).toBe("https://billing.stripe.com/p/fake");
    const call = (sdk.billingPortal.sessions.create as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toMatchObject({
      customer: "cus_fake",
      return_url: "https://app.lapsed.ai/app/settings/billing",
    });
  });

  it("wraps a Stripe API error from billingPortal.sessions.create", async () => {
    const sdk = fakeSdk({
      billingPortal: {
        sessions: {
          create: vi.fn(async () => {
            throw Object.assign(new Error("portal not configured"), { code: "portal_config" });
          }),
        },
      },
    });
    const client = createStripeClient(CONFIG, sdk);
    await expect(
      client.createPortalSession("cus_fake", "https://app.lapsed.ai/app/settings/billing"),
    ).rejects.toMatchObject({ name: "StripeClientError", code: "portal_config" });
  });
});

describe("verifyWebhookEvent", () => {
  it("returns the parsed event when the signature verifies", () => {
    const sdk = fakeSdk();
    const client = createStripeClient(CONFIG, sdk);
    const event = client.verifyWebhookEvent("{}", "t=1,v1=validsig");
    expect(event.id).toBe("evt_fake");
    expect(event.type).toBe("customer.subscription.updated");
    // constructEvent received the RAW body and the webhook secret.
    expect((sdk.webhooks.constructEvent as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      "{}",
      "t=1,v1=validsig",
      "whsec_fake",
    ]);
  });

  it("throws StripeWebhookSignatureError when the signature header is absent", () => {
    const client = createStripeClient(CONFIG, fakeSdk());
    expect(() => client.verifyWebhookEvent("{}", null)).toThrow(StripeWebhookSignatureError);
  });

  it("throws StripeWebhookSignatureError when constructEvent rejects the signature", () => {
    const sdk = fakeSdk({
      webhooks: {
        constructEvent: vi.fn(() => {
          throw new Error("No signatures found matching the expected signature");
        }),
      },
    });
    const client = createStripeClient(CONFIG, sdk);
    expect(() => client.verifyWebhookEvent("{}", "t=1,v1=tampered")).toThrow(
      StripeWebhookSignatureError,
    );
  });
});

describe("StripeClientError", () => {
  it("is surfaced for an unconfigured tier price — and Stripe is never called", async () => {
    const sdk = fakeSdk();
    const client = createStripeClient(
      { ...CONFIG, priceIds: { starter: "", growth: "", scale: "" } },
      sdk,
    );
    await expect(
      client.createCheckoutSession(MERCHANT, "cus_fake", "scale", {
        successUrl: "https://x",
        cancelUrl: "https://y",
      }),
    ).rejects.toThrow(/tier scale is empty or unconfigured/);
    // The guard fires before any Stripe call — no session is created.
    expect((sdk.checkout.sessions.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("normalizes a non-object thrown value (no code/type) into a StripeClientError", async () => {
    const sdk = fakeSdk({
      customers: {
        create: vi.fn(async () => {
          throw "raw string failure"; // a primitive, not an Error
        }),
      },
    });
    const client = createStripeClient(CONFIG, sdk);
    await expect(client.createCustomer(MERCHANT)).rejects.toMatchObject({
      name: "StripeClientError",
      code: undefined,
      stripeType: undefined,
    });
    await expect(client.createCustomer(MERCHANT)).rejects.toThrow(/raw string failure/);
  });
});
