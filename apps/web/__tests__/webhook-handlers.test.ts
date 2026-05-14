/**
 * Unit tests for Shopify webhook handlers.
 *
 * Each handler is tested in isolation using a mock Supabase client that
 * captures all DB calls. No network or real DB is involved.
 */

import { describe, expect, it, vi, type Mock } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { customersCreate } from "../app/api/shopify/webhooks/handlers/customers-create";
import { customersUpdate } from "../app/api/shopify/webhooks/handlers/customers-update";
import { ordersPaid } from "../app/api/shopify/webhooks/handlers/orders-paid";
import { appUninstalled } from "../app/api/shopify/webhooks/handlers/app-uninstalled";

// ─────────────────────────────────────────────────────────────────────────────
// Mock factory
// ─────────────────────────────────────────────────────────────────────────────

type UpsertCall = { table: string; row: Record<string, unknown>; opts?: unknown };
type UpdateCall = { table: string; values: Record<string, unknown> };
type RpcCall = { fn: string; args: Record<string, unknown> };

function makeClient() {
  const upserts: UpsertCall[] = [];
  const updates: UpdateCall[] = [];
  const rpcs: RpcCall[] = [];
  const tables = new Set<string>();

  const client = {
    from: vi.fn((table: string) => {
      tables.add(table);
      return {
        upsert: vi.fn((row: Record<string, unknown>, opts?: unknown) => {
          upserts.push({ table, row, opts });
          return Promise.resolve({ data: null, error: null });
        }),
        update: vi.fn((values: Record<string, unknown>) => {
          updates.push({ table, values });
          return {
            eq: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }),
        delete: vi.fn(() => {
          throw new Error(`Unexpected delete on table "${table}"`);
        }),
      };
    }),
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    }),
  } as unknown as LapsedSupabaseClient & {
    _upserts: UpsertCall[];
    _updates: UpdateCall[];
    _rpcs: RpcCall[];
    _tables: Set<string>;
  };

  (client as unknown as Record<string, unknown>)._upserts = upserts;
  (client as unknown as Record<string, unknown>)._updates = updates;
  (client as unknown as Record<string, unknown>)._rpcs = rpcs;
  (client as unknown as Record<string, unknown>)._tables = tables;

  return client as LapsedSupabaseClient & {
    _upserts: UpsertCall[];
    _updates: UpdateCall[];
    _rpcs: RpcCall[];
    _tables: Set<string>;
  };
}

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440001";
const SHOP_DOMAIN = "bondi-goods.myshopify.com";

// ─────────────────────────────────────────────────────────────────────────────
// customers/create
// ─────────────────────────────────────────────────────────────────────────────

