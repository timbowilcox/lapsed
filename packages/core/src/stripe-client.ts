// Stripe client wrapper — the SINGLE seam between lapsed.ai and Stripe.
// Implements Sprint 09 chunk 5. No other module in the codebase imports the
// `stripe` SDK directly; everything routes through this wrapper.
//
// Responsibilities:
//   - createCustomer        — a Stripe customer per merchant (decision 28),
//                             idempotency-keyed on the merchant id so a
//                             re-run of onboarding never duplicates a customer
//   - createCheckoutSession — a Stripe-hosted subscription checkout, with
//                             Stripe Tax enabled (decision 33)
//   - createPortalSession   — a Stripe-hosted customer portal session
//   - verifyWebhookEvent    — signature-verified webhook parse (decision 32)
//
// CONFIG. Driven by StripeClientConfig (secret key + webhook secret + the
// three tier price ids). The apps/web routes read these from billingEnv() and
// pass them in — core stays env-agnostic, consistent with twilio-client.
//
// WEBHOOK VERIFICATION. SPRINT.md chunk 5 lists `validateWebhookSignature` and
// `parseWebhookEvent` as separate exports. Stripe's `webhooks.constructEvent`
// verifies the signature against the RAW body and parses in one atomic step —
// it is impossible (and unsafe) to parse without verifying first. The two are
// therefore merged into `verifyWebhookEvent`, which verifies-then-parses and
// throws `StripeWebhookSignatureError` on a bad signature. The chunk-8 route
// calls it on the raw body before any JSON.parse — satisfying "signature
// validated BEFORE body parsing" (decision 32). This deviation is recorded in
// HANDOFF.md.
//
// TESTABILITY. The real `stripe` SDK is constructed lazily inside the factory;
// unit tests inject a `StripeSdkLike` fake. Real keys are runtime-only.

import Stripe from "stripe";

/** The three flat subscription tiers. */
export type SubscriptionTier = "starter" | "growth" | "scale";

/** Canonical ordered tier list — the single source of truth for validation. */
export const SUBSCRIPTION_TIERS: readonly SubscriptionTier[] = ["starter", "growth", "scale"];

/** Narrowing guard for an untrusted tier string (e.g. a request body). */
export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return typeof value === "string" && (SUBSCRIPTION_TIERS as readonly string[]).includes(value);
}

export interface StripeClientConfig {
  /** Stripe secret key — test-mode (sk_test_...) for Sprint 09. */
  secretKey: string;
  /** Stripe webhook signing secret (whsec_...) for signature verification. */
  webhookSecret: string;
  /** Stripe Price id per tier (price_...). */
  priceIds: Record<SubscriptionTier, string>;
}

/** A merchant identity slice the billing seam needs — never the whole row. */
export interface MerchantBillingRef {
  /** merchants.id (uuid). */
  id: string;
  /** merchants.shopify_shop_domain. */
  shopDomain: string;
}

export interface CheckoutReturnUrls {
  successUrl: string;
  cancelUrl: string;
}

