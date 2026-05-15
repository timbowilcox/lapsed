/**
 * Unit tests for appendCustomerEvent and appendOrderEvent helpers.
 *
 * Verifies Zod validation (rejects bad input), correct DB call shape,
 * and that ignoreDuplicates is passed through to the upsert.
 */

import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { appendCustomerEvent, appendOrderEvent } from "../src/customer-events";

// ─────────────────────────────────────────────────────────────────────────────
// Mock Supabase client
// ─────────────────────────────────────────────────────────────────────────────

type UpsertCall = {
  table: string;
  row: Record<string, unknown>;
  opts: unknown;
};

function makeMockClient(upsertError?: { message: string }) {
  const upserts: UpsertCall[] = [];

  const client = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn((row: Record<string, unknown>, opts: unknown) => {
        upserts.push({ table, row, opts });
        return Promise.resolve(
          upsertError ? { data: null, error: upsertError } : { data: null, error: null },
        );
      }),
    })),
  } as unknown as LapsedSupabaseClient;

  return { client, upserts };
}

const VALID_CUSTOMER_EVENT = {
  merchantId: "550e8400-e29b-41d4-a716-446655440000",
  shopifyCustomerGid: "gid://shopify/Customer/123456",
  eventType: "customer_created" as const,
  source: "shopify_webhook",
  payload: { id: 123456 },
  occurredAt: "2024-01-15T10:30:00.000Z",
};

const VALID_ORDER_EVENT = {
  merchantId: "550e8400-e29b-41d4-a716-446655440000",
  shopifyCustomerGid: "gid://shopify/Customer/123456",
  shopifyOrderGid: "gid://shopify/Order/999",
  eventType: "order_paid" as const,
  source: "shopify_webhook",
  payload: { id: 999 },
  occurredAt: "2024-01-15T10:30:00.000Z",
};

// ─────────────────────────────────────────────────────────────────────────────
// appendCustomerEvent
// ─────────────────────────────────────────────────────────────────────────────