describe("customersCreate handler", () => {
  it("appends customer_created event and upserts customers profile", async () => {
    const client = makeClient();
    const payload = {
      id: 123456,
      email: "test@example.com",
      first_name: "Jane",
      last_name: "Doe",
      tags: "vip, loyal",
      orders_count: 3,
      total_spent: "250.50",
      created_at: "2024-01-01T00:00:00Z",
    };

    await customersCreate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/create", payload, serviceClient: client });

    const eventUpsert = client._upserts.find((u) => u.table === "customer_events");
    expect(eventUpsert?.row.event_type).toBe("customer_created");
    expect(eventUpsert?.row.source).toBe("shopify_webhook");
    expect(eventUpsert?.row.shopify_customer_gid).toBe("gid://shopify/Customer/123456");
    expect(eventUpsert?.row.merchant_id).toBe(MERCHANT_ID);
    expect(eventUpsert?.row.occurred_at).toBe("2024-01-01T00:00:00Z");

    const profileUpsert = client._upserts.find((u) => u.table === "customers");
    expect(profileUpsert?.row.total_order_count).toBe(3);
    expect(profileUpsert?.row.total_ltv_cents).toBe(25050);
    expect(profileUpsert?.row.tags).toEqual(["vip", "loyal"]);
    expect(profileUpsert?.row.email).toBe("test@example.com");
  });

  it("exits early without any DB write when payload has no id", async () => {
    const client = makeClient();
    await customersCreate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/create", payload: {}, serviceClient: client });
    expect(client._upserts).toHaveLength(0);
  });

  it("exits early without any DB write when payload is null", async () => {
    const client = makeClient();
    await customersCreate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/create", payload: null, serviceClient: client });
    expect(client._upserts).toHaveLength(0);
  });

  it("produces empty tags array when tags field is absent", async () => {
    const client = makeClient();
    await customersCreate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/create", payload: { id: 1 }, serviceClient: client });
    const profileUpsert = client._upserts.find((u) => u.table === "customers");
    expect(profileUpsert?.row.tags).toEqual([]);
  });

  it("splits comma-separated tags and trims whitespace", async () => {
    const client = makeClient();
    await customersCreate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/create", payload: { id: 1, tags: " win-back ,  vip , loyal" }, serviceClient: client });
    const profileUpsert = client._upserts.find((u) => u.table === "customers");
    expect(profileUpsert?.row.tags).toEqual(["win-back", "vip", "loyal"]);
  });

  it("defaults total_ltv_cents to 0 when total_spent is absent", async () => {
    const client = makeClient();
    await customersCreate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/create", payload: { id: 1 }, serviceClient: client });
    const profileUpsert = client._upserts.find((u) => u.table === "customers");
    expect(profileUpsert?.row.total_ltv_cents).toBe(0);
  });

  it("does not include shop_domain in log output", async () => {
    const client = makeClient();
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await customersCreate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/create", payload: { id: 1 }, serviceClient: client });
    expect(logSpy).toHaveBeenCalledWith(expect.not.stringContaining(SHOP_DOMAIN));
    logSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// customers/update
// ─────────────────────────────────────────────────────────────────────────────

describe("customersUpdate handler", () => {
  it("appends customer_updated event and upserts customers profile", async () => {
    const client = makeClient();
    const payload = {
      id: 999,
      email: "updated@example.com",
      updated_at: "2024-06-01T12:00:00Z",
      tags: "loyal",
      orders_count: 5,
      total_spent: "400.00",
    };

    await customersUpdate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/update", payload, serviceClient: client });

    const eventUpsert = client._upserts.find((u) => u.table === "customer_events");
    expect(eventUpsert?.row.event_type).toBe("customer_updated");
    expect(eventUpsert?.row.occurred_at).toBe("2024-06-01T12:00:00Z");

    const profileUpsert = client._upserts.find((u) => u.table === "customers");
    expect(profileUpsert?.row.total_ltv_cents).toBe(40000);
    expect(profileUpsert?.row.email).toBe("updated@example.com");
  });

  it("exits early without any DB write when payload has no id", async () => {
    const client = makeClient();
    await customersUpdate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/update", payload: { email: "x@x.com" }, serviceClient: client });
    expect(client._upserts).toHaveLength(0);
  });

  it("does not write accepts_marketing to the customers upsert", async () => {
    const client = makeClient();
    await customersUpdate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/update", payload: { id: 1, accepts_marketing: true }, serviceClient: client });
    const profileUpsert = client._upserts.find((u) => u.table === "customers");
    expect(profileUpsert?.row).not.toHaveProperty("accepts_marketing");
  });

  it("does not include shop_domain in log output", async () => {
    const client = makeClient();
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await customersUpdate({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "customers/update", payload: { id: 1 }, serviceClient: client });
    expect(logSpy).toHaveBeenCalledWith(expect.not.stringContaining(SHOP_DOMAIN));
    logSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orders/paid
// ─────────────────────────────────────────────────────────────────────────────

describe("ordersPaid handler", () => {
  it("appends order_events + customer_events, upserts orders, and calls increment_customer_order rpc", async () => {
    const client = makeClient();
    const payload = {
      id: 55555,
      customer: { id: 111 },
      total_price: "150.00",
      financial_status: "paid",
      fulfilled_at: null,
      created_at: "2024-03-01T00:00:00Z",
    };

    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload, serviceClient: client });

    const orderEvent = client._upserts.find((u) => u.table === "order_events");
    expect(orderEvent?.row.event_type).toBe("order_paid");
    expect(orderEvent?.row.shopify_order_gid).toBe("gid://shopify/Order/55555");
    expect(orderEvent?.row.shopify_customer_gid).toBe("gid://shopify/Customer/111");

    const customerEvent = client._upserts.find((u) => u.table === "customer_events");
    expect(customerEvent?.row.event_type).toBe("order_placed");
    expect(customerEvent?.row.shopify_customer_gid).toBe("gid://shopify/Customer/111");

    const orderUpsert = client._upserts.find((u) => u.table === "orders");
    expect(orderUpsert?.row.total_price_cents).toBe(15000);
    expect(orderUpsert?.row.financial_status).toBe("paid");

    expect(client._rpcs).toHaveLength(1);
    expect(client._rpcs[0]?.fn).toBe("increment_customer_order");
    expect(client._rpcs[0]?.args.p_merchant_id).toBe(MERCHANT_ID);
    expect(client._rpcs[0]?.args.p_customer_gid).toBe("gid://shopify/Customer/111");
    expect(client._rpcs[0]?.args.p_amount_cents).toBe(15000);
  });

  it("exits early without any DB write when order has no id", async () => {
    const client = makeClient();
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { customer: { id: 1 } }, serviceClient: client });
    expect(client._upserts).toHaveLength(0);
    expect(client._rpcs).toHaveLength(0);
  });

  it("exits early without any DB write when order has no customer.id", async () => {
    const client = makeClient();
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 1, customer: null }, serviceClient: client });
    expect(client._upserts).toHaveLength(0);
    expect(client._rpcs).toHaveLength(0);
  });

  it("exits early when order.customer is undefined", async () => {
    const client = makeClient();
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 1 }, serviceClient: client });
    expect(client._upserts).toHaveLength(0);
  });

  it("defaults total_price_cents to 0 when total_price is absent", async () => {
    const client = makeClient();
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 1, customer: { id: 2 } }, serviceClient: client });
    const orderUpsert = client._upserts.find((u) => u.table === "orders");
    expect(orderUpsert?.row.total_price_cents).toBe(0);
    expect(client._rpcs[0]?.args.p_amount_cents).toBe(0);
  });

  it("does not include shop_domain in log output", async () => {
    const client = makeClient();
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 1, customer: { id: 2 }, total_price: "10.00", created_at: "2024-01-01T00:00:00Z" }, serviceClient: client });
    expect(logSpy).toHaveBeenCalledWith(expect.not.stringContaining(SHOP_DOMAIN));
    logSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// app/uninstalled
