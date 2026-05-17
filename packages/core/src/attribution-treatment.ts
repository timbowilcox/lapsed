// Treatment cohort engine — Sprint 09 chunk 2 (symmetric-ITT refactor of the
// Sprint 08 chunk 4 original).
//
// SYMMETRIC ITT (decision 27). The treatment cohort of a campaign is the
// INTENT-TO-TREAT set: every customer frozen into `campaign_group_snapshots`
// at proposal time with `included_in_holdout = false` — exactly the mirror of
// the holdout cohort (`included_in_holdout = true`). This INCLUDES customers
// who opted out before the send, whose send failed, or who were deferred by
// the daily cap and never actually received an outbound. They contribute zero
// attributed revenue but count in the cohort denominator.
//
// This supersedes Sprint 08's as-attempted treatment cohort (customers sourced
// from `messages WHERE direction = outbound`), which biased incremental revenue
// upward: it excluded opt-outs / cap-deferred customers from the treatment
// denominator while the holdout denominator (always ITT) kept them. Percentage-
// of-incremental-revenue billing (Sprint 10) is only defensible when both
// cohorts are measured the same way.
//
// CALENDAR WINDOW (decision 27). Attributed orders are counted over the
// campaign-calendar window `[launched_at, launched_at + attribution_window_days]`
// — anchored at `launched_at` (the campaign's earliest outbound), NOT at each
// customer's own send time. Symmetric with `getHoldoutOrders`, which has always
// used a single calendar window.
//
// SINGLE-ATTRIBUTION (decision 21). A customer may be in several campaigns'
// treatment cohorts at once. An order is attributed to exactly ONE campaign:
// the most-recent outbound preceding the order, among all campaigns whose own
// calendar window covers the order. This module resolves that winner per order
// and only returns the orders this campaign won. A customer in the ITT snapshot
// who never received an outbound has no preceding outbound to win attribution —
// so they contribute zero orders to the campaign's attributed revenue, which is
// exactly the ITT semantics.
//
// All currency is integer cents (bigint in the DB, number here).

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { ATTRIBUTION_WINDOW_DAYS_DEFAULT } from "./attribution-config";
import { fetchAllRows, chunk, IN_CLAUSE_CHUNK } from "./paginate";

const DAY_MS = 86_400_000;

/**
 * Parses an ISO timestamp to epoch ms, throwing on a malformed value rather
 * than letting a silent NaN drop an order/outbound from attribution (which
 * would under-count billable revenue).
 */
function epochMs(iso: string, field: string, id: string): number {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`attribution-treatment: ${field} on ${id} is not a valid timestamp: ${iso}`);
  }
  return ms;
}

/** One campaign outbound to a customer (the join messages × conversations). */
export interface CampaignOutbound {
  messageId: string;
  customerId: string;
  campaignId: string;
  armId: string | null;
  sentAt: string;
}

/** An order single-attributed to a specific campaign + outbound. */
export interface AttributedOrder {
  orderId: string;
  customerId: string;
  totalPriceCents: number;
  placedAt: string;
  attributedMessageId: string;
  attributedArmId: string | null;
}

export interface TreatmentCohortResult {
  merchantId: string;
  campaignId: string;
  /** Attribution window stamped on the campaign proposal (decision 20). */
  windowDays: number;
  /**
   * The ITT treatment cohort (decision 27): every `campaign_group_snapshots`
   * customer for this proposal with `included_in_holdout = false`. INCLUDES
   * opt-outs and daily-cap-deferred customers — they count in the denominator
   * and contribute zero revenue.
   */
  cohort: string[];
  /**
   * Every outbound this campaign actually sent (one row per message). A subset
   * of the cohort received these; the rest of the ITT cohort got none. Used to
   * resolve the campaign's `launched_at` and single-attribution winners.
   */
  outbounds: CampaignOutbound[];
  /**
   * conversation_id → customer_id map for the merchant, loaded once by
   * getTreatmentCohort and reused by getTreatmentOrders so the conversations
   * table is scanned only once across the pair.
   */
  conversationCustomers: Map<string, string>;
}

