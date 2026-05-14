import type { LapsedSupabaseClient } from "./index";
import type { Database } from "./types";

type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];

export interface LapsedCustomersPage {
  data: CustomerRow[];
  nextCursor: number | null;
}

export interface MerchantSummaryRow {
  total_lapsed_count: number;
  last_synced_at: string | null;
}

/**
 * Returns customers where lapsed_at IS NOT NULL, ordered by lapsed_score
 * descending (most urgent first). Accepts an integer offset cursor for
 * forward-only keyset pagination.
 */
export async function getLapsedCustomers(
  merchantClient: LapsedSupabaseClient,
  opts: { limit: number; cursor?: number },
): Promise<LapsedCustomersPage> {
  const { limit, cursor = 0 } = opts;
  const from = cursor;
  const to = from + limit - 1;

  const { data, error } = await merchantClient
    .from("customers")
    .select("*")
    .not("lapsed_at", "is", null)
    .order("lapsed_score", { ascending: false, nullsFirst: false })
    .order("last_order_at", { ascending: true, nullsFirst: false })
    .range(from, to);

  if (error) throw error;

  const rows = data ?? [];
  return {
    data: rows,
    nextCursor: rows.length === limit ? cursor + limit : null,
  };
}

/**
 * Returns a single customer row by merchant + Shopify GID, or null if not found.
 * The explicit merchant_id filter provides defense-in-depth beyond RLS alone.
 */
export async function getCustomer(
  merchantClient: LapsedSupabaseClient,
  merchantId: string,
  shopifyCustomerGid: string,
): Promise<CustomerRow | null> {
  const { data, error } = await merchantClient
    .from("customers")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", shopifyCustomerGid)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Returns a merchant-level summary: total lapsed customer count and the
 * last time data was synced from Shopify.
 */
export async function getMerchantSummary(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
): Promise<MerchantSummaryRow> {
  const [countResult, merchantResult] = await Promise.all([
    serviceClient
      .from("customers")
      .select("*", { count: "exact", head: true })
      .eq("merchant_id", merchantId)
      .not("lapsed_at", "is", null),
    serviceClient
      .from("merchants")
      .select("last_backfill_at, updated_at")
      .eq("id", merchantId)
      .maybeSingle(),
  ]);

  if (countResult.error) throw countResult.error;
  if (merchantResult.error) throw merchantResult.error;

  const merchant = merchantResult.data;
  return {
    total_lapsed_count: countResult.count ?? 0,
    last_synced_at: merchant?.last_backfill_at ?? merchant?.updated_at ?? null,
  };
}
