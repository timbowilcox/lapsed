import type { WebhookHandler } from "./types";
import { customersCreate } from "./customers-create";
import { customersUpdate } from "./customers-update";
import { ordersPaid } from "./orders-paid";
import { appUninstalled } from "./app-uninstalled";

// Handler registry: maps Shopify topic strings to handler functions.
const handlers: Record<string, WebhookHandler> = {
  "customers/create": customersCreate,
  "customers/update": customersUpdate,
  "orders/paid": ordersPaid,
  "app/uninstalled": appUninstalled,
};

export function getHandler(topic: string): WebhookHandler | undefined {
  return handlers[topic];
}