export interface TreatmentOrdersResult {
  /** Orders single-attributed to THIS campaign (decision 21). */
  orders: AttributedOrder[];
  /** Sum of attributed orders' total_price_cents. */
  revenueCents: number;
  /** Distinct customers among the attributed orders. */
  customersWithOrders: number;
  /**
   * Per-customer attributed revenue in cents, ONE entry per cohort customer
   * (0 when the customer placed no attributed order). This is the treatment
   * distribution Welch's t-test consumes in chunk 6 — its length equals the
   * ITT treatment cohort size.
   */
  perCustomerRevenueCents: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal row helpers
// ─────────────────────────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  conversation_id: string;
  campaign_id: string | null;
  arm_id: string | null;
  sent_at: string;
}

interface OrderRow {
  id: string;
  shopify_customer_gid: string;
  total_price_cents: number;
  shopify_created_at: string;
}

/** Builds a conversation_id → customer_id map for a merchant (fully paged). */
async function loadConversationCustomers(
  client: LapsedSupabaseClient,
  merchantId: string,
): Promise<Map<string, string>> {
  const rows = await fetchAllRows<{ id: string; customer_id: string }>((from, to) =>
    client
      .from("conversations")
      .select("id, customer_id")
      .eq("merchant_id", merchantId)
      .range(from, to),
  );
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.id, row.customer_id);
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// getTreatmentCohort
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a campaign's ITT treatment cohort (decision 27): the frozen
 * `campaign_group_snapshots` customers for this proposal where
 * `included_in_holdout = false`. The cohort is the snapshot — never a live
 * recompute, never derived from who actually received a send. The campaign's
 * outbound messages are also loaded (they anchor `launched_at` and resolve
 * single-attribution), but they do NOT define cohort membership.
 *
 * The attribution window is read from the proposal's stamped
 * `attribution_window_days` (decision 20) — the single source of truth.
 */