/** A signature-verified Stripe webhook event, narrowed to what we consume. */
export interface StripeWebhookEvent {
  /** Stripe event id (evt_...) — the idempotency dedup key (decision 32). */
  id: string;
  /** e.g. "customer.subscription.updated", "invoice.payment_failed". */
  type: string;
  /** The event's primary object (a Subscription, Invoice, etc.). */
  data: { object: Record<string, unknown> };
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured errors
// ─────────────────────────────────────────────────────────────────────────────

/** A Stripe API failure, with the Stripe error code/type preserved. */
export class StripeClientError extends Error {
  readonly code: string | undefined;
  readonly stripeType: string | undefined;
  constructor(message: string, opts: { code?: string; stripeType?: string; cause?: unknown }) {
    super(message);
    this.name = "StripeClientError";
    this.code = opts.code;
    this.stripeType = opts.stripeType;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** A webhook whose signature did not verify — the chunk-8 route returns 400. */
export class StripeWebhookSignatureError extends Error {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message);
    this.name = "StripeWebhookSignatureError";
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** Wraps an unknown thrown value into a StripeClientError, preserving codes. */
function asStripeClientError(operation: string, err: unknown): StripeClientError {
  const e = err as { message?: unknown; code?: unknown; type?: unknown };
  return new StripeClientError(`stripe ${operation} failed: ${String(e?.message ?? err)}`, {
    code: typeof e?.code === "string" ? e.code : undefined,
    stripeType: typeof e?.type === "string" ? e.type : undefined,
    cause: err,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal injectable SDK surface
//
// Only the slice of the Stripe SDK this wrapper uses — so unit tests inject a
// fake without constructing a real client, and the seam stays thin.
// ─────────────────────────────────────────────────────────────────────────────

export interface StripeCustomerCreateParams {
  name?: string;
  email?: string;
  metadata?: Record<string, string>;
}

export interface StripeCheckoutCreateParams {
  mode: "subscription";
  customer: string;
  line_items: Array<{ price: string; quantity: number }>;
  success_url: string;
  cancel_url: string;
  automatic_tax: { enabled: boolean };
  billing_address_collection: "required";
  customer_update: { address: "auto" };
  metadata: Record<string, string>;
}

export interface StripePortalCreateParams {
  customer: string;
  return_url: string;
}

export interface StripeSdkLike {
  customers: {
    create(
      params: StripeCustomerCreateParams,
      opts?: { idempotencyKey?: string },
    ): Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create(
        params: StripeCheckoutCreateParams,
        opts?: { idempotencyKey?: string },
      ): Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: StripePortalCreateParams): Promise<{ url: string }>;
    };
  };
  webhooks: {
    constructEvent(body: string, signature: string, secret: string): StripeWebhookEvent;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The wrapper
// ─────────────────────────────────────────────────────────────────────────────

export interface LapsedStripeClient {
  /**
   * Creates a Stripe customer for a merchant (decision 28). Idempotency-keyed
   * on the merchant id — a re-run returns the SAME Stripe customer rather than
   * creating a duplicate. Returns the new `cus_...` id.
   */
  createCustomer(merchant: MerchantBillingRef): Promise<{ stripeCustomerId: string }>;
  /**
   * Creates a Stripe-hosted subscription Checkout session for a tier, with
   * Stripe Tax enabled and billing-address collection on (decision 33).
   * Returns the hosted session URL.
   *
   * `idempotencyKey` is OPTIONAL and caller-supplied per checkout attempt — the
   * chunk-7 route generates a fresh one per request. It deliberately is NOT
   * derived from (merchant, tier): a static key would, within Stripe's 24h
   * idempotency window, replay an earlier — possibly expired or already
   * completed — Checkout Session to a merchant who abandoned and retried,
   * handing them a dead URL. A per-attempt key guards a double-submitted
   * request without that 24h trap. (Customer creation, by contrast, MUST use a
   * deterministic key — a duplicate customer is the real hazard there.)
   */
  createCheckoutSession(
    merchant: MerchantBillingRef,
    stripeCustomerId: string,
    tier: SubscriptionTier,
    urls: CheckoutReturnUrls,
    idempotencyKey?: string,
  ): Promise<{ sessionId: string; url: string }>;
  /**
   * Creates a Stripe Customer Portal session for self-service tier changes,
   * payment-method updates, and cancellation. Returns the hosted portal URL.
   */
  createPortalSession(
    stripeCustomerId: string,
    returnUrl: string,
  ): Promise<{ url: string }>;
  /**
   * Verifies a webhook's Stripe signature against the raw body and returns the
   * parsed event. Throws StripeWebhookSignatureError on a bad/absent signature
   * — the signature is checked BEFORE the body is parsed (decision 32).
   */
  verifyWebhookEvent(rawBody: string, signatureHeader: string | null): StripeWebhookEvent;
}

/**
 * Pinned Stripe API version. MUST match the installed `stripe` SDK's
 * `LatestApiVersion` — the SDK's response deserializers are generated against
 * exactly this version. `stripe@17.7.0` ships `2025-02-24.acacia`. When the
 * SDK is bumped, update this string to the new `LatestApiVersion`. It is typed
 * as the literal (no cast) so a mismatch fails the build.
 */
const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2025-02-24.acacia";

/**
 * Builds the Stripe seam. In production `sdk` is omitted and the real `stripe`
 * SDK is constructed from `config.secretKey` (with built-in network retries).
 * Unit tests pass a `StripeSdkLike` fake.
 */
export function createStripeClient(
  config: StripeClientConfig,
  sdk?: StripeSdkLike,
): LapsedStripeClient {
  const client: StripeSdkLike =
    sdk ??
    // `as unknown as` is required, not lazy: Stripe's own `Event.data.object`
    // is a wide discriminated union of SDK resource types, none of which carry
    // a `string` index signature — so the real SDK is not *structurally*
    // assignable to the narrowed StripeSdkLike (whose webhook object is a plain
    // Record). The narrowed interface is the deliberate seam; the wrapper's own
    // exported methods stay fully typed for every caller.
    (new Stripe(config.secretKey, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      timeout: 20_000,
    }) as unknown as StripeSdkLike);

  return {
    async createCustomer(merchant) {
      try {
        const customer = await client.customers.create(
          {
            name: merchant.shopDomain,
            metadata: { merchant_id: merchant.id, shop_domain: merchant.shopDomain },
          },
          // Deterministic key → a re-run of onboarding returns the same
          // customer instead of creating a duplicate (decision 28).
          { idempotencyKey: `lapsed-customer:${merchant.id}` },
        );
        return { stripeCustomerId: customer.id };
      } catch (err) {
        throw asStripeClientError("customers.create", err);
      }
    },

    async createCheckoutSession(merchant, stripeCustomerId, tier, urls, idempotencyKey) {
      const priceId = config.priceIds[tier];
      if (!priceId) {
        throw new StripeClientError(
          `Stripe price id for tier ${tier} is empty or unconfigured`,
          {},
        );
      }
      try {
        const session = await client.checkout.sessions.create(
          {
            mode: "subscription",
            customer: stripeCustomerId,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: urls.successUrl,
            cancel_url: urls.cancelUrl,
            // Decision 33 — Stripe Tax computes GST/VAT/sales tax automatically
            // from the billing address collected at checkout.
            automatic_tax: { enabled: true },
            billing_address_collection: "required",
            customer_update: { address: "auto" },
            metadata: { merchant_id: merchant.id, tier },
          },
          idempotencyKey ? { idempotencyKey } : undefined,
        );
        if (!session.url) {
          throw new StripeClientError("checkout session created without a URL", {});
        }
        return { sessionId: session.id, url: session.url };
      } catch (err) {
        if (err instanceof StripeClientError) throw err;
        throw asStripeClientError("checkout.sessions.create", err);
      }
    },

    async createPortalSession(stripeCustomerId, returnUrl) {
      try {
        const session = await client.billingPortal.sessions.create({
          customer: stripeCustomerId,
          return_url: returnUrl,
        });
        return { url: session.url };
      } catch (err) {
        throw asStripeClientError("billingPortal.sessions.create", err);
      }
    },

    verifyWebhookEvent(rawBody, signatureHeader) {
      if (!signatureHeader) {
        throw new StripeWebhookSignatureError("missing Stripe-Signature header");
      }
      try {
        // constructEvent verifies the HMAC signature against the raw bytes and
        // ONLY THEN parses — verification strictly precedes parsing.
        return client.webhooks.constructEvent(rawBody, signatureHeader, config.webhookSecret);
      } catch (err) {
        throw new StripeWebhookSignatureError(
          `Stripe webhook signature verification failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    },
  };
}
