// Attribution backfill tests — Sprint 09 chunk 4.
//
// The backfill re-computes existing attribution_results rows under the
// symmetric-ITT methodology and audits old vs new into subscription_events.
// It is idempotent and never deletes a row.

import { describe, expect, it } from "vitest";
import { runAttributionBackfill } from "../src/attribution-backfill";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";

const day = (n: number): string =>
  new Date(Date.UTC(2026, 3, 1) + n * 86_400_000).toISOString();

/**
 * Seeds a campaign with `sentCount` sent-to treatment customers + `optOutCount`
 * never-sent ITT customers (snapshot rows only) + `holdoutCount` holdout
 * customers. `treatmentBuyers` of the sent customers and `holdoutBuyers` of the
 * holdout customers each place one `cents` order on day 5. Plus one existing
 * attribution_results row carrying the supplied pre-backfill (old) values.
 */
function seed(opts: {
  sentCount: number;
  optOutCount: number;
  holdoutCount: number;
  treatmentBuyers: number;
  holdoutBuyers: number;
  cents?: number;
  oldRow: Partial<FakeRow>;
  subscriptionEvents?: FakeRow[];
}) {
  const cents = opts.cents ?? 5000;
  const conversations: FakeRow[] = [];
  const messages: FakeRow[] = [];
  const snapshots: FakeRow[] = [];
  const orders: FakeRow[] = [];

  for (let i = 0; i < opts.sentCount; i++) {
    const cid = `t${i}`;
    conversations.push({ id: `conv-${cid}`, merchant_id: MERCHANT, customer_id: cid });
    snapshots.push({
      proposal_id: CAMPAIGN,
      merchant_id: MERCHANT,
      customer_id: cid,
      included_in_holdout: false,
    });
    messages.push({
      id: `m${i}`,
      merchant_id: MERCHANT,
      conversation_id: `conv-${cid}`,
      direction: "outbound",
      campaign_id: CAMPAIGN,
      arm_id: `arm-0`,
      sent_at: day(0),
    });
  }
  // Never-sent ITT customers: snapshot rows only.
  for (let i = 0; i < opts.optOutCount; i++) {
    snapshots.push({
      proposal_id: CAMPAIGN,
      merchant_id: MERCHANT,
      customer_id: `x${i}`,
      included_in_holdout: false,
    });
  }
  for (let i = 0; i < opts.holdoutCount; i++) {
    snapshots.push({
      proposal_id: CAMPAIGN,
      merchant_id: MERCHANT,
      customer_id: `h${i}`,
      included_in_holdout: true,
    });
  }
  let seq = 0;
  for (let i = 0; i < opts.treatmentBuyers; i++) {
    orders.push({
      id: `o${seq++}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: `t${i}`,
      total_price_cents: cents,
      shopify_created_at: day(5),
    });
  }
  for (let i = 0; i < opts.holdoutBuyers; i++) {
    orders.push({
      id: `o${seq++}`,
      merchant_id: MERCHANT,
      shopify_customer_gid: `h${i}`,
      total_price_cents: cents,
      shopify_created_at: day(5),
    });
  }

  return makeFakeSupabase({
    merchants: [{ id: MERCHANT }],
    campaign_proposals: [
      { id: CAMPAIGN, merchant_id: MERCHANT, status: "approved", attribution_window_days: 14 },
    ],
    conversations,
    messages,
    campaign_group_snapshots: snapshots,
    orders,
    ltv_snapshots: [],
    attribution_results: [
      {
        id: "ar-1",
        merchant_id: MERCHANT,
        campaign_id: CAMPAIGN,
        window_close_date: "2026-04-15",
        treatment_cohort_size: 0,
        holdout_cohort_size: 0,
        treatment_revenue_cents: 0,
        holdout_revenue_cents: 0,
        incremental_revenue_cents: 0,
        incremental_ci_low_cents: null,
        incremental_ci_high_cents: null,
        ltv_restored_cents: 0,
        ltv_ci_low_cents: null,
        ltv_ci_high_cents: null,
        insufficient_evidence: false,
        computed_at: day(16),
        ...opts.oldRow,
      },
    ],
    subscription_events: opts.subscriptionEvents ?? [],
  });
}

describe("runAttributionBackfill", () => {
  it("recomputes a row under symmetric ITT — ITT denominator grows, incremental shrinks", async () => {
    // Sprint 08 row: as-attempted treatment cohort of 60, incremental $1400.
    // Under symmetric ITT the cohort is 100 (60 sent + 40 opt-out). Treatment
    // revenue is unchanged ($50 × 40 buyers = $2000), so treatment_per_customer
    // falls from 200000/60 ≈ 3333 to 200000/100 = 2000 → incremental shrinks.
    const { client, tables } = seed({
      sentCount: 60,
      optOutCount: 40,
      holdoutCount: 40,
      treatmentBuyers: 40,
      holdoutBuyers: 8,
      oldRow: {
        treatment_cohort_size: 60,
        holdout_cohort_size: 40,
        treatment_revenue_cents: 200_000,
        holdout_revenue_cents: 40_000,
        incremental_revenue_cents: 140_000,
      },
    });
    const result = await runAttributionBackfill(client);

    expect(result.rowsScanned).toBe(1);
    expect(result.rowsMigrated).toBe(1);
    expect(result.errors).toBe(0);

    // Row updated IN PLACE — same id, recomputed values.
    const row = tables.attribution_results![0]!;
    expect(row.id).toBe("ar-1");
    expect(row.treatment_cohort_size).toBe(100); // full ITT denominator
    expect(row.holdout_cohort_size).toBe(40);
    expect(row.treatment_revenue_cents).toBe(200_000); // revenue unchanged
    // treatment per-customer 2000, holdout per-customer 1000 → +1000 × 100.
    expect(row.incremental_revenue_cents).toBe(100_000);
    // The new incremental is SMALLER than the old as-attempted figure.
    expect(row.incremental_revenue_cents).toBeLessThan(140_000);
  });

  it("writes an audit event capturing old AND new values for every changed row", async () => {
    const { client, tables } = seed({
      sentCount: 60,
      optOutCount: 40,
      holdoutCount: 40,
      treatmentBuyers: 40,
      holdoutBuyers: 8,
      oldRow: {
        treatment_cohort_size: 60,
        holdout_cohort_size: 40,
        treatment_revenue_cents: 200_000,
        holdout_revenue_cents: 40_000,
        incremental_revenue_cents: 140_000,
      },
    });
    await runAttributionBackfill(client);

    const events = (tables.subscription_events ?? []).filter(
      (e) => e.event_type === "attribution_methodology_migration",
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.merchant_id).toBe(MERCHANT);
    expect(ev.stripe_event_id).toBeNull();
    const data = ev.data as {
      campaign_id: string;
      window_close_date: string;
      old: { treatment_cohort_size: number; incremental_revenue_cents: number };
      new: { treatment_cohort_size: number; incremental_revenue_cents: number };
      delta_incremental_cents: number;
    };
    expect(data.campaign_id).toBe(CAMPAIGN);
    expect(data.window_close_date).toBe("2026-04-15");
    // Old values preserved exactly as they were before the backfill.
    expect(data.old.treatment_cohort_size).toBe(60);
    expect(data.old.incremental_revenue_cents).toBe(140_000);
    // New values match the recompute.
    expect(data.new.treatment_cohort_size).toBe(100);
    expect(data.new.incremental_revenue_cents).toBe(100_000);
    expect(data.delta_incremental_cents).toBe(100_000 - 140_000); // −40000
  });

  it("is idempotent — a re-run produces zero new audit events and identical rows", async () => {
    const { client, tables } = seed({
      sentCount: 60,
      optOutCount: 40,
      holdoutCount: 40,
      treatmentBuyers: 40,
      holdoutBuyers: 8,
      oldRow: {
        treatment_cohort_size: 60,
        holdout_cohort_size: 40,
        treatment_revenue_cents: 200_000,
        holdout_revenue_cents: 40_000,
        incremental_revenue_cents: 140_000,
      },
    });
    const first = await runAttributionBackfill(client);
    expect(first.rowsMigrated).toBe(1);
    const rowAfter1 = { ...tables.attribution_results![0]! };
    const eventsAfter1 = (tables.subscription_events ?? []).length;

    const second = await runAttributionBackfill(client);
    expect(second.rowsMigrated).toBe(0);
    expect(second.rowsAlreadyMigrated).toBe(1); // skipped via the audit ledger
    expect((tables.subscription_events ?? []).length).toBe(eventsAfter1); // no new events
    expect(tables.attribution_results![0]!).toEqual(rowAfter1); // identical row
  });

  it("leaves an already-correct row untouched and writes no audit event", async () => {
    // A not-launched campaign (no outbounds) recomputes to all-zero values —
    // identical to the seeded all-zero old row — so nothing is migrated or
    // audited: the recompute snapshot equals the stored snapshot.
    const { client, tables } = seed({
      sentCount: 0,
      optOutCount: 0,
      holdoutCount: 0,
      treatmentBuyers: 0,
      holdoutBuyers: 0,
      oldRow: {}, // seed default: every audited field already 0 / null
    });
    const result = await runAttributionBackfill(client);
    expect(result.rowsUnchanged).toBe(1);
    expect(result.rowsMigrated).toBe(0);
    expect(tables.subscription_events ?? []).toHaveLength(0);
  });

  it("self-heals a row whose audit event exists but whose UPDATE never landed", async () => {
    // Simulates a prior run that wrote the audit event then crashed before the
    // row UPDATE: the audit event is present, but the row still holds the OLD
    // (pre-migration) values. The re-run must detect the mismatch and re-apply.
    const { client, tables } = seed({
      sentCount: 60,
      optOutCount: 40,
      holdoutCount: 40,
      treatmentBuyers: 40,
      holdoutBuyers: 8,
      oldRow: {
        treatment_cohort_size: 60, // stale — UPDATE never landed
        holdout_cohort_size: 40,
        treatment_revenue_cents: 200_000,
        holdout_revenue_cents: 40_000,
        incremental_revenue_cents: 140_000,
      },
      subscriptionEvents: [
        {
          id: "evt-prior",
          merchant_id: MERCHANT,
          stripe_event_id: null,
          event_type: "attribution_methodology_migration",
          data: { campaign_id: CAMPAIGN, window_close_date: "2026-04-15" },
        },
      ],
    });
    const result = await runAttributionBackfill(client);

    expect(result.rowsHealed).toBe(1);
    expect(result.rowsMigrated).toBe(0); // not re-migrated — the audit key exists
    // The row is now reconciled to the symmetric-ITT values.
    expect(tables.attribution_results![0]!.treatment_cohort_size).toBe(100);
    expect(tables.attribution_results![0]!.incremental_revenue_cents).toBe(100_000);
    // No SECOND audit event written — the original prior event stands.
    expect(
      (tables.subscription_events ?? []).filter(
        (e) => e.event_type === "attribution_methodology_migration",
      ),
    ).toHaveLength(1);
  });

  it("processes multiple attribution_results rows in one run", async () => {
    const CAMPAIGN_B = "22222222-2222-4222-8222-222222222222";
    const conversations: FakeRow[] = [];
    const messages: FakeRow[] = [];
    const snapshots: FakeRow[] = [];
    const orders: FakeRow[] = [];
    let oseq = 0;
    for (const cid of [CAMPAIGN, CAMPAIGN_B]) {
      for (let i = 0; i < 60; i++) {
        const cust = `${cid}-t${i}`;
        conversations.push({ id: `conv-${cust}`, merchant_id: MERCHANT, customer_id: cust });
        snapshots.push({
          proposal_id: cid,
          merchant_id: MERCHANT,
          customer_id: cust,
          included_in_holdout: false,
        });
        messages.push({
          id: `m-${cust}`,
          merchant_id: MERCHANT,
          conversation_id: `conv-${cust}`,
          direction: "outbound",
          campaign_id: cid,
          arm_id: "arm-0",
          sent_at: day(0),
        });
        if (i < 40) {
          orders.push({
            id: `o${oseq++}`,
            merchant_id: MERCHANT,
            shopify_customer_gid: cust,
            total_price_cents: 5000,
            shopify_created_at: day(5),
          });
        }
      }
      for (let i = 0; i < 40; i++) {
        snapshots.push({
          proposal_id: cid,
          merchant_id: MERCHANT,
          customer_id: `${cid}-x${i}`,
          included_in_holdout: false,
        });
      }
      for (let i = 0; i < 40; i++) {
        snapshots.push({
          proposal_id: cid,
          merchant_id: MERCHANT,
          customer_id: `${cid}-h${i}`,
          included_in_holdout: true,
        });
        if (i < 8) {
          orders.push({
            id: `o${oseq++}`,
            merchant_id: MERCHANT,
            shopify_customer_gid: `${cid}-h${i}`,
            total_price_cents: 5000,
            shopify_created_at: day(5),
          });
        }
      }
    }
    const arRow = (id: string, campaignId: string): FakeRow => ({
      id,
      merchant_id: MERCHANT,
      campaign_id: campaignId,
      window_close_date: "2026-04-15",
      treatment_cohort_size: 60,
      holdout_cohort_size: 40,
      treatment_revenue_cents: 200_000,
      holdout_revenue_cents: 40_000,
      incremental_revenue_cents: 140_000,
      incremental_ci_low_cents: null,
      incremental_ci_high_cents: null,
      ltv_restored_cents: 0,
      ltv_ci_low_cents: null,
      ltv_ci_high_cents: null,
      insufficient_evidence: false,
      computed_at: day(16),
    });
    const { client, tables } = makeFakeSupabase({
      merchants: [{ id: MERCHANT }],
      campaign_proposals: [
        { id: CAMPAIGN, merchant_id: MERCHANT, status: "approved", attribution_window_days: 14 },
        { id: CAMPAIGN_B, merchant_id: MERCHANT, status: "approved", attribution_window_days: 14 },
      ],
      conversations,
      messages,
      campaign_group_snapshots: snapshots,
      orders,
      ltv_snapshots: [],
      attribution_results: [arRow("ar-A", CAMPAIGN), arRow("ar-B", CAMPAIGN_B)],
      subscription_events: [],
    });
    const result = await runAttributionBackfill(client);

    expect(result.rowsScanned).toBe(2);
    expect(result.rowsMigrated).toBe(2);
    // One audit event per campaign, each keyed to its own (campaign, window).
    const events = (tables.subscription_events ?? []).filter(
      (e) => e.event_type === "attribution_methodology_migration",
    );
    expect(events).toHaveLength(2);
    const campaignIds = events.map((e) => (e.data as { campaign_id: string }).campaign_id).sort();
    expect(campaignIds).toEqual([CAMPAIGN, CAMPAIGN_B].sort());
    // Both rows recomputed to the symmetric-ITT cohort of 100.
    for (const row of tables.attribution_results!) {
      expect(row.treatment_cohort_size).toBe(100);
    }
  });

  it("counts a per-row recompute error without aborting the batch", async () => {
    const { client } = makeFakeSupabase(
      {
        merchants: [{ id: MERCHANT }],
        campaign_proposals: [],
        attribution_results: [
          {
            id: "ar-1",
            merchant_id: MERCHANT,
            campaign_id: CAMPAIGN,
            window_close_date: "2026-04-15",
            treatment_cohort_size: 60,
            holdout_cohort_size: 40,
            treatment_revenue_cents: 200_000,
            holdout_revenue_cents: 40_000,
            incremental_revenue_cents: 140_000,
            incremental_ci_low_cents: null,
            incremental_ci_high_cents: null,
            ltv_restored_cents: 0,
            ltv_ci_low_cents: null,
            ltv_ci_high_cents: null,
            insufficient_evidence: false,
            computed_at: day(16),
          },
        ],
        subscription_events: [],
      },
    );
    // computeIncrementalRevenue throws — the campaign proposal does not exist.
    const result = await runAttributionBackfill(client);
    expect(result.errors).toBe(1);
    expect(result.rowsMigrated).toBe(0);
  });
});