export async function getTreatmentCohort(
  client: LapsedSupabaseClient,
  campaignId: string,
): Promise<TreatmentCohortResult> {
  z.string().uuid("campaignId must be a UUID").parse(campaignId);

  // Resolve the merchant + the stamped attribution window.
  const { data: proposal, error: proposalErr } = await client
    .from("campaign_proposals")
    .select("merchant_id, attribution_window_days")
    .eq("id", campaignId)
    .maybeSingle();
  if (proposalErr) throw proposalErr;
  if (!proposal) {
    throw new Error(`getTreatmentCohort: campaign proposal ${campaignId} not found`);
  }
  const merchantId = proposal.merchant_id as string;
  const windowDays = (proposal.attribution_window_days as number | null)
    ?? ATTRIBUTION_WINDOW_DAYS_DEFAULT;

  // The ITT treatment cohort — the frozen snapshot's non-holdout customers
  // (decision 27). Mirror of getHoldoutCohort's `included_in_holdout = true`.
  const snapshotRows = await fetchAllRows<{ customer_id: string }>((from, to) =>
    client
      .from("campaign_group_snapshots")
      .select("customer_id")
      .eq("proposal_id", campaignId)
      .eq("included_in_holdout", false)
      .range(from, to),
  );
  const cohort = [...new Set(snapshotRows.map((r) => r.customer_id))].sort();

  // This campaign's outbound messages (paged — a campaign can exceed 1000).
  // These anchor launched_at and resolve single-attribution; they do NOT
  // define cohort membership.
  const messageRows = await fetchAllRows<MessageRow>((from, to) =>
    client
      .from("messages")
      .select("id, conversation_id, campaign_id, arm_id, sent_at")
      .eq("merchant_id", merchantId)
      .eq("campaign_id", campaignId)
      .eq("direction", "outbound")
      .range(from, to),
  );

  const conversationCustomers = await loadConversationCustomers(client, merchantId);

  const outbounds: CampaignOutbound[] = [];
  for (const m of messageRows) {
    const customerId = conversationCustomers.get(m.conversation_id);
    // A message whose conversation we cannot resolve is skipped rather than
    // silently mis-attributed.
    if (!customerId) continue;
    outbounds.push({
      messageId: m.id,
      customerId,
      campaignId,
      armId: m.arm_id,
      sentAt: m.sent_at,
    });
  }

  return {
    merchantId,
    campaignId,
    windowDays,
    cohort,
    outbounds,
    conversationCustomers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getTreatmentOrders — calendar window + single-attribution resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the orders single-attributed to this campaign (decisions 21 + 27).
 *
 * An order placed by an ITT cohort customer is attributed to this campaign iff:
 *   1. it falls within THIS campaign's calendar window
 *      `[launched_at, launched_at + windowDays]`, and
 *   2. the single-attribution winner is this campaign — the most-recent
 *      outbound (across ALL campaigns) preceding the order, among campaigns
 *      whose own calendar window covers the order.
 *
 * `launched_at` of a campaign is its earliest outbound. A cohort customer who
 * received no outbound has no preceding outbound — their orders are won by no
 * campaign (or by another campaign that did send to them), so an ITT customer
 * with no send contributes zero revenue. This is correct ITT behaviour.
 */
export async function getTreatmentOrders(
  client: LapsedSupabaseClient,
  cohort: TreatmentCohortResult,
): Promise<TreatmentOrdersResult> {
  const {
    merchantId,
    campaignId,
    windowDays,
    cohort: customerIds,
    conversationCustomers,
  } = cohort;

  if (customerIds.length === 0) {
    return { orders: [], revenueCents: 0, customersWithOrders: 0, perCustomerRevenueCents: [] };
  }

  // Every campaign outbound the merchant sent (any campaign) — needed to
  // resolve cross-campaign single-attribution AND each campaign's launched_at.
  // Restricted to outbounds with a campaign_id (non-campaign AI replies never
  // carry attribution). Paged so a merchant with > 1000 lifetime campaign
  // outbounds is not silently truncated.
  const allMsgRows = await fetchAllRows<MessageRow>((from, to) =>
    client
      .from("messages")
      .select("id, conversation_id, campaign_id, arm_id, sent_at")
      .eq("merchant_id", merchantId)
      .eq("direction", "outbound")
      .not("campaign_id", "is", null)
      .range(from, to),
  );

  const cohortSet = new Set(customerIds);

  // launched_at per campaign = the earliest outbound of that campaign. Computed
  // over EVERY outbound (not just to cohort customers) so a competing
  // campaign's calendar window is anchored at its true launch.
  const launchedAtByCampaign = new Map<string, number>();
  for (const m of allMsgRows) {
    if (!m.campaign_id) continue;
    const sentMs = epochMs(m.sent_at, "sent_at", m.id);
    const prior = launchedAtByCampaign.get(m.campaign_id);
    if (prior === undefined || sentMs < prior) {
      launchedAtByCampaign.set(m.campaign_id, sentMs);
    }
  }

  // Outbounds to cohort customers, keyed by customer.
  const outboundsByCustomer = new Map<string, CampaignOutbound[]>();
  const campaignIds = new Set<string>([campaignId]);
  for (const m of allMsgRows) {
    if (!m.campaign_id) continue;
    const customerId = conversationCustomers.get(m.conversation_id);
    if (!customerId || !cohortSet.has(customerId)) continue;
    campaignIds.add(m.campaign_id);
    const list = outboundsByCustomer.get(customerId) ?? [];
    list.push({
      messageId: m.id,
      customerId,
      campaignId: m.campaign_id,
      armId: m.arm_id,
      sentAt: m.sent_at,
    });
    outboundsByCustomer.set(customerId, list);
  }

  // Attribution window per campaign. This campaign's window is already known
  // (decision 20 stamp); competing campaigns' windows are fetched.
  const windowByCampaign = new Map<string, number>([[campaignId, windowDays]]);
  const otherCampaignIds = [...campaignIds].filter((id) => id !== campaignId);
  if (otherCampaignIds.length > 0) {
    const { data: windowRows, error: windowErr } = await client
      .from("campaign_proposals")
      .select("id, attribution_window_days")
      .in("id", otherCampaignIds);
    if (windowErr) throw windowErr;
    for (const row of windowRows ?? []) {
      windowByCampaign.set(
        row.id as string,
        (row.attribution_window_days as number | null) ?? ATTRIBUTION_WINDOW_DAYS_DEFAULT,
      );
    }
  }

  /**
   * Upper bound (epoch ms) of a campaign's calendar window. Returns -Infinity
   * for a campaign with no recorded outbound — that makes every `placedMs >
   * campaignWindowEnd` test true, so an unlaunched campaign wins no order. In
   * practice this branch is unreachable for a real candidate: every candidate
   * outbound came from `allMsgRows`, which also populates `launchedAtByCampaign`
   * — so any campaign that contributed a candidate has a launched_at. It is
   * kept as a defensive lower bound, not a live code path.
   */
  function campaignWindowEnd(cId: string): number {
    const launchedAt = launchedAtByCampaign.get(cId);
    if (launchedAt === undefined) return -Infinity; // campaign has no outbound
    const window = windowByCampaign.get(cId) ?? ATTRIBUTION_WINDOW_DAYS_DEFAULT;
    return launchedAt + window * DAY_MS;
  }

  // Orders placed by cohort customers (paged, and the id list chunked so a
  // large cohort does not overflow the PostgREST `.in(...)` URL).
  const orderRows: OrderRow[] = [];
  for (const idChunk of chunk(customerIds, IN_CLAUSE_CHUNK)) {
    const rows = await fetchAllRows<OrderRow>((from, to) =>
      client
        .from("orders")
        .select("id, shopify_customer_gid, total_price_cents, shopify_created_at")
        .eq("merchant_id", merchantId)
        .in("shopify_customer_gid", idChunk)
        .range(from, to),
    );
    orderRows.push(...rows);
  }

  const attributed: AttributedOrder[] = [];
  for (const o of orderRows) {
    const placedMs = epochMs(o.shopify_created_at, "shopify_created_at", o.id);
    // Currency is integer cents end-to-end — reject a non-integer (or NaN).
    if (!Number.isInteger(o.total_price_cents)) {
      throw new Error(
        `attribution-treatment: order ${o.id} total_price_cents is not an integer: ${o.total_price_cents}`,
      );
    }
    const candidates = outboundsByCustomer.get(o.shopify_customer_gid) ?? [];

    // Single-attribution winner: most-recent outbound preceding the order,
    // among campaigns whose CALENDAR window covers the order (decision 27).
    //
    // The calendar window is [launched_at, launched_at + windowDays]. Only the
    // UPPER bound is checked explicitly below. The LOWER bound is enforced
    // transitively: launched_at(campaign) <= sentMs (launched_at is the MIN
    // sent_at of the campaign) and sentMs <= placedMs (the precedes check), so
    // placedMs >= launched_at always holds for a real candidate — the order
    // can never fall before the window start. This keeps the treatment side
    // symmetric with getHoldoutOrders, which checks both bounds explicitly.
    let winner: CampaignOutbound | null = null;
    let winnerSentMs = -Infinity;
    for (const ob of candidates) {
      const sentMs = epochMs(ob.sentAt, "sent_at", ob.messageId);
      if (sentMs > placedMs) continue; // outbound must precede the order
      // The order must fall inside the outbound's CAMPAIGN calendar window
      // (anchored at that campaign's launched_at), not the per-outbound window.
      if (placedMs > campaignWindowEnd(ob.campaignId)) continue;
      // Most-recent-preceding wins; a deterministic messageId tie-break covers
      // the (vanishingly rare) exact-same-sent_at case.
      if (
        sentMs > winnerSentMs ||
        (sentMs === winnerSentMs && winner !== null && ob.messageId < winner.messageId)
      ) {
        winner = ob;
        winnerSentMs = sentMs;
      }
    }

    if (winner && winner.campaignId === campaignId) {
      attributed.push({
        orderId: o.id,
        customerId: o.shopify_customer_gid,
        totalPriceCents: o.total_price_cents,
        placedAt: o.shopify_created_at,
        attributedMessageId: winner.messageId,
        attributedArmId: winner.armId,
      });
    }
  }

  // Per-customer revenue distribution — one entry per ITT cohort customer.
  const revenueByCustomer = new Map<string, number>();
  for (const id of customerIds) revenueByCustomer.set(id, 0);
  for (const a of attributed) {
    revenueByCustomer.set(
      a.customerId,
      (revenueByCustomer.get(a.customerId) ?? 0) + a.totalPriceCents,
    );
  }

  const revenueCents = attributed.reduce((sum, a) => sum + a.totalPriceCents, 0);
  const customersWithOrders = new Set(attributed.map((a) => a.customerId)).size;

  return {
    orders: attributed,
    revenueCents,
    customersWithOrders,
    perCustomerRevenueCents: customerIds.map((id) => revenueByCustomer.get(id) ?? 0),
  };
}
