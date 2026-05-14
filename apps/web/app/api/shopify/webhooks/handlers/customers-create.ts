import { appendCustomerEvent, materializeCustomer } from "@lapsed/core";
import type { WebhookHandler } from "./types";

interface ShopifyCustomerPayload {
  id: number;
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

  // Append event via validated helper — full payload stored for event-log replay
  await appendCustomerEvent(serviceClient, {
    merchantId,
    shopifyCustomerGid: gid,
    eventType: "customer_created",
    source: "shopify_webhook",
    payload: customer as unknown as Record<string, unknown>,
    occurredAt: customer.created_at ?? now,
  });

  // Rebuild the materialised profile from the event log so that the customers
  // table is always reconstructable by replaying events alone.
  await materializeCustomer(serviceClient, merchantId, gid);

  console.info(`webhook customers/create shop_prefix=${shopDomain.split(".")[0] ?? "unknown"} gid=${customer.id}`);
};
