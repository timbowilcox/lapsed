/**
 * Unit tests for Shopify webhook handlers.
 *
 * Each handler is tested in isolation using a mock Supabase client that
 * captures all DB calls. No network or real DB is involved.
 *
 * customers/create and customers/update handlers now call materializeCustomer
 * after appending the event. The mock is stateful: customer_events upserts are
 * stored and returned by subsequent reads so materializeCustomer can find the
 * identity payload it just wrote.
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

function makeClient(opts: { customerExists?: boolean; orderExists?: boolean } = {}) {
  const upserts: UpsertCall[] = [];
  const updates: UpdateCall[] = [];
  const rpcs: RpcCall[] = [];
  const tables = new Set<string>();
  // When true, the customers select().eq().eq().maybeSingle() read resolves to
  // a row — used by ordersPaid tests to exercise the customer-matched path.
  const customerRow = opts.customerExists ? { id: "existing-customer-id" } : null;
  // When true, the orders select().eq().eq().maybeSingle() read resolves to a
  // row — used by ordersPaid tests to exercise the redelivery (idempotency) path.
  const orderRow = opts.orderExists ? { id: "existing-order-id" } : null;

  // Stateful store: customer_events upserts are returned by subsequent reads
  // so materializeCustomer can rebuild identity from the event just written.
  const customerEventStore: Record<string, unknown>[] = [];

  const client = {
    from: vi.fn((table: string) => {
      tables.add(table);

      if (table === "customer_events") {
        return {
          // appendCustomerEvent upsert path
          upsert: vi.fn((row: Record<string, unknown>, opts?: unknown) => {
            upserts.push({ table, row, opts });
            customerEventStore.push(row);
            return Promise.resolve({ data: null, error: null });
          }),
          // materializeCustomer identity-read path:
          // select().eq().eq().in().order().limit()
          select: vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            in: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn().mockResolvedValue({
                  data: customerEventStore.slice(-1),
                  error: null,
                }),
              })),
            })),
          })),
        };
      }

      if (table === "order_events") {
        return {
          upsert: vi.fn((row: Record<string, unknown>, opts?: unknown) => {
            upserts.push({ table, row, opts });
            return Promise.resolve({ data: null, error: null });
          }),
          // materializeCustomer financial-read path:
          // select().eq().eq().in()
          select: vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({ data: [], error: null }),
          })),
        };
      }

      if (table === "orders") {
        return {
          // ordersPaid redelivery pre-check: select().eq().eq().maybeSingle()
          select: vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: orderRow, error: null }),
          })),
          upsert: vi.fn((row: Record<string, unknown>, opts?: unknown) => {
            upserts.push({ table, row, opts });
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }

      if (table === "customers") {
        return {
          // materializeCustomer profile_version read path + ordersPaid
          // customer-match read path: select().eq().eq().maybeSingle()
          select: vi.fn(() => ({
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: customerRow, error: null }),
          })),
          // materializeCustomer upsert path:
          // upsert().select().maybeSingle()
          upsert: vi.fn((row: Record<string, unknown>, opts?: unknown) => {
            upserts.push({ table, row, opts });
            return {
              select: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: { ...row, id: "mock-customer-id" },
                  error: null,
                }),
              })),
            };
          }),
        };
      }

      if (table === "merchant_events") {
        return {
          upsert: vi.fn((row: Record<string, unknown>, opts?: unknown) => {
            upserts.push({ table, row, opts });
            return Promise.resolve({ data: null, error: null });
          }),
        };
      }

      if (table === "merchants") {
        return {
          update: vi.fn((values: Record<string, unknown>) => {
            updates.push({ table, values });
            return {
              eq: vi.fn(() => ({
                is: vi.fn().mockResolvedValue({ data: null, error: null }),
              })),
            };
          }),
        };
      }

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
  it("appends customer_created event and rebuilds profile via event log", async () => {
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

    // Profile is rebuilt from event log — financials come from order_events (empty here),
    // identity comes from the customer_created event payload just written.
    const profileUpsert = client._upserts.find((u) => u.table === "customers");
    expect(profileUpsert?.row.merchant_id).toBe(MERCHANT_ID);
    expect(profileUpsert?.row.shopify_customer_gid).toBe("gid://shopify/Customer/123456");
    expect(profileUpsert?.row.total_order_count).toBe(0); // rebuilt from empty order_events
    expect(profileUpsert?.row.total_ltv_cents).toBe(0);   // rebuilt from empty order_events
    // Identity fields read back from event log via customer_events payload
    expect(profileUpsert?.row.email).toBe("test@example.com");
    expect(profileUpsert?.row.tags).toEqual(["vip", "loyal"]);
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

  it("produces empty tags array when tags field is absent from payload", async () => {
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

  it("profile has zero ltv when no order history exists (real value comes from backfill)", async () => {
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
  it("appends customer_updated event and rebuilds profile via event log", async () => {
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

    // LTV comes from order_events (empty in this mock), identity from event payload
    const profileUpsert = client._upserts.find((u) => u.table === "customers");
    expect(profileUpsert?.row.total_ltv_cents).toBe(0); // rebuilt from empty order_events
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

  it("appends an unmatched_customer order event when the customer is not in our table", async () => {
    const client = makeClient({ customerExists: false });
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 77, customer: { id: 9 }, total_price: "20.00", created_at: "2026-05-01T00:00:00Z" }, serviceClient: client });

    const orderEvents = client._upserts.filter((u) => u.table === "order_events");
    expect(orderEvents.map((e) => e.row.event_type).sort()).toEqual(["order_paid", "unmatched_customer"]);
    // The order is still persisted — unmatched orders are never dropped.
    expect(client._upserts.find((u) => u.table === "orders")?.row.shopify_order_gid).toBe(
      "gid://shopify/Order/77",
    );
  });

  it("does NOT append unmatched_customer when the customer is already matched", async () => {
    const client = makeClient({ customerExists: true });
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 78, customer: { id: 9 }, total_price: "20.00", created_at: "2026-05-01T00:00:00Z" }, serviceClient: client });

    const orderEvents = client._upserts.filter((u) => u.table === "order_events");
    expect(orderEvents.map((e) => e.row.event_type)).toEqual(["order_paid"]);
    // The order is persisted and the customer counters are incremented (a
    // first delivery — not a redelivery).
    expect(client._upserts.some((u) => u.table === "orders")).toBe(true);
    expect(client._rpcs.map((r) => r.fn)).toEqual(["increment_customer_order"]);
  });

  it("a redelivery (order already ingested) does NOT re-run the increment RPC", async () => {
    const client = makeClient({ customerExists: true, orderExists: true });
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 78, customer: { id: 9 }, total_price: "20.00", created_at: "2026-05-01T00:00:00Z" }, serviceClient: client });
    // increment_customer_order would double-count order_count + LTV — it must
    // be skipped on a redelivery. appendOrderEvent / orders upsert remain
    // idempotent on their own keys, so they may still run harmlessly.
    expect(client._rpcs).toHaveLength(0);
  });

  it("redelivery flag is surfaced in the structured log", async () => {
    const client = makeClient({ customerExists: true, orderExists: true });
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 78, customer: { id: 9 }, total_price: "20.00", created_at: "2026-05-01T00:00:00Z" }, serviceClient: client });
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("redelivery=true");
    logSpy.mockRestore();
  });

  it("converts a fractional price to integer cents without drift", async () => {
    const client = makeClient({ customerExists: true });
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 81, customer: { id: 9 }, total_price: "19.99", created_at: "2026-05-01T00:00:00Z" }, serviceClient: client });
    const orderUpsert = client._upserts.find((u) => u.table === "orders");
    expect(orderUpsert?.row.total_price_cents).toBe(1999);
    expect(client._rpcs[0]?.args.p_amount_cents).toBe(1999);
  });

  it("structured log carries merchant_id, order_gid, customer_matched, and elapsed_ms", async () => {
    const client = makeClient({ customerExists: true });
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 79, customer: { id: 9 }, total_price: "20.00", created_at: "2026-05-01T00:00:00Z" }, serviceClient: client });
    const line = logSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain(`merchant=${MERCHANT_ID}`);
    expect(line).toContain("order_gid=gid://shopify/Order/79");
    expect(line).toContain("customer_matched=true");
    expect(line).toMatch(/elapsed_ms=\d+/);
    logSpy.mockRestore();
  });

  it("a guest order (no customer) is not persisted but is logged", async () => {
    const client = makeClient();
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await ordersPaid({ merchantId: MERCHANT_ID, shopDomain: SHOP_DOMAIN, topic: "orders/paid", payload: { id: 80, customer: null }, serviceClient: client });
    expect(client._upserts).toHaveLength(0);
    expect(client._rpcs).toHaveLength(0);
    expect(logSpy.mock.calls[0]?.[0] as string).toContain("guest=true");
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
