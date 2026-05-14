import type { Json } from "@lapsed/db";
import type { WebhookHandler } from "./types";

interface ShopifyOrderCustomer {
  id: number;
}

interface ShopifyOrderPayload {
  id: number;
  total_price?: string;
  financial_status?: string;
  fulfilled_at?: string | null;
  created_at?: string;
  customer?: ShopifyOrderCustomer | null;
}

function toOrderGid(shopifyId: number): string {
  return `gid://shopify/Order/${shopifyId}`;
}

function toCustomerGid(shopifyId: number): string {
  return `gid://shopify/Customer/${shopifyId}`;
}

export const ordersPaid: WebhookHandler = async ({
  merchantId,
  shopDomain,
  payload,
  serviceClient,
}) => {
  const order = payload as ShopifyOrderPayload;
  if (!order?.id) return;

  const orderGid = toOrderGid(order.id);
  const customerId = order.customer?.id;
  if (!customerId) return;

  const customerGid = toCustomerGid(customerId);
  const now = new Date().toISOString();
  const totalCents = Math.round(parseFloat(order.total_price ?? "0") * 100);
  const orderedAt = order.created_at ?? now;

  // 1. Append order event — idempotent via ignoreDuplicates on dedup unique constraint
  await serviceClient.from("order_events").upsert(
    {
      merchant_id: merchantId,
      shopify_customer_gid: customerGid,
      shopify_order_gid: orderGid,
      event_type: "order_paid",
      source: "shopify_webhook",
      payload: payload as Json,
      occurred_at: orderedAt,
    },
    { onConflict: "merchant_id,shopify_order_gid,event_type,source,occurred_at", ignoreDuplicates: true },
  );

  // 2. Append customer event — order activity is a customer memory event
  await serviceClient.from("customer_events").upsert(
    {
      merchant_id: merchantId,
      shopify_customer_gid: customerGid,
      event_type: "order_placed",
      source: "shopify_webhook",
      payload: payload as Json,
      occurred_at: orderedAt,
    },
    { onConflict: "merchant_id,shopify_customer_gid,event_type,source,occurred_at", ignoreDuplicates: true },
  );

  // 3. Upsert orders materialised row
  await serviceClient.from("orders").upsert(
    {
      merchant_id: merchantId,
      shopify_order_gid: orderGid,
      shopify_customer_gid: customerGid,
      total_price_cents: totalCents,
      financial_status: order.financial_status ?? "paid",
      fulfilled_at: order.fulfilled_at ?? null,
      shopify_created_at: orderedAt,
    },
    { onConflict: "merchant_id,shopify_order_gid" },
  );

  // 4. Atomically upsert customers materialised profile with incremented counters.
  //    Uses a SQL function (INSERT … ON CONFLICT DO UPDATE with arithmetic) to avoid
  //    a read-modify-write race under concurrent webhook deliveries for the same customer.
  //    The nightly materializeCustomer (Sprint 04) recalculates from the full event log.
  await serviceClient.rpc("increment_customer_order", {
    p_merchant_id: merchantId,
    p_customer_gid: customerGid,
    p_amount_cents: totalCents,
    p_ordered_at: orderedAt,
  });

  console.info(`webhook orders/paid shop_prefix=${shopDomain.split(".")[0] ?? "unknown"} order=${order.id}`);
};
