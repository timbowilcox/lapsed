import type { Json } from "@lapsed/db";
import type { WebhookHandler } from "./types";

interface ShopifyCustomerPayload {
  id: number;
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  tags?: string;
  orders_count?: number;
  total_spent?: string;
  last_order_id?: number | null;
  created_at?: string;
}

function toGid(shopifyId: number): string {
  return `gid://shopify/Customer/${shopifyId}`;
}

export const customersCreate: WebhookHandler = async ({
  merchantId,
  shopDomain,
  payload,
  serviceClient,
}) => {
  const customer = payload as ShopifyCustomerPayload;
  if (!customer?.id) return;

  const gid = toGid(customer.id);
  const now = new Date().toISOString();
  const tags = customer.tags
    ? customer.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  // Append event — ON CONFLICT DO NOTHING via dedup unique constraint (ignoreDuplicates)
  await serviceClient.from("customer_events").upsert(
    {
      merchant_id: merchantId,
      shopify_customer_gid: gid,
      event_type: "customer_created",
      source: "shopify_webhook",
      payload: payload as Json,
      occurred_at: customer.created_at ?? now,
    },
    { onConflict: "merchant_id,shopify_customer_gid,event_type,source,occurred_at", ignoreDuplicates: true },
  );

  // Materialised profile upsert
  await serviceClient.from("customers").upsert(
    {
      merchant_id: merchantId,
      shopify_customer_gid: gid,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      first_name: customer.first_name ?? null,
      last_name: customer.last_name ?? null,
      tags,
      total_order_count: customer.orders_count ?? 0,
      total_ltv_cents: Math.round(parseFloat(customer.total_spent ?? "0") * 100),
    },
    { onConflict: "merchant_id,shopify_customer_gid" },
  );

  console.info(`webhook customers/create shop_prefix=${shopDomain.split(".")[0] ?? "unknown"} gid=${customer.id}`);
};
