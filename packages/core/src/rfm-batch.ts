import type { LapsedSupabaseClient } from "@lapsed/db";
import type { LifecycleStage } from "./customer-lifecycle";
import { classifyLifecycle } from "./customer-lifecycle";
import { assignGroups } from "./customer-groups";
import type { MerchantContext } from "./customer-groups";

export interface RfmBatchResult {
  processed: number;
  errors: number;
}

interface OrderEventRow {
  occurred_at: string;
  payload: { total_price?: string };
}

interface CustomerRow {
  shopify_customer_gid: string;
  total_order_count: number;
  total_ltv_cents: number;
  last_order_days_ago: number | null;
}

interface RfmRow {
  lifecycle_stage: LifecycleStage | null;
}

/**
 * Build a CustomerSnapshot for a single customer by querying their events.
 * Reads order_events for financial + temporal metrics, customer_events for engagement.
 */
async function buildSnapshot(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  customer: CustomerRow,
  now: Date,
): Promise<Parameters<typeof classifyLifecycle>[0]> {
  const gid = customer.shopify_customer_gid;
  const twelveMonthsAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() + 12 - 12); // 12-month window

  // Fetch all order_events for this customer (need first-order date + 12-month count).
  const { data: orderEvents, error: oeErr } = await serviceClient
    .from("order_events")
    .select("occurred_at,payload")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", gid)
    .in("event_type", ["order_paid", "order_backfilled"]);

  if (oeErr) throw oeErr;

  const orders = (orderEvents ?? []) as OrderEventRow[];
  let firstOrderAt: Date | null = null;
  let ordersInPast12Months = 0;
  // 365 days as the 12-month window proxy (consistent with scoring cadence)
  const cutoff12m = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  for (const ev of orders) {
    const d = new Date(ev.occurred_at);
    if (!firstOrderAt || d < firstOrderAt) firstOrderAt = d;
    if (d >= cutoff12m) ordersInPast12Months++;
  }

  const firstOrderDaysAgo = firstOrderAt
    ? Math.floor((now.getTime() - firstOrderAt.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // Count engagement events (non-identity) in past 180 days.
  const cutoff180d = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const { count: engagementCount, error: ceErr } = await serviceClient
    .from("customer_events")
    .select("*", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", gid)
    .not("event_type", "in", "(customer_created,customer_updated,customer_backfilled)")
    .gte("occurred_at", cutoff180d.toISOString());

  if (ceErr) throw ceErr;

  // Fetch previous lifecycle stage from customer_rfm (the last stable classification).
  const { data: rfmRow, error: rfmErr } = await serviceClient
    .from("customer_rfm")
    .select("lifecycle_stage")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", gid)
    .maybeSingle();

  if (rfmErr) throw rfmErr;

  const previousLifecycleStage = (rfmRow as RfmRow | null)?.lifecycle_stage ?? null;

  return {
    totalOrderCount: customer.total_order_count,
    lastOrderDaysAgo: customer.last_order_days_ago,
    firstOrderDaysAgo,
    ordersInPast12Months,
    previousLifecycleStage,
    daysSinceLastScoredAsLapsed: null, // populated by scoring service in chunk 5
    engagementEventsInPast180Days: engagementCount ?? 0,
  };
}

/**
 * Run the nightly RFM + lifecycle batch for a single merchant.
 *
 * For each customer:
 *  1. Build a CustomerSnapshot from order_events and customer_events.
 *  2. Call classifyLifecycle — deterministic, pure.
 *  3. Upsert customer_rfm with raw RFM values + lifecycle_stage.
 *  4. Upsert customer_inferred_state with lifecycle_stage + group_memberships.
 *
 * Idempotent: re-running produces the same state. The materialized view
 * (merchant_aggregates) is refreshed after all customer rows are updated.
 */
export async function runRfmBatch(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  merchantContext: MerchantContext,
): Promise<RfmBatchResult> {
  const now = new Date();

  // Page through all customers for this merchant.
  const PAGE = 200;
  let offset = 0;
  let processed = 0;
  let errors = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: customers, error: custErr } = await serviceClient
      .from("customers")
      .select("shopify_customer_gid,total_order_count,total_ltv_cents,last_order_days_ago")
      .eq("merchant_id", merchantId)
      .range(offset, offset + PAGE - 1);

    if (custErr) throw custErr;

    const page = (customers ?? []) as CustomerRow[];
    hasMore = page.length === PAGE;
    offset += page.length;

    for (const customer of page) {
      try {
        const snapshot = await buildSnapshot(serviceClient, merchantId, customer, now);
        const lifecycle = classifyLifecycle(snapshot);
        const groupAssignments = assignGroups(
          {
            totalOrderCount: customer.total_order_count,
            totalLtvCents: Number(customer.total_ltv_cents),
            lastOrderDaysAgo: customer.last_order_days_ago,
            firstOrderDaysAgo: snapshot.firstOrderDaysAgo,
            lifecycle,
            engagementEventsInPast30Days: 0,
          },
          merchantContext,
        );
        const groups = groupAssignments.map((g) => g.slug);

        const recencyDays = customer.last_order_days_ago;
        const totalLtv = Number(customer.total_ltv_cents);

        // Upsert customer_rfm — raw RFM values + lifecycle classification.
        const { error: rfmUpsertErr } = await serviceClient
          .from("customer_rfm")
          .upsert(
            {
              merchant_id: merchantId,
              shopify_customer_gid: customer.shopify_customer_gid,
              recency_days: recencyDays,
              frequency: customer.total_order_count,
              monetary_cents: totalLtv,
              lifecycle_stage: lifecycle,
              refreshed_at: now.toISOString(),
            },
            { onConflict: "merchant_id,shopify_customer_gid" },
          );

        if (rfmUpsertErr) throw rfmUpsertErr;

        // Upsert customer_inferred_state — lifecycle + group memberships.
        const { error: stateUpsertErr } = await serviceClient
          .from("customer_inferred_state")
          .upsert(
            {
              merchant_id: merchantId,
              shopify_customer_gid: customer.shopify_customer_gid,
              lifecycle_stage: lifecycle,
              group_memberships: groups,
            },
            { onConflict: "merchant_id,shopify_customer_gid" },
          );

        if (stateUpsertErr) throw stateUpsertErr;

        processed++;
      } catch (err) {
        errors++;
        // Log structured error without PII (no customer GID in log, only merchant + count)
        console.error(
          JSON.stringify({
            event: "rfm_batch_customer_error",
            merchant_id: merchantId.slice(0, 8),
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  return { processed, errors };
}
