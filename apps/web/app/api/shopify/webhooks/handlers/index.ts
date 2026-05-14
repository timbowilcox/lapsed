import type { WebhookHandler } from "./types";

// Handler registry: maps Shopify topic strings to handler functions.
// Populated by Chunks 5 and 6 as topic handlers are implemented.
export const handlers: Record<string, WebhookHandler> = {};

export function getHandler(topic: string): WebhookHandler | undefined {
  return handlers[topic];
}
