import { z } from "zod";
import type { LapsedSupabaseClient, Json } from "@lapsed/db";

// ─────────────────────────────────────────────────────────────────────────────
// Event type enums (exhaustive — extend as new sources are added)
// ─────────────────────────────────────────────────────────────────────────────

export const CustomerEventType = z.enum([
  "customer_created",
  "customer_updated",
  "customer_backfilled",
  "order_placed",        // customer_events row for an order (cross-stream)
]);

export const OrderEventType = z.enum([
  "order_paid",
  "order_backfilled",
]);

export type CustomerEventType = z.infer<typeof CustomerEventType>;
export type OrderEventType = z.infer<typeof OrderEventType>;

// ─────────────────────────────────────────────────────────────────────────────
// Input schemas
// ─────────────────────────────────────────────────────────────────────────────

const CustomerEventInputSchema = z.object({
  merchantId: z.string().uuid("merchantId must be a UUID"),
  shopifyCustomerGid: z.string().min(1, "shopifyCustomerGid is required"),
  eventType: CustomerEventType,
  source: z.string().min(1, "source is required"),
  payload: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.string().datetime("occurredAt must be an ISO-8601 datetime"),
});

const OrderEventInputSchema = z.object({
  merchantId: z.string().uuid("merchantId must be a UUID"),
  shopifyCustomerGid: z.string().min(1, "shopifyCustomerGid is required"),
  shopifyOrderGid: z.string().min(1, "shopifyOrderGid is required"),
  eventType: OrderEventType,
  source: z.string().min(1, "source is required"),
  payload: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.string().datetime("occurredAt must be an ISO-8601 datetime"),
});

export type CustomerEventInput = z.infer<typeof CustomerEventInputSchema>;
export type OrderEventInput = z.infer<typeof OrderEventInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates and appends a customer event to the append-only event log.
 * Uses ON CONFLICT DO NOTHING (ignoreDuplicates) so duplicate deliveries are
 * silently skipped — the dedup unique constraint is the source of truth.
 *
 * Throws a ZodError if the input fails validation.
 */
export async function appendCustomerEvent(
  serviceClient: LapsedSupabaseClient,
  event: CustomerEventInput,
): Promise<void> {
  const v = CustomerEventInputSchema.parse(event);

  const { error } = await serviceClient.from("customer_events").upsert(
    {
      merchant_id: v.merchantId,
      shopify_customer_gid: v.shopifyCustomerGid,
      event_type: v.eventType,
      source: v.source,
      payload: v.payload as Json,
      occurred_at: v.occurredAt,
    },
    {
      onConflict: "merchant_id,shopify_customer_gid,event_type,source,occurred_at",
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;
}

/**
 * Validates and appends an order event to the append-only event log.
 * Uses ON CONFLICT DO NOTHING (ignoreDuplicates) so duplicate deliveries are
 * silently skipped.
 *
 * Throws a ZodError if the input fails validation.
 */
export async function appendOrderEvent(
  serviceClient: LapsedSupabaseClient,
  event: OrderEventInput,
): Promise<void> {
  const v = OrderEventInputSchema.parse(event);

  const { error } = await serviceClient.from("order_events").upsert(
    {
      merchant_id: v.merchantId,
      shopify_customer_gid: v.shopifyCustomerGid,
      shopify_order_gid: v.shopifyOrderGid,
      event_type: v.eventType,
      source: v.source,
      payload: v.payload as Json,
      occurred_at: v.occurredAt,
    },
    {
      onConflict: "merchant_id,shopify_order_gid,event_type,source,occurred_at",
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;
}
