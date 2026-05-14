import type { LapsedSupabaseClient } from "@lapsed/db";

// Shape of a customer_events row payload when the source is an order event.
interface OrderPayload {
  total_price?: string;
  created_at?: string;
}

// Shape returned by getMerchantCustomer (subset of customers.Row).
interface CustomerRow {
  id: string;
  merchant_id: string;
  shopify_customer_gid: string;
  total_order_count: number;
  total_ltv_cents: number;
  last_order_at: string | null;
  last_order_days_ago: number | null;
  profile_version: number;
}

/**
 * Rebuilds the materialised `customers` row from the full event log for a
 * single customer. Should be called after each webhook event write in Sprint 03
 * (eager-refresh on receipt). Sprint 04 adds a nightly batch that calls this
 * for all customers so the profile is always consistent with the event log.
 *
 * Returns the updated customers row, or null if no rows were found for this
 * customer (the upsert will have created one).
 */
export async function materializeCustomer(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  shopifyCustomerGid: string,
): Promise<CustomerRow | null> {
  // 1. Read all order_events for this customer to recalculate financials.
  const { data: orderEvents } = await serviceClient
    .from("order_events")
    .select("payload,occurred_at")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", shopifyCustomerGid)
    .in("event_type", ["order_paid", "order_backfilled"]);

  const orders = orderEvents ?? [];

  let totalOrderCount = 0;
  let totalLtvCents = 0;
  let lastOrderAt: string | null = null;

  for (const ev of orders) {
    const p = ev.payload as OrderPayload;
    const priceCents = Math.round(parseFloat(p.total_price ?? "0") * 100);
    totalOrderCount += 1;
    totalLtvCents += isNaN(priceCents) ? 0 : priceCents;

    if (!lastOrderAt || ev.occurred_at > lastOrderAt) {
      lastOrderAt = ev.occurred_at;
    }
  }

  // 2. Compute last_order_days_ago from lastOrderAt.
  let lastOrderDaysAgo: number | null = null;
  if (lastOrderAt) {
    const msAgo = Date.now() - new Date(lastOrderAt).getTime();
    lastOrderDaysAgo = Math.floor(msAgo / (1000 * 60 * 60 * 24));
  }

  // 3. Read the current customers row to get profile_version.
  const { data: existing } = await serviceClient
    .from("customers")
    .select("id,profile_version")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", shopifyCustomerGid)
    .maybeSingle();

  const nextVersion = (existing?.profile_version ?? 0) + 1;

  // 4. Upsert the rebuilt profile row.
  const { data: updated } = await serviceClient
    .from("customers")
    .upsert(
      {
        merchant_id: merchantId,
        shopify_customer_gid: shopifyCustomerGid,
        total_order_count: totalOrderCount,
        total_ltv_cents: totalLtvCents,
        last_order_at: lastOrderAt,
        last_order_days_ago: lastOrderDaysAgo,
        profile_version: nextVersion,
      },
      { onConflict: "merchant_id,shopify_customer_gid" },
    )
    .select()
    .maybeSingle();

  return (updated as CustomerRow | null) ?? null;
}
