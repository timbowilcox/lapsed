/**
 * Unit tests for the Sprint 08 attribution read helpers
 * (getCampaignAttribution, getMerchantAttributionRollup).
 *
 * Uses a filter-aware in-memory mock Supabase client — no network or real DB.
 */

import { describe, expect, it } from "vitest";
import type { LapsedSupabaseClient } from "../src/index";
import { getCampaignAttribution, getMerchantAttributionRollup } from "../src/queries";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_MERCHANT = "660e8400-e29b-41d4-a716-446655440000";
const CAMPAIGN = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function makeClient(tables: Tables): LapsedSupabaseClient {
  function builder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    let limitN: number | null = null;

    function run() {
      let rows = (tables[table] ?? []).slice();
      for (const [c, v] of eqs) rows = rows.filter((r) => r[c] === v);
      for (const [c, vs] of ins) rows = rows.filter((r) => vs.includes(r[c]));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    const qb: Record<string, unknown> = {};
    qb.select = () => qb;
    qb.eq = (c: string, v: unknown) => {
      eqs.push([c, v]);
      return qb;
    };
    qb.in = (c: string, vs: unknown[]) => {
      ins.push([c, vs]);
      return qb;
    };
    qb.order = () => qb;
    qb.limit = (n: number) => {
      limitN = n;
      return qb;
    };
    qb.maybeSingle = () => Promise.resolve({ data: run()[0] ?? null, error: null });
    qb.then = (onF: (v: { data: Row[]; error: null }) => unknown) =>
      Promise.resolve(onF({ data: run(), error: null }));
    return qb;
  }
  return { from: (t: string) => builder(t) } as unknown as LapsedSupabaseClient;
}

const proposal = (id: string, merchantId: string, slug = "lapsed_vips"): Row => ({
  id,
  merchant_id: merchantId,
  group_slug: slug,
  attribution_window_days: 14,
});

const resultRow = (campaignId: string, merchantId: string, over: Row = {}): Row => ({
  id: `res-${campaignId}`,
  campaign_id: campaignId,
  merchant_id: merchantId,
  window_close_date: "2026-05-15",
  treatment_cohort_size: 40,
  holdout_cohort_size: 30,
  treatment_revenue_cents: 200000,
  holdout_revenue_cents: 30000,
  incremental_revenue_cents: 170000,
  incremental_ci_low_cents: 90000,
  incremental_ci_high_cents: 250000,
  ltv_restored_cents: 150000,
  ltv_ci_low_cents: 80000,
  ltv_ci_high_cents: 220000,
  insufficient_evidence: false,
  computed_at: "2026-05-16T06:00:00.000Z",
  ...over,
});

describe("getCampaignAttribution", () => {
  it("returns null for a campaign that does not belong to the merchant", async () => {
    const client = makeClient({
      campaign_proposals: [proposal(CAMPAIGN, OTHER_MERCHANT)],
    });
    expect(await getCampaignAttribution(client, MERCHANT, CAMPAIGN)).toBeNull();
  });

  it("returns the view with a null result when the batch has not run", async () => {
    const client = makeClient({
      campaign_proposals: [proposal(CAMPAIGN, MERCHANT)],
      attribution_results: [],
      attribution_decisions: [],
    });
    const view = await getCampaignAttribution(client, MERCHANT, CAMPAIGN);
    expect(view).not.toBeNull();
    expect(view!.result).toBeNull();
    expect(view!.attributionWindowDays).toBe(14);
    expect(view!.attributedOrders).toEqual([]);
  });

  it("returns the materialised result and its attributed orders", async () => {
    const client = makeClient({
      campaign_proposals: [proposal(CAMPAIGN, MERCHANT)],
      attribution_results: [resultRow(CAMPAIGN, MERCHANT)],
      attribution_decisions: [
        {
          id: "d1",
          merchant_id: MERCHANT,
          attributed_campaign_id: CAMPAIGN,
          decision_type: "attributed",
          order_id: "ord-1",
          customer_id: "gid://shopify/Customer/1",
          attributed_message_id: "msg-1",
          decided_at: "2026-05-10T00:00:00.000Z",
        },
      ],
      orders: [
        {
          id: "ord-1",
          merchant_id: MERCHANT,
          total_price_cents: 5000,
          shopify_created_at: "2026-05-09T00:00:00.000Z",
        },
      ],
    });
    const view = await getCampaignAttribution(client, MERCHANT, CAMPAIGN);
    expect(view!.result!.incremental_revenue_cents).toBe(170000);
    expect(view!.attributedOrders).toHaveLength(1);
    expect(view!.attributedOrders[0]!.orderId).toBe("ord-1");
    expect(view!.attributedOrders[0]!.totalPriceCents).toBe(5000);
  });

  it("omits an attributed decision whose order row is missing (no $0 phantom order)", async () => {
    const client = makeClient({
      campaign_proposals: [proposal(CAMPAIGN, MERCHANT)],
      attribution_results: [resultRow(CAMPAIGN, MERCHANT)],
      attribution_decisions: [
        {
          id: "d1",
          merchant_id: MERCHANT,
          attributed_campaign_id: CAMPAIGN,
          decision_type: "attributed",
          order_id: "ord-missing",
          customer_id: "gid://shopify/Customer/1",
          attributed_message_id: "msg-1",
          decided_at: "2026-05-10T00:00:00.000Z",
        },
      ],
      orders: [],
    });
    const view = await getCampaignAttribution(client, MERCHANT, CAMPAIGN);
    expect(view!.attributedOrders).toEqual([]);
  });
});

describe("getMerchantAttributionRollup", () => {
  it("returns one entry per materialised result, joined to the group slug", async () => {
    const client = makeClient({
      attribution_results: [
        resultRow(CAMPAIGN, MERCHANT),
        resultRow("22222222-2222-4222-8222-222222222222", MERCHANT, {
          window_close_date: "2026-04-01",
        }),
      ],
      campaign_proposals: [
        proposal(CAMPAIGN, MERCHANT, "lapsed_vips"),
        proposal("22222222-2222-4222-8222-222222222222", MERCHANT, "at_risk_regulars"),
      ],
    });
    const rollup = await getMerchantAttributionRollup(client, MERCHANT);
    expect(rollup.campaigns).toHaveLength(2);
    const slugs = rollup.campaigns.map((c) => c.groupSlug).sort();
    expect(slugs).toEqual(["at_risk_regulars", "lapsed_vips"]);
  });

  it("excludes another merchant's attribution results", async () => {
    const client = makeClient({
      attribution_results: [
        resultRow(CAMPAIGN, MERCHANT),
        resultRow("33333333-3333-4333-8333-333333333333", OTHER_MERCHANT),
      ],
      campaign_proposals: [proposal(CAMPAIGN, MERCHANT)],
    });
    const rollup = await getMerchantAttributionRollup(client, MERCHANT);
    expect(rollup.campaigns).toHaveLength(1);
    expect(rollup.campaigns[0]!.campaignId).toBe(CAMPAIGN);
  });

  it("returns an empty list when the merchant has no results", async () => {
    const client = makeClient({ attribution_results: [], campaign_proposals: [] });
    const rollup = await getMerchantAttributionRollup(client, MERCHANT);
    expect(rollup.campaigns).toEqual([]);
  });
});