// ─────────────────────────────────────────────────────────────────────────────

describe("appUninstalled handler", () => {
  it("appends app_uninstalled merchant event and updates merchants.uninstalled_at", async () => {
    const client = makeClient();
    await appUninstalled({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "app/uninstalled", payload: {}, serviceClient: client });

    const merchantEvent = client._upserts.find((u) => u.table === "merchant_events");
    expect(merchantEvent).toBeDefined();
    expect(merchantEvent?.row.event_type).toBe("app_uninstalled");
    expect(merchantEvent?.row.source).toBe("shopify_webhook");
    expect(merchantEvent?.row.merchant_id).toBe(MERCHANT_ID);

    const merchantUpdate = client._updates.find((u) => u.table === "merchants");
    expect(merchantUpdate?.values).toHaveProperty("uninstalled_at");
    expect(typeof merchantUpdate?.values.uninstalled_at).toBe("string");
  });

  it("does not call delete on any table (data is retained for reinstall)", async () => {
    const client = makeClient();
    // The mock client's delete() throws — if it is called, the test will fail.
    await expect(
      appUninstalled({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "app/uninstalled", payload: {}, serviceClient: client }),
    ).resolves.toBeUndefined();
    expect((client.from as unknown as Mock).mock.calls.map((c: unknown[]) => c[0])).not.toContain("customer_events");
  });

  it("does not include the full shop domain in log output", async () => {
    const client = makeClient();
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await appUninstalled({ merchantId: MERCHANT_ID, shopDomain: "my-store.myshopify.com", topic: "app/uninstalled", payload: {}, serviceClient: client });
    expect(logSpy).toHaveBeenCalledWith(expect.not.stringContaining("my-store.myshopify.com"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("my-store"));
    logSpy.mockRestore();
  });
});
