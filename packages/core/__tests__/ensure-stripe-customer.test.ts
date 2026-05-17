// Merchant Stripe customer provisioning tests — Sprint 09 chunk 6.

import { describe, expect, it, vi } from "vitest";
import {
  ensureStripeCustomer,
  backfillStripeCustomers,
} from "../src/ensure-stripe-customer";
import type { LapsedStripeClient } from "../src/stripe-client";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const M1 = "550e8400-e29b-41d4-a716-446655440000";
const M2 = "660e8400-e29b-41d4-a716-446655440000";

/** A fake LapsedStripeClient whose createCustomer returns cus_<merchantId>. */
function fakeStripe(overrides: Partial<LapsedStripeClient> = {}): LapsedStripeClient {
  return {
    createCustomer: vi.fn(async (merchant) => ({ stripeCustomerId: `cus_${merchant.id}` })),
    createCheckoutSession: vi.fn(),
    createPortalSession: vi.fn(),
    verifyWebhookEvent: vi.fn(),
    ...overrides,
  } as unknown as LapsedStripeClient;
}

function merchant(id: string, stripeCustomerId: string | null): FakeRow {
  return {
    id,
    shopify_shop_domain: `shop-${id}.myshopify.com`,
    stripe_customer_id: stripeCustomerId,
  };
}

describe("ensureStripeCustomer", () => {
  it("creates a Stripe customer and writes the id back when none exists", async () => {
    const { client, tables } = makeFakeSupabase({ merchants: [merchant(M1, null)] });
    const stripe = fakeStripe();
    const result = await ensureStripeCustomer(client, stripe, M1);

    expect(result).toEqual({ merchantId: M1, stripeCustomerId: `cus_${M1}`, created: true });
    expect(tables.merchants![0]!.stripe_customer_id).toBe(`cus_${M1}`);
    expect((stripe.createCustomer as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("is a no-op when the merchant already has a Stripe customer id", async () => {
    const { client } = makeFakeSupabase({ merchants: [merchant(M1, "cus_existing")] });
    const stripe = fakeStripe();
    const result = await ensureStripeCustomer(client, stripe, M1);

    expect(result).toEqual({ merchantId: M1, stripeCustomerId: "cus_existing", created: false });
    // No Stripe call is made when the id is already present (decision 28 idempotency).
    expect((stripe.createCustomer as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("throws when the merchant does not exist", async () => {
    const { client } = makeFakeSupabase({ merchants: [] });
    await expect(ensureStripeCustomer(client, fakeStripe(), M1)).rejects.toThrow(/not found/);
  });

  it("rejects a non-UUID merchant id before any query", async () => {
    const { client } = makeFakeSupabase({ merchants: [] });
    await expect(ensureStripeCustomer(client, fakeStripe(), "not-a-uuid")).rejects.toThrow(
      /must be a UUID/,
    );
  });

  it("propagates a Stripe failure (the OAuth callback catches + logs critical)", async () => {
    const { client } = makeFakeSupabase({ merchants: [merchant(M1, null)] });
    const stripe = fakeStripe({
      createCustomer: vi.fn(async () => {
        throw new Error("stripe down");
      }),
    });
    await expect(ensureStripeCustomer(client, stripe, M1)).rejects.toThrow(/stripe down/);
  });

  it("propagates a DB write-back failure (Stripe customer created, local write failed)", async () => {
    // The orphaned-customer failure mode: createCustomer succeeded but the
    // merchants UPDATE errors. The error must surface, never be swallowed.
    const { client } = makeFakeSupabase(
      { merchants: [merchant(M1, null)] },
      { failOn: [{ table: "merchants", op: "update" }] },
    );
    await expect(ensureStripeCustomer(client, fakeStripe(), M1)).rejects.toThrow(/fake error/);
  });
});

describe("backfillStripeCustomers", () => {
  it("provisions a Stripe customer for every merchant with a null id", async () => {
    const { client, tables } = makeFakeSupabase({
      merchants: [merchant(M1, null), merchant(M2, null)],
    });
    const stripe = fakeStripe();
    const result = await backfillStripeCustomers(client, stripe);

    expect(result.merchantsScanned).toBe(2);
    expect(result.customersCreated).toBe(2);
    expect(result.errors).toBe(0);
    for (const m of tables.merchants!) {
      expect(m.stripe_customer_id).toBe(`cus_${m.id}`);
    }
  });

  it("skips merchants that already have a Stripe customer id", async () => {
    const { client } = makeFakeSupabase({
      merchants: [merchant(M1, "cus_existing"), merchant(M2, null)],
    });
    const stripe = fakeStripe();
    const result = await backfillStripeCustomers(client, stripe);
    // Only M2 (null id) is scanned — the .is(null) filter excludes M1.
    expect(result.merchantsScanned).toBe(1);
    expect(result.customersCreated).toBe(1);
  });

  it("counts a per-merchant failure and continues to the next merchant", async () => {
    const { client, tables } = makeFakeSupabase({
      merchants: [merchant(M1, null), merchant(M2, null)],
    });
    let calls = 0;
    const stripe = fakeStripe({
      createCustomer: vi.fn(async (m) => {
        calls += 1;
        if (calls === 1) throw new Error("transient stripe error");
        return { stripeCustomerId: `cus_${m.id}` };
      }),
    });
    const result = await backfillStripeCustomers(client, stripe);

    expect(result.merchantsScanned).toBe(2);
    expect(result.customersCreated).toBe(1); // one succeeded
    expect(result.errors).toBe(1); // one failed — run did not abort
    // The successful merchant has its id; both rows were examined.
    expect(tables.merchants!.filter((m) => m.stripe_customer_id !== null)).toHaveLength(1);
  });
});
