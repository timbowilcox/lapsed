import type { LapsedSupabaseClient } from "@lapsed/db";

interface OrderPayload {
  total_price?: string;
}

// Fields read from the most-recent customer_created/updated event payload
// to rebuild identity columns from the event log on replay.
interface CustomerIdentityPayload {
  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  tags?: string | null;
}

interface CustomerRow {
  id: string;
  merchant_id: string;
  shopify_customer_gid: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  tags: string[];
  total_order_count: number;
  total_ltv_cents: number;
  last_order_at: string | null;
  last_order_days_ago: number | null;
  profile_version: number;
}

/**
 * Rebuilds the materialised `customers` row from the full event log for a
 * single customer. Called after each webhook event write (eager-refresh).
 * Sprint 04 adds a nightly batch that calls this for all customers.
 *
 * Identity fields (email, phone, name, tags) are rebuilt from the most-recent
 * customer_created / customer_updated event payload so that the customers table
 * can be fully reconstructed by replaying the event log alone.
 */
export async function materializeCustomer(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  shopifyCustomerGid: string,
): Promise<CustomerRow | null> {
  // 1. Read all order_events for this customer to recalculate financials.
  const { data: orderEvents, error: evErr } = await serviceClient
    .from("order_events")
    .select("payload,occurred_at")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", shopifyCustomerGid)
    .in("event_type", ["order_paid", "order_backfilled"]);

  if (evErr) throw evErr;

  const orders = orderEvents ?? [];

  let totalOrderCount = 0;
  let totalLtvCents = 0;
  let lastOrderAt: string | null = null;

  for (const ev of orders) {
    const p = ev.payload as OrderPayload;
    const priceCents = Math.round(parseFloat(p.total_price ?? "0") * 100);
    totalOrderCount += 1;
    totalLtvCents += isNaN(priceCents) ? 0 : priceCents;

    if (!lastOrderAt || new Date(ev.occurred_at) > new Date(lastOrderAt)) {
      lastOrderAt = ev.occurred_at;
    }
  }

  // 2. Compute last_order_days_ago from lastOrderAt.
  let lastOrderDaysAgo: number | null = null;
  if (lastOrderAt) {
    const msAgo = Date.now() - new Date(lastOrderAt).getTime();
    lastOrderDaysAgo = Math.floor(msAgo / (1000 * 60 * 60 * 24));
  }

  // 3. Read identity fields from the most-recent customer event payload so that
  //    the customers table can be fully rebuilt from the event log on replay.
  const { data: identityEvents, error: idErr } = await serviceClient
    .from("customer_events")
    .select("payload,occurred_at")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", shopifyCustomerGid)
    .in("event_type", ["customer_created", "customer_updated", "customer_backfilled"])
    .order("occurred_at", { ascending: false })
    .limit(1);

  if (idErr) throw idErr;

  const idPayload = (identityEvents?.[0]?.payload ?? {}) as CustomerIdentityPayload;
  const tags = idPayload.tags
    ? idPayload.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  // 4. Read the current customers row to get profile_version.
  const { data: existing, error: existErr } = await serviceClient
    .from("customers")
    .select("id,profile_version")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", shopifyCustomerGid)
    .maybeSingle();

  if (existErr) throw existErr;

  const nextVersion = (existing?.profile_version ?? 0) + 1;

  // 5. Upsert the rebuilt profile row.
  const { data: updated, error: upsertErr } = await serviceClient
    .from("customers")
    .upsert(
      {
        merchant_id: merchantId,
        shopify_customer_gid: shopifyCustomerGid,
        email: idPayload.email ?? null,
        phone: idPayload.phone ?? null,
        first_name: idPayload.first_name ?? null,
        last_name: idPayload.last_name ?? null,
        tags,
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

  if (upsertErr) throw upsertErr;

  return (updated as CustomerRow | null) ?? null;
}
