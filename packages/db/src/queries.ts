import type { LapsedSupabaseClient } from "./index";
import type { Database } from "./types";

type OrderRow = Database["public"]["Tables"]["orders"]["Row"];

type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];

export type CustomerInferredStateRow =
  Database["public"]["Tables"]["customer_inferred_state"]["Row"];

export type ScoringRunRow = Database["public"]["Tables"]["scoring_runs"]["Row"];

export type CustomerRfmRow = Database["public"]["Tables"]["customer_rfm"]["Row"];

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
 * Returns orders for a single customer, ordered by date descending.
 */
export async function getCustomerOrders(
  merchantClient: LapsedSupabaseClient,
  merchantId: string,
  shopifyCustomerGid: string,
): Promise<OrderRow[]> {
  const { data, error } = await merchantClient
    .from("orders")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", shopifyCustomerGid)
    .order("shopify_created_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * Returns the inferred state row for a single customer, or null if not yet scored.
 */
export async function getCustomerInferredState(
  merchantClient: LapsedSupabaseClient,
  merchantId: string,
  shopifyCustomerGid: string,
): Promise<CustomerInferredStateRow | null> {
  const { data, error } = await merchantClient
    .from("customer_inferred_state")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", shopifyCustomerGid)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * Returns lapsed customers with their inferred state merged in-memory, supporting
 * group filter, sort, and offset pagination.
 *
 * Two-query approach: fetch customer rows first, then fetch inferred_state rows for
 * those GIDs and merge. Avoids PostgREST join type complexity.
 */
export interface LapsedCustomersWithSignalsPage {
  data: Array<CustomerRow & { inferred_state: CustomerInferredStateRow | null }>;
  nextCursor: number | null;
  totalCount: number | null;
}

export async function getLapsedCustomersWithSignals(
  merchantClient: LapsedSupabaseClient,
  opts: {
    limit: number;
    cursor?: number;
    groupFilter?: string[];
    sortBy?: "propensity_90d" | "last_order_at" | "total_ltv_cents";
  },
): Promise<LapsedCustomersWithSignalsPage> {
  const { limit, cursor = 0, groupFilter, sortBy = "propensity_90d" } = opts;

  if (groupFilter && groupFilter.length > 0) {
    // Group-filter path: fetch from customer_inferred_state first (group_memberships
    // is an array column only on that table), then join customer rows in-memory.
    const { data: stateRows, error: stateErr } = await merchantClient
      .from("customer_inferred_state")
      .select("*")
      .overlaps("group_memberships", groupFilter)
      .order(
        sortBy === "propensity_90d" ? "propensity_90d" : "updated_at",
        { ascending: false, nullsFirst: false },
      )
      .range(cursor, cursor + limit - 1);

    if (stateErr) throw stateErr;
    const states = stateRows ?? [];

    if (states.length === 0) {
      return { data: [], nextCursor: null, totalCount: 0 };
    }

    const gids = states.map((s) => s.shopify_customer_gid);
    const { data: customerRows, error: custErr, count } = await merchantClient
      .from("customers")
      .select("*", { count: "exact" })
      .in("shopify_customer_gid", gids)
      .not("lapsed_at", "is", null);

    if (custErr) throw custErr;

    const stateByGid = new Map(states.map((s) => [s.shopify_customer_gid, s]));
    const merged = (customerRows ?? []).map((c) => ({
      ...c,
      inferred_state: stateByGid.get(c.shopify_customer_gid) ?? null,
    }));

    return {
      data: merged,
      nextCursor: states.length === limit ? cursor + limit : null,
      totalCount: count,
    };
  }

  // No group filter: sort customers directly by the requested column.
  const from = cursor;
  const to = from + limit - 1;

  let customerQuery = merchantClient
    .from("customers")
    .select("*", { count: "exact" })
    .not("lapsed_at", "is", null);

  if (sortBy === "last_order_at") {
    customerQuery = customerQuery.order("last_order_at", { ascending: true, nullsFirst: false });
  } else if (sortBy === "total_ltv_cents") {
    customerQuery = customerQuery.order("total_ltv_cents", { ascending: false, nullsFirst: false });
  } else {
    // propensity_90d default: sort by lapsed_score (closest available proxy until scoring runs)
    customerQuery = customerQuery
      .order("lapsed_score", { ascending: false, nullsFirst: false })
      .order("last_order_at", { ascending: true, nullsFirst: false });
  }

  const { data: customerRows, error: custErr, count } = await customerQuery.range(from, to);
  if (custErr) throw custErr;

  const rows = customerRows ?? [];
  if (rows.length === 0) {
    return { data: [], nextCursor: null, totalCount: count };
  }

  // Fetch inferred state for the page of customers.
  const gids = rows.map((c) => c.shopify_customer_gid);
  const { data: stateRows, error: stateErr } = await merchantClient
    .from("customer_inferred_state")
    .select("*")
    .in("shopify_customer_gid", gids);

  if (stateErr) throw stateErr;

  const stateByGid = new Map((stateRows ?? []).map((s) => [s.shopify_customer_gid, s]));

  // If propensity sort is requested and scoring has run, re-sort by propensity_90d.
  let merged = rows.map((c) => ({
    ...c,
    inferred_state: stateByGid.get(c.shopify_customer_gid) ?? null,
  }));

  if (sortBy === "propensity_90d") {
    merged = merged.sort((a, b) => {
      const ap = a.inferred_state?.propensity_90d ?? -1;
      const bp = b.inferred_state?.propensity_90d ?? -1;
      return Number(bp) - Number(ap);
    });
  }

  return {
    data: merged,
    nextCursor: rows.length === limit ? cursor + limit : null,
    totalCount: count,
  };
}

/**
 * Returns count of customers with propensity_30d >= threshold — the
 * "Ready to reactivate" dashboard hero number.
 */
export async function getReadyToReactivateCount(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  threshold: number,
): Promise<number> {
  const { count, error } = await serviceClient
    .from("customer_inferred_state")
    .select("*", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .gte("propensity_30d", threshold);

  if (error) throw error;
  return count ?? 0;
}

/**
 * Returns the most recent completed scoring run for a merchant, or null.
 */
export async function getLatestScoringRun(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
): Promise<ScoringRunRow | null> {
  const { data, error } = await serviceClient
    .from("scoring_runs")
    .select("*")
    .eq("merchant_id", merchantId)
    .in("status", ["succeeded", "failed"])
    .order("started_at", { ascending: false })
    .limit(1)
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
      .select("last_backfill_at")
      .eq("id", merchantId)
      .maybeSingle(),
  ]);

  if (countResult.error) throw countResult.error;
  if (merchantResult.error) throw merchantResult.error;

  const merchant = merchantResult.data;
  return {
    total_lapsed_count: countResult.count ?? 0,
    last_synced_at: merchant?.last_backfill_at ?? null,
  };
}