describe("appendCustomerEvent", () => {
  it("calls customer_events.upsert with correct DB column names", async () => {
    const { client, upserts } = makeMockClient();
    await appendCustomerEvent(client, VALID_CUSTOMER_EVENT);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.table).toBe("customer_events");
    const row = upserts[0]?.row ?? {};
    expect(row.merchant_id).toBe(VALID_CUSTOMER_EVENT.merchantId);
    expect(row.shopify_customer_gid).toBe(VALID_CUSTOMER_EVENT.shopifyCustomerGid);
    expect(row.event_type).toBe("customer_created");
    expect(row.source).toBe("shopify_webhook");
    expect(row.occurred_at).toBe(VALID_CUSTOMER_EVENT.occurredAt);
    expect(row.payload).toEqual({ id: 123456 });
  });

  it("passes ignoreDuplicates:true to the upsert", async () => {
    const { client, upserts } = makeMockClient();
    await appendCustomerEvent(client, VALID_CUSTOMER_EVENT);
    expect((upserts[0]?.opts as { ignoreDuplicates?: boolean })?.ignoreDuplicates).toBe(true);
  });

  it("defaults payload to empty object when omitted", async () => {
    const { client, upserts } = makeMockClient();
    const { payload: _omit, ...withoutPayload } = VALID_CUSTOMER_EVENT;
    await appendCustomerEvent(client, withoutPayload as typeof VALID_CUSTOMER_EVENT);
    expect(upserts[0]?.row.payload).toEqual({});
  });

  it("accepts all valid CustomerEventType values including customer_scored", async () => {
    const types = [
      "customer_created",
      "customer_updated",
      "customer_backfilled",
      "order_placed",
      "customer_scored",
    ] as const;
    for (const eventType of types) {
      const { client, upserts } = makeMockClient();
      await appendCustomerEvent(client, { ...VALID_CUSTOMER_EVENT, eventType });
      expect(upserts[0]?.row.event_type).toBe(eventType);
    }
  });

  it("throws ZodError when merchantId is not a UUID", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCustomerEvent(client, { ...VALID_CUSTOMER_EVENT, merchantId: "not-a-uuid" }),
    ).rejects.toThrow();
  });

  it("throws ZodError when eventType is not an allowed value", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCustomerEvent(client, {
        ...VALID_CUSTOMER_EVENT,
        eventType: "unknown_event" as "customer_created",
      }),
    ).rejects.toThrow();
  });

  it("throws ZodError when occurredAt is not a valid datetime", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCustomerEvent(client, { ...VALID_CUSTOMER_EVENT, occurredAt: "not-a-date" }),
    ).rejects.toThrow();
  });

  it("throws ZodError when merchantId is missing", async () => {
    const { client } = makeMockClient();
    const { merchantId: _omit, ...withoutMerchant } = VALID_CUSTOMER_EVENT;
    await expect(
      appendCustomerEvent(client, withoutMerchant as typeof VALID_CUSTOMER_EVENT),
    ).rejects.toThrow();
  });

  it("throws when Supabase upsert returns an error", async () => {
    const { client } = makeMockClient({ message: "FK violation" });
    await expect(appendCustomerEvent(client, VALID_CUSTOMER_EVENT)).rejects.toMatchObject({
      message: "FK violation",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendOrderEvent
// ─────────────────────────────────────────────────────────────────────────────

describe("appendOrderEvent", () => {
  it("calls order_events.upsert with correct DB column names", async () => {
    const { client, upserts } = makeMockClient();
    await appendOrderEvent(client, VALID_ORDER_EVENT);

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.table).toBe("order_events");
    const row = upserts[0]?.row ?? {};
    expect(row.merchant_id).toBe(VALID_ORDER_EVENT.merchantId);
    expect(row.shopify_customer_gid).toBe(VALID_ORDER_EVENT.shopifyCustomerGid);
    expect(row.shopify_order_gid).toBe(VALID_ORDER_EVENT.shopifyOrderGid);
    expect(row.event_type).toBe("order_paid");
    expect(row.source).toBe("shopify_webhook");
    expect(row.occurred_at).toBe(VALID_ORDER_EVENT.occurredAt);
  });

  it("passes ignoreDuplicates:true to the upsert", async () => {
    const { client, upserts } = makeMockClient();
    await appendOrderEvent(client, VALID_ORDER_EVENT);
    expect((upserts[0]?.opts as { ignoreDuplicates?: boolean })?.ignoreDuplicates).toBe(true);
  });

  it("accepts all valid OrderEventType values", async () => {
    const types = ["order_paid", "order_backfilled"] as const;
    for (const eventType of types) {
      const { client, upserts } = makeMockClient();
      await appendOrderEvent(client, { ...VALID_ORDER_EVENT, eventType });
      expect(upserts[0]?.row.event_type).toBe(eventType);
    }
  });

  it("throws ZodError when merchantId is not a UUID", async () => {
    const { client } = makeMockClient();
    await expect(
      appendOrderEvent(client, { ...VALID_ORDER_EVENT, merchantId: "not-a-uuid" }),
    ).rejects.toThrow();
  });

  it("throws ZodError when eventType is not an allowed OrderEventType", async () => {
    const { client } = makeMockClient();
    await expect(
      appendOrderEvent(client, {
        ...VALID_ORDER_EVENT,
        eventType: "customer_created" as "order_paid",
      }),
    ).rejects.toThrow();
  });

  it("throws ZodError when shopifyOrderGid is empty", async () => {
    const { client } = makeMockClient();
    await expect(
      appendOrderEvent(client, { ...VALID_ORDER_EVENT, shopifyOrderGid: "" }),
    ).rejects.toThrow();
  });

  it("throws ZodError when occurredAt is not a valid datetime", async () => {
    const { client } = makeMockClient();
    await expect(
      appendOrderEvent(client, { ...VALID_ORDER_EVENT, occurredAt: "2024/01/15" }),
    ).rejects.toThrow();
  });

  it("throws when Supabase upsert returns an error", async () => {
    const { client } = makeMockClient({ message: "DB error" });
    await expect(appendOrderEvent(client, VALID_ORDER_EVENT)).rejects.toMatchObject({
      message: "DB error",
    });
  });
});
