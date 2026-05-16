// Treatment cohort engine — Sprint 08 chunk 4.
//
// The treatment cohort of a campaign is the set of customers who received at
// least one outbound message from that campaign. Their attributed orders are
// the orders they placed within the per-customer attribution window measured
// from THEIR outbound send time.
//
// SINGLE-ATTRIBUTION (decision 21). A customer may be in several campaigns'
// treatment cohorts at once (overlapping campaigns). An order is attributed to
// exactly ONE campaign: the most-recent outbound preceding the order, among all
// outbounds whose own attribution window still covers the order. This module
// resolves that winner per order and only returns the orders this campaign
// won. The naive "join orders to messages where customer matches" would return
// every campaign's outbound and double-count — the per-order winner selection
// below is the LATERAL/most-recent-preceding pattern done in application code
// (so it is exercised by the in-memory fake in tests, not only against SQL).
//
// All currency is integer cents (bigint in the DB, number here).

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import { ATTRIBUTION_WINDOW_DAYS_DEFAULT } from "./attribution-config";
import { fetchAllRows } from "./paginate";

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
  /** Distinct customer ids that received ≥ 1 outbound from this campaign. */
  cohort: string[];
  /** Every outbound this campaign sent (one row per message). */
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
   * treatment cohort size.
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
 * Resolves a campaign's treatment cohort: the distinct customers that received
 * at least one outbound from the campaign, plus every outbound message. The
 * attribution window is read from the proposal's stamped `attribution_window_days`
 * (decision 20) — the single source of truth, never re-derived.
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

  // This campaign's outbound messages (paged — a campaign can exceed 1000).
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
  const cohortSet = new Set<string>();
  for (const m of messageRows) {
    const customerId = conversationCustomers.get(m.conversation_id);
    // A message whose conversation we cannot resolve is skipped rather than
    // silently mis-attributed — it cannot contribute a customer to the cohort.
    if (!customerId) continue;
    outbounds.push({
      messageId: m.id,
      customerId,
      campaignId,
      armId: m.arm_id,
      sentAt: m.sent_at,
    });
    cohortSet.add(customerId);
  }

  return {
    merchantId,
    campaignId,
    windowDays,
    cohort: [...cohortSet].sort(),
    outbounds,
    conversationCustomers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getTreatmentOrders — single-attribution resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves the orders single-attributed to this campaign (decision 21).
 *
 * For every order placed by a cohort customer, the winning outbound is the
 * most recent outbound (across ALL campaigns) that precedes the order AND whose
 * own campaign's attribution window still covers the order. The order is
 * attributed to the winner's campaign. This function returns only the orders
 * THIS campaign won — so a customer shared with a more-recent campaign
 * contributes to this campaign's cohort (membership) but not its revenue.
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
  // resolve cross-campaign single-attribution. Restricted to outbounds with a
  // campaign_id (non-campaign AI replies never carry attribution). Paged so a
  // merchant with > 1000 lifetime campaign outbounds is not silently truncated.
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

  // Orders placed by cohort customers (paged).
  const orderRows = await fetchAllRows<OrderRow>((from, to) =>
    client
      .from("orders")
      .select("id, shopify_customer_gid, total_price_cents, shopify_created_at")
      .eq("merchant_id", merchantId)
      .in("shopify_customer_gid", customerIds)
      .range(from, to),
  );

  const attributed: AttributedOrder[] = [];
  for (const o of orderRows) {
    const placedMs = epochMs(o.shopify_created_at, "shopify_created_at", o.id);
    if (!Number.isFinite(o.total_price_cents)) {
      throw new Error(
        `attribution-treatment: order ${o.id} has a non-numeric total_price_cents`,
      );
    }
    const candidates = outboundsByCustomer.get(o.shopify_customer_gid) ?? [];

    let winner: CampaignOutbound | null = null;
    let winnerSentMs = -Infinity;
    for (const ob of candidates) {
      const sentMs = epochMs(ob.sentAt, "sent_at", ob.messageId);
      if (sentMs > placedMs) continue; // outbound must precede the order
      const window = windowByCampaign.get(ob.campaignId) ?? ATTRIBUTION_WINDOW_DAYS_DEFAULT;
      if (placedMs > sentMs + window * DAY_MS) continue; // order outside this outbound's window
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

  // Per-customer revenue distribution — one entry per cohort customer.
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
