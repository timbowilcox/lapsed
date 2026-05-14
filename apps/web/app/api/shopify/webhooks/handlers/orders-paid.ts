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

  // 1. Append order event — idempotent via dedup unique constraint
  await serviceClient.from("order_events").insert({
    merchant_id: merchantId,
    shopify_customer_gid: customerGid,
    shopify_order_gid: orderGid,
    event_type: "order_paid",
    source: "shopify_webhook",
    payload: payload as Json,
    occurred_at: orderedAt,
  });

  // 2. Append customer event — order activity is a customer memory event
  await serviceClient.from("customer_events").insert({
    merchant_id: merchantId,
    shopify_customer_gid: customerGid,
    event_type: "order_placed",
    source: "shopify_webhook",
    payload: payload as Json,
    occurred_at: orderedAt,
  });

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

  // 4. Update customers materialised profile
  //    Use a raw upsert so that total_order_count and total_ltv_cents are
  //    accumulated correctly. The nightly materializeCustomer (Sprint 04)
  //    will recalculate from the full event log; this eager update keeps
  //    the profile fresh for the dashboard in the interim.
  const { data: existing } = await serviceClient
    .from("customers")
    .select("id,total_order_count,total_ltv_cents")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", customerGid)
    .maybeSingle();

  if (existing) {
    await serviceClient
      .from("customers")
      .update({
        total_order_count: (existing.total_order_count ?? 0) + 1,
        total_ltv_cents: (existing.total_ltv_cents ?? 0) + totalCents,
        last_order_at: orderedAt,
      })
      .eq("id", existing.id);
  } else {
    // Customer row doesn't exist yet (backfill hasn't run); create a minimal one
    await serviceClient.from("customers").upsert(
      {
        merchant_id: merchantId,
        shopify_customer_gid: customerGid,
        total_order_count: 1,
        total_ltv_cents: totalCents,
        last_order_at: orderedAt,
      },
      { onConflict: "merchant_id,shopify_customer_gid" },
    );
  }

  console.info(`webhook orders/paid shop=${shopDomain} order=${order.id} customer=${customerId}`);
};
