import { appendCustomerEvent, materializeCustomer } from "@lapsed/core";
import type { WebhookHandler } from "./types";

interface ShopifyCustomerPayload {
  id: number;
  updated_at?: string;
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

  // Append event via validated helper — full payload stored for event-log replay.
  // accepts_marketing is intentionally not persisted to the customers table:
  // marketing consent is tracked at the conversation level in Sprint 06.
  await appendCustomerEvent(serviceClient, {
    merchantId,
    shopifyCustomerGid: gid,
    eventType: "customer_updated",
    source: "shopify_webhook",
    payload: customer as unknown as Record<string, unknown>,
    occurredAt: customer.updated_at ?? now,
  });

  // Rebuild the materialised profile from the event log.
  await materializeCustomer(serviceClient, merchantId, gid);

  console.info(`webhook customers/update shop_prefix=${shopDomain.split(".")[0] ?? "unknown"} gid=${customer.id}`);
};
