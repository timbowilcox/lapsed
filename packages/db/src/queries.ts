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
    // Group-filter path: drive pagination from customer_inferred_state (the only table
    // with group_memberships). Fetch a page of scored rows, then hydrate with customer
    // identity data. The totalCount is from the inferred_state count query so it reflects
    // the full group-filtered population, not just the current page's customer matches.
    const stateCol =
      sortBy === "propensity_90d" ? "propensity_90d" :
      sortBy === "total_ltv_cents" ? "updated_at" : "updated_at";

    const { data: stateRows, error: stateErr, count: stateCount } = await merchantClient
      .from("customer_inferred_state")
      .select("*", { count: "exact" })
      .overlaps("group_memberships", groupFilter)
      .order(stateCol, { ascending: false, nullsFirst: false })
      .range(cursor, cursor + limit - 1);

    if (stateErr) throw stateErr;
    const states = stateRows ?? [];

    if (states.length === 0) {
      return { data: [], nextCursor: null, totalCount: stateCount ?? 0 };
    }

    const gids = states.map((s) => s.shopify_customer_gid);
    const { data: customerRows, error: custErr } = await merchantClient
      .from("customers")
      .select("*")
      .in("shopify_customer_gid", gids)
      .not("lapsed_at", "is", null);

    if (custErr) throw custErr;

    const customerByGid = new Map((customerRows ?? []).map((c) => [c.shopify_customer_gid, c]));
    const merged = states
      .filter((s) => customerByGid.has(s.shopify_customer_gid))
      .map((s) => ({ ...customerByGid.get(s.shopify_customer_gid)!, inferred_state: s }));

    return {
      data: merged,
      nextCursor: states.length === limit ? cursor + limit : null,
      totalCount: stateCount,
    };
  }

  // No group filter. When scoring has run, drive sort from customer_inferred_state for
  // propensity_90d (true total order). For other sorts, query customers directly.
  const from = cursor;
  const to = from + limit - 1;

  if (sortBy === "propensity_90d") {
    // Drive from inferred_state ordered by propensity_90d — gives true total order.
    const { data: stateRows, error: stateErr, count: stateCount } = await merchantClient
      .from("customer_inferred_state")
      .select("*", { count: "exact" })
      .order("propensity_90d", { ascending: false, nullsFirst: false })
      .range(from, to);

    if (stateErr) throw stateErr;
    const states = stateRows ?? [];

    if (states.length === 0) {
      // Scoring hasn't run yet — fall back to lapsed_score order.
      const { data: fbRows, error: fbErr, count: fbCount } = await merchantClient
        .from("customers")
        .select("*", { count: "exact" })
        .not("lapsed_at", "is", null)
        .order("lapsed_score", { ascending: false, nullsFirst: false })
        .range(from, to);

      if (fbErr) throw fbErr;
      const rows = (fbRows ?? []).map((c) => ({ ...c, inferred_state: null as CustomerInferredStateRow | null }));
      return {
        data: rows,
        nextCursor: rows.length === limit ? cursor + limit : null,
        totalCount: fbCount,
      };
    }

    const gids = states.map((s) => s.shopify_customer_gid);
    const { data: customerRows, error: custErr } = await merchantClient
      .from("customers")
      .select("*")
      .in("shopify_customer_gid", gids)
      .not("lapsed_at", "is", null);

    if (custErr) throw custErr;

    const customerByGid = new Map((customerRows ?? []).map((c) => [c.shopify_customer_gid, c]));
    const merged = states
      .filter((s) => customerByGid.has(s.shopify_customer_gid))
      .map((s) => ({ ...customerByGid.get(s.shopify_customer_gid)!, inferred_state: s }));

    return {
      data: merged,
      nextCursor: states.length === limit ? cursor + limit : null,
      totalCount: stateCount,
    };
  }

  // last_order_at or total_ltv_cents — drive directly from customers table.
  let customerQuery = merchantClient
    .from("customers")
    .select("*", { count: "exact" })
    .not("lapsed_at", "is", null);

  if (sortBy === "last_order_at") {
    // Most recently lapsed first (descending = purchased most recently = least urgent)
    // Ascending = oldest lapse first = most urgent for reactivation.
    customerQuery = customerQuery.order("last_order_at", { ascending: false, nullsFirst: false });
  } else {
    customerQuery = customerQuery.order("total_ltv_cents", { ascending: false, nullsFirst: false });
  }

  const { data: customerRows, error: custErr, count } = await customerQuery.range(from, to);
  if (custErr) throw custErr;

  const rows = customerRows ?? [];
  if (rows.length === 0) {
    return { data: [], nextCursor: null, totalCount: count };
  }

  // Hydrate with inferred state for the page.
  const gids = rows.map((c) => c.shopify_customer_gid);
  const { data: stateRows, error: stateErr } = await merchantClient
    .from("customer_inferred_state")
    .select("*")
    .in("shopify_customer_gid", gids);

  if (stateErr) throw stateErr;

  const stateByGid = new Map((stateRows ?? []).map((s) => [s.shopify_customer_gid, s]));
  const merged = rows.map((c) => ({
    ...c,
    inferred_state: stateByGid.get(c.shopify_customer_gid) ?? null,
  }));

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
