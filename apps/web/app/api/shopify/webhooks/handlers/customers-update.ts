import { appendCustomerEvent } from "@lapsed/core";
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
  updated_at?: string;
  accepts_marketing?: boolean;
}

function toGid(shopifyId: number): string {
  return `gid://shopify/Customer/${shopifyId}`;
}

export const customersUpdate: WebhookHandler = async ({
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

  // Append event via validated helper
  await appendCustomerEvent(serviceClient, {
    merchantId,
    shopifyCustomerGid: gid,
    eventType: "customer_updated",
    source: "shopify_webhook",
    payload: customer as unknown as Record<string, unknown>,
    occurredAt: customer.updated_at ?? now,
  });

  // Materialised profile upsert — merge current values.
  // accepts_marketing is intentionally not written here: the customers table
  // does not have a dedicated column for it (marketing consent is tracked at
  // the conversation level in Sprint 06).
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

  console.info(`webhook customers/update shop_prefix=${shopDomain.split(".")[0] ?? "unknown"} gid=${customer.id}`);
};
