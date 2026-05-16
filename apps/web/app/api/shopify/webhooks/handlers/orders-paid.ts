import { appendCustomerEvent, appendOrderEvent } from "@lapsed/core";
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
  payload,
  serviceClient,
}) => {
  const startedAt = Date.now();
  const order = payload as ShopifyOrderPayload;
  if (!order?.id) return;

  const orderGid = toOrderGid(order.id);
  const customerId = order.customer?.id;

  // Guest checkouts carry no customer. They cannot be attributed (attribution
  // joins orders to outbound messages by customer gid) and the orders table
  // requires a customer gid, so a customerless order is not persisted. This
  // is a documented Sprint 08 deviation — see HANDOFF.
  if (!customerId) {
    console.info(
      `webhook orders/paid merchant=${merchantId} order_gid=${orderGid} ` +
        `customer_matched=false guest=true elapsed_ms=${Date.now() - startedAt}`,
    );
    return;
  }

  const customerGid = toCustomerGid(customerId);
  const now = new Date().toISOString();
  const totalCents = Math.round(parseFloat(order.total_price ?? "0") * 100);
  const orderedAt = order.created_at ?? now;

  // Customer-match resolution (decision 25): does this Shopify customer already
  // exist in our customers table? The lookup happens BEFORE the increment RPC
  // below (which upserts a customers row), so it reflects the pre-ingestion
  // state. An unmatched order is still persisted — it is never dropped.
  const { data: matchedCustomer, error: matchErr } = await serviceClient
    .from("customers")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", customerGid)
    .maybeSingle();
  // Fail loud on a query error rather than silently treating it as unmatched —
  // a spurious unmatched_customer event would pollute the attribution audit.
  if (matchErr) throw matchErr;
  const customerMatched = matchedCustomer !== null;

  // Order-redelivery resolution: Shopify retries are real, and a retry may
  // arrive under a fresh X-Shopify-Webhook-Id (so the unified route's
  // per-delivery dedup does not catch it). appendOrderEvent and the orders
  // upsert below are idempotent on their own keys, but increment_customer_order
  // blindly adds — a redelivery would double-count order_count + LTV and
  // corrupt the billing meter (decision 6). This pre-check, taken BEFORE the
  // orders upsert, is the order-grained idempotency guard for the RPC.
  const { data: existingOrder, error: orderLookupErr } = await serviceClient
    .from("orders")
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("shopify_order_gid", orderGid)
    .maybeSingle();
  if (orderLookupErr) throw orderLookupErr;
  const orderAlreadyIngested = existingOrder !== null;

  // 1. Append order event via validated helper
  await appendOrderEvent(serviceClient, {
    merchantId,
    shopifyCustomerGid: customerGid,
    shopifyOrderGid: orderGid,
    eventType: "order_paid",
    source: "shopify_webhook",
    payload: order as unknown as Record<string, unknown>,
    occurredAt: orderedAt,
  });

  // 1b. Audit marker for an unmatched customer — the order is still ingested.
  if (!customerMatched) {
    await appendOrderEvent(serviceClient, {
      merchantId,
      shopifyCustomerGid: customerGid,
      shopifyOrderGid: orderGid,
      eventType: "unmatched_customer",
      source: "shopify_webhook",
      payload: {},
      occurredAt: orderedAt,
    });
  }

  // 2. Append customer event — order activity is a customer memory event
  await appendCustomerEvent(serviceClient, {
    merchantId,
    shopifyCustomerGid: customerGid,
    eventType: "order_placed",
    source: "shopify_webhook",
    payload: order as unknown as Record<string, unknown>,
    occurredAt: orderedAt,
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

  // 4. Atomically upsert customers materialised profile with incremented counters.
  //    Uses a SQL function (INSERT … ON CONFLICT DO UPDATE with arithmetic) to avoid
  //    a read-modify-write race under concurrent webhook deliveries for the same customer.
  //    The nightly materializeCustomer (Sprint 04) recalculates from the full event log.
  //    Skipped on a redelivery — the increment is the one non-idempotent write.
  if (!orderAlreadyIngested) {
    await serviceClient.rpc("increment_customer_order", {
      p_merchant_id: merchantId,
      p_customer_gid: customerGid,
      p_amount_cents: totalCents,
      p_ordered_at: orderedAt,
    });
  }

  // Structured log — IDs, the match flag, and timing only. No shop_domain, no
  // customer phone, no order line items (decision 10 — PII never in logs).
  console.info(
    `webhook orders/paid merchant=${merchantId} order_gid=${orderGid} ` +
      `customer_matched=${customerMatched} redelivery=${orderAlreadyIngested} ` +
      `elapsed_ms=${Date.now() - startedAt}`,
  );
};
