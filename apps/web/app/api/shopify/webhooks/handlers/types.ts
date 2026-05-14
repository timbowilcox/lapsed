import type { LapsedSupabaseClient } from "@lapsed/db";

export interface WebhookHandlerContext {
  merchantId: string;
  shopDomain: string;
  topic: string;
  payload: unknown;
  serviceClient: LapsedSupabaseClient;
}

export type WebhookHandler = (ctx: WebhookHandlerContext) => Promise<void>;
