import type { LapsedSupabaseClient } from "./index";
import type { Database, Json } from "./types";

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
    merchantId: string;
    limit: number;
    cursor?: number;
    groupFilter?: string[];
    sortBy?: "propensity_90d" | "last_order_at" | "total_ltv_cents";
  },
): Promise<LapsedCustomersWithSignalsPage> {
  const { merchantId, limit, cursor = 0, groupFilter, sortBy = "propensity_90d" } = opts;

  if (groupFilter && groupFilter.length > 0) {
    // Group-filter path: drive pagination from customer_inferred_state (the only table
    // with group_memberships). Fetch a page of scored rows, then hydrate with customer
    // identity data. The totalCount is from the inferred_state count query so it reflects
    // the full group-filtered population, not just the current page's customer matches.
    //
    // Sort constraint: last_order_at and total_ltv_cents live on the customers table, not
    // customer_inferred_state. When a group filter is active, only propensity_90d sort is
    // supported from this table. The UI must disable the other sort options when a group
    // filter is active, or pass sortBy: "propensity_90d".
    const stateCol = sortBy === "propensity_90d" ? "propensity_90d" : "propensity_90d";

    const { data: stateRows, error: stateErr, count: stateCount } = await merchantClient
      .from("customer_inferred_state")
      .select("*", { count: "exact" })
      .eq("merchant_id", merchantId)
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
      .eq("merchant_id", merchantId)
      .in("shopify_customer_gid", gids)
      .not("lapsed_at", "is", null);

    if (custErr) throw custErr;

    const customerByGid = new Map((customerRows ?? []).map((c) => [c.shopify_customer_gid, c]));
    const merged = states
      .filter((s) => customerByGid.has(s.shopify_customer_gid))
      .map((s) => ({ ...customerByGid.get(s.shopify_customer_gid)!, inferred_state: s }));

    return {
      data: merged,
      // Base nextCursor on merged.length so the pagination contract holds even when
      // some state rows have no matching lapsed customer (lapsed_at may have become null
      // after the state was written — the two tables can temporarily diverge).
      nextCursor: merged.length === limit ? cursor + limit : null,
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
      .eq("merchant_id", merchantId)
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
      .eq("merchant_id", merchantId)
      .in("shopify_customer_gid", gids)
      .not("lapsed_at", "is", null);

    if (custErr) throw custErr;

    const customerByGid = new Map((customerRows ?? []).map((c) => [c.shopify_customer_gid, c]));
    const merged = states
      .filter((s) => customerByGid.has(s.shopify_customer_gid))
      .map((s) => ({ ...customerByGid.get(s.shopify_customer_gid)!, inferred_state: s }));

    return {
      data: merged,
      nextCursor: merged.length === limit ? cursor + limit : null,
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
    .eq("merchant_id", merchantId)
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

// ─────────────────────────────────────────────────────────────────────────────
// getExtractionStatus — voice-extraction progress for the onboarding UI
// ─────────────────────────────────────────────────────────────────────────────

export type ExtractionPhase =
  | "analyzing"
  | "extracting"
  | "generating"
  | "ready"
  | "failed";

export interface ExtractionStatus {
  phase: ExtractionPhase;
  /** occurred_at of the current run's `extraction_started` event; null if no run is recorded yet. */
  startedAt: string | null;
  /** occurred_at of the terminal event when phase is `ready`/`failed`; null while in progress. */
  completedAt: string | null;
  /** `extraction_failed` reason when phase is `failed`; null otherwise. */
  errorMessage: string | null;
  /** Voice version id once `voice_extracted` has landed; null before then. */
  voiceVersionId: string | null;
}

interface VoiceEventRow {
  event_type: string;
  occurred_at: string;
  payload: Json;
}

/** Map a voice_events event_type to the extraction phase it represents. */
function phaseForEvent(eventType: string): ExtractionPhase {
  switch (eventType) {
    case "extraction_started":
      return "analyzing";
    case "storefront_fetched":
    case "pii_redacted":
      return "extracting";
    case "voice_extracted":
      return "generating";
    case "voice_activated":
    case "voice_edited":
      return "ready";
    case "extraction_failed":
      return "failed";
    default:
      // Unknown event type — treat as in-progress rather than crash the UI poll.
      return "analyzing";
  }
}

/** Reads a string field from a jsonb payload object, or null. */
function payloadString(payload: Json, key: string): string | null {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * Derives the current voice-extraction status for a merchant from the
 * `voice_events` log (Sprint 05, decision 12 — events are the source of
 * truth). Powers the onboarding progress UI (chunk 9), which polls this
 * every 2 seconds.
 *
 * Phase derivation maps the most recent event:
 *   extraction_started               → analyzing
 *   storefront_fetched / pii_redacted → extracting
 *   voice_extracted                  → generating
 *   voice_activated / voice_edited    → ready
 *   extraction_failed                → failed
 *
 * The "current run" is every event at or after the most recent
 * `extraction_started`, so a re-extraction never surfaces a stale version id
 * from a prior run. The run boundary is resolved with a dedicated query for
 * the latest `extraction_started` rather than a fixed row limit — accumulated
 * re-extraction + edit history can be arbitrarily long. `startedAt` is that
 * event's occurred_at; `completedAt` is the terminal event's occurred_at
 * (`voice_activated` for `ready`, `extraction_failed` for `failed`).
 */
export async function getExtractionStatus(
  client: LapsedSupabaseClient,
  merchantId: string,
): Promise<ExtractionStatus> {
  const notStarted: ExtractionStatus = {
    phase: "analyzing",
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    voiceVersionId: null,
  };

  // Resolve the current run's boundary: the most recent extraction_started.
  const { data: startedRow, error: startedErr } = await client
    .from("voice_events")
    .select("occurred_at")
    .eq("merchant_id", merchantId)
    .eq("event_type", "extraction_started")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (startedErr) throw startedErr;
  if (!startedRow) return notStarted;

  const startedAt = startedRow.occurred_at;

  // Fetch every event in the current run — at or after the boundary. The
  // boundary event itself satisfies the filter, so the result is non-empty.
  const { data, error } = await client
    .from("voice_events")
    .select("event_type, occurred_at, payload")
    .eq("merchant_id", merchantId)
    .gte("occurred_at", startedAt)
    .order("occurred_at", { ascending: false });
  if (error) throw error;

  const events = (data ?? []) as VoiceEventRow[];
  if (events.length === 0) return { ...notStarted, startedAt };

  const latest = events[0]!;
  const phase = phaseForEvent(latest.event_type);

  const completedAt = phase === "ready" || phase === "failed" ? latest.occurred_at : null;
  const errorMessage = phase === "failed" ? payloadString(latest.payload, "reason") : null;

  // version_id is carried by voice_activated / voice_edited / voice_extracted
  // payloads — take it from the most recent carrier in the current run.
  let voiceVersionId: string | null = null;
  for (const event of events) {
    const versionId = payloadString(event.payload, "version_id");
    if (versionId) {
      voiceVersionId = versionId;
      break;
    }
  }

  return { phase, startedAt, completedAt, errorMessage, voiceVersionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// getActiveVoiceProfile — the merchant's currently-active brand voice profile
// ─────────────────────────────────────────────────────────────────────────────

export interface ActiveVoiceProfile {
  versionId: string;
  versionNumber: number;
  /** Structured VoiceProfile jsonb (validated at write time by @lapsed/core). */
  profile: Json;
  modelVersion: string;
  extractedAt: string;
}

/**
 * Returns the merchant's active voice profile — the `voice_versions` row
 * pointed at by `agent_profiles.active_voice_version_id` — or null when no
 * extraction has produced an active version yet. Used by the onboarding
 * voice preview (chunk 10) and the Settings brand-voice tab (chunk 11).
 */
export async function getActiveVoiceProfile(
  client: LapsedSupabaseClient,
  merchantId: string,
): Promise<ActiveVoiceProfile | null> {
  const { data: agentProfile, error: apError } = await client
    .from("agent_profiles")
    .select("active_voice_version_id")
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (apError) throw apError;

  const versionId = agentProfile?.active_voice_version_id ?? null;
  if (!versionId) return null;

  const { data: version, error: versionError } = await client
    .from("voice_versions")
    .select("id, version_number, profile, model_version, extracted_at")
    .eq("merchant_id", merchantId)
    .eq("id", versionId)
    .maybeSingle();
  if (versionError) throw versionError;
  if (!version) return null;

  return {
    versionId: version.id,
    versionNumber: version.version_number,
    profile: version.profile,
    modelVersion: version.model_version,
    extractedAt: version.extracted_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// listVoiceVersions — all voice profile versions for a merchant
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceVersionSummary {
  id: string;
  versionNumber: number;
  modelVersion: string;
  extractedAt: string;
  /** Structured VoiceProfile jsonb (validated at write time by @lapsed/core). */
  profile: Json;
}

/**
 * Returns every `voice_versions` row for a merchant, newest first. Powers
 * the Settings brand-voice version-history list (chunk 11). Decision 7 —
 * prior versions are retained and never mutated, so the full history is
 * always available.
 */
export async function listVoiceVersions(
  client: LapsedSupabaseClient,
  merchantId: string,
): Promise<VoiceVersionSummary[]> {
  const { data, error } = await client
    .from("voice_versions")
    .select("id, version_number, model_version, extracted_at, profile")
    .eq("merchant_id", merchantId)
    .order("extracted_at", { ascending: false })
    .order("version_number", { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    versionNumber: row.version_number,
    modelVersion: row.model_version,
    extractedAt: row.extracted_at,
    profile: row.profile,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 06 — campaign proposal read helpers
//
// These are read-only. The approve / reject / edit WRITE operations live in
// @lapsed/core's campaign-approval.ts because they must write through the
// canonical event helper (appendCampaignEvent) and the materializer, which
// @lapsed/db cannot import without a dependency cycle.
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignProposalStatus = "proposed" | "approved" | "rejected" | "edited";

export interface ProposalVariant {
  /** campaign_arms.id */
  armId: string;
  /** campaign_arms.bandit_arm_id — the bandit_state key. */
  banditArmId: string;
  variantIndex: number;
  offerType: string;
  offerValue: string;
  messageDraft: string;
  sendTimeWindow: string;
  tone: string;
  /** {estimated_response_rate, estimated_recovered_revenue} */
  expectedImpact: Json;
}

export interface BanditArmState {
  /** bandit_state.arm_id (= campaign_arms.bandit_arm_id) */
  armId: string;
  alpha: number;
  beta: number;
  observationCount: number;
  lastUpdatedAt: string;
}

export interface PendingProposalSummary {
  proposalId: string;
  groupSlug: string;
  versionNumber: number;
  generatedAt: string;
  customerCount: number;
  holdoutCount: number;
  variants: ProposalVariant[];
}

export interface ProposalDetail {
  proposalId: string;
  merchantId: string;
  groupSlug: string;
  versionNumber: number;
  status: CampaignProposalStatus;
  modelVersion: string;
  generatedAt: string;
  approvedAt: string | null;
  approvedByUserId: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  supersedesProposalId: string | null;
  customerCount: number;
  holdoutCount: number;
  variants: ProposalVariant[];
  /** Empty until the proposal is approved (bandit_state is written at approval). */
  banditState: BanditArmState[];
}

/** Maps a campaign_events event_type to the materialized proposal status. */
function statusForEvent(eventType: string | null): CampaignProposalStatus {
  switch (eventType) {
    case "campaign_approved":
      return "approved";
    case "campaign_rejected":
      return "rejected";
    case "proposal_edited":
      return "edited";
    default:
      // proposal_started / campaign_proposed / arms_initialized / proposal_failed
      // and the no-events case all leave the proposal in `proposed`.
      return "proposed";
  }
}

interface CampaignEventLite {
  proposal_id: string;
  event_type: string;
  occurred_at: string;
  ingested_at: string;
  id: string;
}

/**
 * Derives the current status of a single proposal from its campaign_events
 * log — `proposed | approved | rejected | edited`. Read-only; does not touch
 * the materialized cache. The latest event wins, tie-broken on
 * (occurred_at, ingested_at, id) descending.
 *
 * Scoped to `merchantId` for defense-in-depth beyond RLS, consistent with the
 * other campaign read helpers — a cross-merchant proposalId yields `proposed`
 * (the no-events default) rather than another tenant's real status.
 */
export async function getCampaignStatus(
  client: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
): Promise<CampaignProposalStatus> {
  const { data, error } = await client
    .from("campaign_events")
    .select("event_type")
    .eq("merchant_id", merchantId)
    .eq("proposal_id", proposalId)
    .order("occurred_at", { ascending: false })
    .order("ingested_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return statusForEvent(data?.event_type ?? null);
}

/** Reduces a flat campaign_events list to the latest event_type per proposal. */
function latestEventByProposal(events: CampaignEventLite[]): Map<string, string> {
  // Sort newest-first with a deterministic (occurred_at, ingested_at, id) key.
  const sorted = [...events].sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
    if (a.ingested_at !== b.ingested_at) return a.ingested_at < b.ingested_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  const latest = new Map<string, string>();
  for (const e of sorted) {
    if (!latest.has(e.proposal_id)) latest.set(e.proposal_id, e.event_type);
  }
  return latest;
}

/**
 * Returns the proposals awaiting a merchant decision: those that completed
 * generation (have a `campaign_proposed` event) and whose latest event is a
 * generation-lifecycle event (`campaign_proposed` / `arms_initialized`) —
 * i.e. not yet approved, rejected, edited-away, or failed.
 *
 * An edited proposal's latest event is `proposal_edited` (it is superseded by
 * a newer version) and so is excluded; its newer version, whose latest event
 * is `arms_initialized`, is included.
 *
 * Each summary carries the variant set and the snapshot/holdout counts so the
 * approval surface can render a card without a follow-up query per proposal.
 */
export async function getPendingProposals(
  client: LapsedSupabaseClient,
  merchantId: string,
): Promise<PendingProposalSummary[]> {
  const { data: eventData, error: eventErr } = await client
    .from("campaign_events")
    .select("proposal_id, event_type, occurred_at, ingested_at, id")
    .eq("merchant_id", merchantId);
  if (eventErr) throw eventErr;

  const events = (eventData ?? []) as CampaignEventLite[];
  const latest = latestEventByProposal(events);
  const proposedSet = new Set(
    events.filter((e) => e.event_type === "campaign_proposed").map((e) => e.proposal_id),
  );

  const pendingIds = [...latest.entries()]
    .filter(
      ([proposalId, type]) =>
        proposedSet.has(proposalId) &&
        (type === "campaign_proposed" || type === "arms_initialized"),
    )
    .map(([proposalId]) => proposalId);

  if (pendingIds.length === 0) return [];

  const { data: proposalRows, error: propErr } = await client
    .from("campaign_proposals")
    .select("id, group_slug, version_number, generated_at")
    .eq("merchant_id", merchantId)
    .in("id", pendingIds)
    .order("generated_at", { ascending: false });
  if (propErr) throw propErr;

  const variantsByProposal = await fetchVariantsByProposal(client, merchantId, pendingIds);
  const counts = await fetchSnapshotCounts(client, merchantId, pendingIds);

  return (proposalRows ?? []).map((p) => {
    const c = counts.get(p.id) ?? { customerCount: 0, holdoutCount: 0 };
    return {
      proposalId: p.id,
      groupSlug: p.group_slug,
      versionNumber: p.version_number,
      generatedAt: p.generated_at,
      customerCount: c.customerCount,
      holdoutCount: c.holdoutCount,
      variants: variantsByProposal.get(p.id) ?? [],
    };
  });
}

/**
 * Returns the full detail of one proposal — row, variants, bandit state, and
 * snapshot/holdout counts — or null if it does not exist or belongs to a
 * different merchant. The explicit `merchant_id` filter is defense-in-depth
 * beyond RLS; a cross-merchant id resolves to null so the caller can answer
 * 404 without leaking existence.
 */
export async function getProposalById(
  client: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
): Promise<ProposalDetail | null> {
  const { data: proposal, error: propErr } = await client
    .from("campaign_proposals")
    .select(
      "id, merchant_id, group_slug, version_number, status, model_version, generated_at, approved_at, approved_by_user_id, rejected_at, rejection_reason, supersedes_proposal_id",
    )
    .eq("id", proposalId)
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (propErr) throw propErr;
  if (!proposal) return null;

  const variantsByProposal = await fetchVariantsByProposal(client, merchantId, [proposalId]);
  const counts = await fetchSnapshotCounts(client, merchantId, [proposalId]);
  const c = counts.get(proposalId) ?? { customerCount: 0, holdoutCount: 0 };

  // Derive status from the event log rather than trusting the materialized
  // `campaign_proposals.status` cache, consistent with getCampaignStatus —
  // the detail view is where a merchant acts on the proposal, so a stale
  // cache value must never surface here.
  const status = await getCampaignStatus(client, merchantId, proposalId);

  const { data: banditRows, error: banditErr } = await client
    .from("bandit_state")
    .select("arm_id, alpha, beta, observation_count, last_updated_at")
    .eq("merchant_id", merchantId)
    .eq("proposal_id", proposalId);
  if (banditErr) throw banditErr;

  return {
    proposalId: proposal.id,
    merchantId: proposal.merchant_id,
    groupSlug: proposal.group_slug,
    versionNumber: proposal.version_number,
    status,
    modelVersion: proposal.model_version,
    generatedAt: proposal.generated_at,
    approvedAt: proposal.approved_at,
    approvedByUserId: proposal.approved_by_user_id,
    rejectedAt: proposal.rejected_at,
    rejectionReason: proposal.rejection_reason,
    supersedesProposalId: proposal.supersedes_proposal_id,
    customerCount: c.customerCount,
    holdoutCount: c.holdoutCount,
    variants: variantsByProposal.get(proposalId) ?? [],
    banditState: (banditRows ?? []).map((b) => ({
      armId: b.arm_id,
      alpha: b.alpha,
      beta: b.beta,
      observationCount: b.observation_count,
      lastUpdatedAt: b.last_updated_at,
    })),
  };
}

/** Batch-fetches campaign_arms for a set of proposals, grouped by proposal id. */
async function fetchVariantsByProposal(
  client: LapsedSupabaseClient,
  merchantId: string,
  proposalIds: string[],
): Promise<Map<string, ProposalVariant[]>> {
  const byProposal = new Map<string, ProposalVariant[]>();
  if (proposalIds.length === 0) return byProposal;

  const { data, error } = await client
    .from("campaign_arms")
    .select(
      "id, bandit_arm_id, proposal_id, variant_index, offer_type, offer_value, message_draft, send_time_window, tone, expected_impact",
    )
    .eq("merchant_id", merchantId)
    .in("proposal_id", proposalIds)
    .order("variant_index", { ascending: true });
  if (error) throw error;

  for (const row of data ?? []) {
    const variant: ProposalVariant = {
      armId: row.id,
      banditArmId: row.bandit_arm_id,
      variantIndex: row.variant_index,
      offerType: row.offer_type,
      offerValue: row.offer_value,
      messageDraft: row.message_draft,
      sendTimeWindow: row.send_time_window,
      tone: row.tone,
      expectedImpact: row.expected_impact,
    };
    const list = byProposal.get(row.proposal_id) ?? [];
    list.push(variant);
    byProposal.set(row.proposal_id, list);
  }
  return byProposal;
}

/** Batch-fetches campaign_group_snapshots customer + holdout counts per proposal. */
async function fetchSnapshotCounts(
  client: LapsedSupabaseClient,
  merchantId: string,
  proposalIds: string[],
): Promise<Map<string, { customerCount: number; holdoutCount: number }>> {
  const counts = new Map<string, { customerCount: number; holdoutCount: number }>();
  if (proposalIds.length === 0) return counts;

  const { data, error } = await client
    .from("campaign_group_snapshots")
    .select("proposal_id, included_in_holdout")
    .eq("merchant_id", merchantId)
    .in("proposal_id", proposalIds);
  if (error) throw error;

  for (const row of data ?? []) {
    const c = counts.get(row.proposal_id) ?? { customerCount: 0, holdoutCount: 0 };
    c.customerCount += 1;
    if (row.included_in_holdout) c.holdoutCount += 1;
    counts.set(row.proposal_id, c);
  }
  return counts;
}
