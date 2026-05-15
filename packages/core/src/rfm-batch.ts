import type { LapsedSupabaseClient } from "@lapsed/db";
import type { LifecycleStage, CustomerSnapshot } from "./customer-lifecycle";
import { classifyLifecycle } from "./customer-lifecycle";
import { assignGroups } from "./customer-groups";
import type { MerchantContext } from "./customer-groups";
import { appendCustomerEvent } from "./customer-events";

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

interface LastEventRow {
  occurred_at: string;
}

interface SnapshotResult {
  snapshot: CustomerSnapshot;
  engagementEventsInPast30Days: number;
}

/**
 * Build a CustomerSnapshot for a single customer by querying their events.
 * Also returns engagementEventsInPast30Days (needed by assignGroups but not
 * by classifyLifecycle, which uses the 180-day window).
 */
async function buildSnapshot(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  customer: CustomerRow,
  now: Date,
): Promise<SnapshotResult> {
  const gid = customer.shopify_customer_gid;

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

  const SYSTEM_EVENTS = "(customer_created,customer_updated,customer_backfilled,customer_scored)";

  // Count engagement events (non-identity) in past 180 days.
  const cutoff180d = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
  const { count: engagementCount, error: ceErr } = await serviceClient
    .from("customer_events")
    .select("*", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", gid)
    .not("event_type", "in", SYSTEM_EVENTS)
    .gte("occurred_at", cutoff180d.toISOString());

  if (ceErr) throw ceErr;

  // Count engagement events (non-identity) in past 30 days — for assignGroups.
  const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const { count: engagement30dCount, error: ce30dErr } = await serviceClient
    .from("customer_events")
    .select("*", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", gid)
    .not("event_type", "in", SYSTEM_EVENTS)
    .gte("occurred_at", cutoff30d.toISOString());

  if (ce30dErr) throw ce30dErr;

  // Fetch previous lifecycle stage from customer_rfm (the last stable classification).
  const { data: rfmRow, error: rfmErr } = await serviceClient
    .from("customer_rfm")
    .select("lifecycle_stage")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", gid)
    .maybeSingle();

  if (rfmErr) throw rfmErr;

  const previousLifecycleStage = (rfmRow as RfmRow | null)?.lifecycle_stage ?? null;

  // Derive daysSinceLastScoredAsLapsed from the event log. Needed by classifyLifecycle
  // to detect won_back — how long ago was the customer last classified as lapsed?
  const { data: lastLapsedEvent, error: llErr } = await serviceClient
    .from("customer_events")
    .select("occurred_at")
    .eq("merchant_id", merchantId)
    .eq("shopify_customer_gid", gid)
    .eq("event_type", "customer_scored")
    .contains("payload", { lifecycle_stage: "lapsed" })
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (llErr) throw llErr;

  const daysSinceLastScoredAsLapsed = lastLapsedEvent
    ? Math.floor(
        (now.getTime() - new Date((lastLapsedEvent as LastEventRow).occurred_at).getTime()) /
          (1000 * 60 * 60 * 24),
      )
    : null;

  return {
    snapshot: {
      totalOrderCount: customer.total_order_count,
      lastOrderDaysAgo: customer.last_order_days_ago,
      firstOrderDaysAgo,
      ordersInPast12Months,
      previousLifecycleStage,
      daysSinceLastScoredAsLapsed,
      engagementEventsInPast180Days: engagementCount ?? 0,
    },
    engagementEventsInPast30Days: engagement30dCount ?? 0,
  };
}

/**
 * Run the nightly RFM + lifecycle batch for a single merchant.
 *
 * For each customer:
 *  1. Build a CustomerSnapshot from order_events and customer_events.
 *  2. Call classifyLifecycle — deterministic, pure.
 *  3. Write customer_scored event (Decision 1 — event-sourced memory graph).
 *  4. Upsert customer_rfm with raw RFM values + lifecycle_stage.
 *  5. Upsert customer_inferred_state with group_memberships (lifecycle_stage owned by scoring job).
 *
 * Idempotent: re-running produces the same state.
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

    if (custErr) {
      // Page-level error — stop this merchant's batch, count as one error.
      errors++;
      console.error(
        JSON.stringify({
          event: "rfm_batch_page_error",
          merchant_id: merchantId.slice(0, 8),
          error: custErr.message,
        }),
      );
      break;
    }

    const page = (customers ?? []) as CustomerRow[];
    hasMore = page.length === PAGE;
    offset += page.length;

    for (const customer of page) {
      try {
        const { snapshot, engagementEventsInPast30Days } = await buildSnapshot(
          serviceClient,
          merchantId,
          customer,
          now,
        );
        const lifecycle = classifyLifecycle(snapshot);
        const groupAssignments = assignGroups(
          {
            totalOrderCount: customer.total_order_count,
            totalLtvCents: Number(customer.total_ltv_cents),
            lastOrderDaysAgo: customer.last_order_days_ago,
            firstOrderDaysAgo: snapshot.firstOrderDaysAgo,
            lifecycle,
            engagementEventsInPast30Days,
          },
          merchantContext,
        );
        const groups = groupAssignments.map((g) => g.slug);

        const recencyDays = customer.last_order_days_ago;
        const totalLtv = Number(customer.total_ltv_cents);

        // Write customer_scored event BEFORE touching inferred state.
        // Decision 1: every customer state change is an appended event;
        // customer_inferred_state is a regeneratable cache.
        await appendCustomerEvent(serviceClient, {
          merchantId,
          shopifyCustomerGid: customer.shopify_customer_gid,
          eventType: "customer_scored",
          source: "rfm_batch",
          payload: { lifecycle_stage: lifecycle, group_memberships: groups },
          occurredAt: now.toISOString(),
        });

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

        // Upsert customer_inferred_state — group memberships only.
        // lifecycle_stage is intentionally omitted here: it is owned by the
        // scoring job (score-customers.ts writeScoreForCustomer) so that
        // customer_inferred_state.lifecycle_stage always reflects "lifecycle
        // at time of last scoring" while customer_rfm.lifecycle_stage reflects
        // "current RFM classification". The scoring job compares the two to
        // detect lifecycle transitions that occurred without new engagement events.
        const { error: stateUpsertErr } = await serviceClient
          .from("customer_inferred_state")
          .upsert(
            {
              merchant_id: merchantId,
              shopify_customer_gid: customer.shopify_customer_gid,
              group_memberships: groups,
            },
            { onConflict: "merchant_id,shopify_customer_gid" },
          );

        if (stateUpsertErr) throw stateUpsertErr;

        processed++;
      } catch (err) {
        errors++;
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
