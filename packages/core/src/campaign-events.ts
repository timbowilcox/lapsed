// Campaign event helpers — canonical append + materializer + ready-campaign
// query for the campaign proposal lifecycle. Mirrors the voice-events pattern
// from Sprint 05. Implements architectural decisions 12-mirror (campaign_events
// is the append-only source of truth; campaign_proposals is a regeneratable
// materialized cache) and 13 (a campaign is "ready" only when its latest
// event is `campaign_approved` — getReadyCampaigns is the surface Sprint 07's
// conversation engine consumes; there is no auto-approval path anywhere).

import { z } from "zod";
import type { LapsedSupabaseClient, Json } from "@lapsed/db";

// ─────────────────────────────────────────────────────────────────────────────
// Event taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export const CampaignEventType = z.enum([
  "proposal_started",
  "campaign_proposed",
  "arms_initialized",
  "campaign_approved",
  "campaign_rejected",
  "proposal_edited",
  "proposal_failed",
]);
export type CampaignEventType = z.infer<typeof CampaignEventType>;

export const CampaignFailurePhase = z.enum([
  "cap_check",
  "voice_profile",
  "group_fetch",
  "redact",
  "design",
  "snapshot",
  "bandit_init",
]);
export type CampaignFailurePhase = z.infer<typeof CampaignFailurePhase>;

// ─────────────────────────────────────────────────────────────────────────────
// Per-event-type payload shapes
//
// Payloads NEVER contain customer PII or LLM-generated message text — only
// IDs, counts, model metadata, and merchant-supplied control values (the
// approving user id, a rejection reason). All schemas are `.strict()` so an
// extra field carrying PII is rejected at parse time, not silently persisted.
// ─────────────────────────────────────────────────────────────────────────────

// proposal_started has no payload — occurred_at is the entire signal.
const ProposalStartedPayload = z.object({}).strict();

const CampaignProposedPayload = z
  .object({
    variant_count: z.number().int().min(0),
    model_version: z.string().min(1),
    tokens_input: z.number().int().min(0),
    tokens_output: z.number().int().min(0),
    retries: z.number().int().min(0),
  })
  .strict();

const ArmsInitializedPayload = z
  .object({
    arm_count: z.number().int().min(0),
  })
  .strict();

const CampaignApprovedPayload = z
  .object({
    user_id: z.string().min(1).max(128),
  })
  .strict();

const CampaignRejectedPayload = z
  .object({
    user_id: z.string().min(1).max(128),
    // Merchant-supplied rejection reason. Merchant input, not customer PII;
    // length-bounded so a stray paste cannot bloat the event log.
    reason: z.string().min(1).max(500),
  })
  .strict();

const ProposalEditedPayload = z
  .object({
    user_id: z.string().min(1).max(128),
    new_proposal_id: z.string().uuid(),
    fields_changed: z.array(z.string()).min(0),
  })
  .strict();

const ProposalFailedPayload = z
  .object({
    phase: CampaignFailurePhase,
    reason: z.string().min(1).max(128),
  })
  .strict();

// Discriminated union — each event type carries its own payload shape.
export type CampaignEventInput =
  | { eventType: "proposal_started"; merchantId: string; proposalId: string; occurredAt: string; payload: z.infer<typeof ProposalStartedPayload> }
  | { eventType: "campaign_proposed"; merchantId: string; proposalId: string; occurredAt: string; payload: z.infer<typeof CampaignProposedPayload> }
  | { eventType: "arms_initialized"; merchantId: string; proposalId: string; occurredAt: string; payload: z.infer<typeof ArmsInitializedPayload> }
  | { eventType: "campaign_approved"; merchantId: string; proposalId: string; occurredAt: string; payload: z.infer<typeof CampaignApprovedPayload> }
  | { eventType: "campaign_rejected"; merchantId: string; proposalId: string; occurredAt: string; payload: z.infer<typeof CampaignRejectedPayload> }
  | { eventType: "proposal_edited"; merchantId: string; proposalId: string; occurredAt: string; payload: z.infer<typeof ProposalEditedPayload> }
  | { eventType: "proposal_failed"; merchantId: string; proposalId: string; occurredAt: string; payload: z.infer<typeof ProposalFailedPayload> };

// ─────────────────────────────────────────────────────────────────────────────
// appendCampaignEvent — Zod-validated, ON CONFLICT DO NOTHING for idempotency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the input against the per-event-type payload schema and inserts
 * into `campaign_events`. The unique constraint on
 * (merchant_id, proposal_id, event_type, occurred_at) makes the write
 * idempotent — a duplicate append silently no-ops.
 *
 * The persisted payload is the PARSED value, not the caller object — `.strict()`
 * on each schema rejects extra fields, so the row contains only the enumerated
 * keys (no PII can ride along).
 *
 * Throws a ZodError on invalid input and the Postgres error on a write failure.
 */
export async function appendCampaignEvent(
  serviceClient: LapsedSupabaseClient,
  event: CampaignEventInput,
): Promise<void> {
  z.string().uuid("merchantId must be a UUID").parse(event.merchantId);
  z.string().uuid("proposalId must be a UUID").parse(event.proposalId);
  z.string().datetime("occurredAt must be an ISO-8601 datetime").parse(event.occurredAt);

  let parsedPayload: unknown;
  switch (event.eventType) {
    case "proposal_started":
      parsedPayload = ProposalStartedPayload.parse(event.payload);
      break;
    case "campaign_proposed":
      parsedPayload = CampaignProposedPayload.parse(event.payload);
      break;
    case "arms_initialized":
      parsedPayload = ArmsInitializedPayload.parse(event.payload);
      break;
    case "campaign_approved":
      parsedPayload = CampaignApprovedPayload.parse(event.payload);
      break;
    case "campaign_rejected":
      parsedPayload = CampaignRejectedPayload.parse(event.payload);
      break;
    case "proposal_edited":
      parsedPayload = ProposalEditedPayload.parse(event.payload);
      break;
    case "proposal_failed":
      parsedPayload = ProposalFailedPayload.parse(event.payload);
      break;
  }

  const { error } = await serviceClient.from("campaign_events").upsert(
    {
      merchant_id: event.merchantId,
      proposal_id: event.proposalId,
      event_type: event.eventType,
      payload: parsedPayload as Json,
      occurred_at: event.occurredAt,
    },
    {
      onConflict: "merchant_id,proposal_id,event_type,occurred_at",
      ignoreDuplicates: true,
    },
  );
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// materializeCampaign — replays campaign_events to (re)build proposal status
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignStatus = "proposed" | "approved" | "rejected" | "edited";

export interface CampaignMaterializedState {
  proposalId: string;
  status: CampaignStatus;
  /** occurred_at of the `campaign_approved` event; null unless approved. */
  approvedAt: string | null;
  /** user_id from the `campaign_approved` event; null unless approved. */
  approvedByUserId: string | null;
  /** occurred_at of the `campaign_rejected` event; null unless rejected. */
  rejectedAt: string | null;
  /** reason from the `campaign_rejected` event; null unless rejected. */
  rejectionReason: string | null;
  /** event_type of the most recent campaign_events row; null if none exist. */
  latestEventType: CampaignEventType | null;
}

interface CampaignEventRow {
  event_type: string;
  occurred_at: string;
  ingested_at: string;
  payload: Json;
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
 * Replays `campaign_events` for a proposal and writes the derived status back
 * to the `campaign_proposals` materialized cache. The latest event wins:
 *
 *   campaign_approved → approved   (approved_at + approved_by_user_id set)
 *   campaign_rejected → rejected   (rejected_at + rejection_reason set)
 *   proposal_edited   → edited
 *   anything else / no events → proposed
 *
 * `proposal_started`, `campaign_proposed`, `arms_initialized`, and
 * `proposal_failed` all leave the proposal in `proposed` — they are
 * generation-lifecycle events, not review decisions. There is no event that
 * derives `approved` other than a recorded `campaign_approved` (decision 13).
 *
 * Idempotent: running twice with no new events leaves the cache identical.
 */
export async function materializeCampaign(
  serviceClient: LapsedSupabaseClient,
  proposalId: string,
): Promise<CampaignMaterializedState> {
  z.string().uuid("proposalId must be a UUID").parse(proposalId);

  const { data, error } = await serviceClient
    .from("campaign_events")
    .select("event_type, occurred_at, ingested_at, payload")
    .eq("proposal_id", proposalId)
    .order("occurred_at", { ascending: false })
    .order("ingested_at", { ascending: false });
  if (error) throw error;

  const events = (data ?? []) as CampaignEventRow[];

  let status: CampaignStatus = "proposed";
  let approvedAt: string | null = null;
  let approvedByUserId: string | null = null;
  let rejectedAt: string | null = null;
  let rejectionReason: string | null = null;
  let latestEventType: CampaignEventType | null = null;

  if (events.length > 0) {
    const latest = events[0]!;
    const parsedType = CampaignEventType.safeParse(latest.event_type);
    latestEventType = parsedType.success ? parsedType.data : null;

    if (latest.event_type === "campaign_approved") {
      status = "approved";
      approvedAt = latest.occurred_at;
      approvedByUserId = payloadString(latest.payload, "user_id");
    } else if (latest.event_type === "campaign_rejected") {
      status = "rejected";
      rejectedAt = latest.occurred_at;
      rejectionReason = payloadString(latest.payload, "reason");
    } else if (latest.event_type === "proposal_edited") {
      status = "edited";
    }
  }

  // Write the derived state back to the materialized cache. Always writes the
  // full projection so a transition out of approved/rejected clears stale
  // companion columns.
  const { error: upErr } = await serviceClient
    .from("campaign_proposals")
    .update({
      status,
      approved_at: approvedAt,
      approved_by_user_id: approvedByUserId,
      rejected_at: rejectedAt,
      rejection_reason: rejectionReason,
    })
    .eq("id", proposalId);
  if (upErr) throw upErr;

  return {
    proposalId,
    status,
    approvedAt,
    approvedByUserId,
    rejectedAt,
    rejectionReason,
    latestEventType,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getReadyCampaigns — proposals whose latest event is campaign_approved
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadyCampaign {
  proposalId: string;
  groupSlug: string;
  versionNumber: number;
  modelVersion: string;
  approvedAt: string | null;
  approvedByUserId: string | null;
}

interface LatestEvent {
  eventType: string;
  occurredAt: string;
  ingestedAt: string;
}

/**
 * Returns the proposals for a merchant whose **latest** campaign_events row is
 * `campaign_approved` — the exact surface Sprint 07's conversation engine
 * consumes (decision 13). A campaign is never "ready" without a recorded
 * `campaign_approved` event; there is no timer, escalation, or auto-approval
 * path that can produce a ready campaign.
 *
 * The latest event per proposal is computed directly from the event log
 * (not read from the materialized `status` column) so this query is correct
 * even if the cache were ever stale.
 */
export async function getReadyCampaigns(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
): Promise<ReadyCampaign[]> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);

  const { data: eventData, error: eventErr } = await serviceClient
    .from("campaign_events")
    .select("proposal_id, event_type, occurred_at, ingested_at")
    .eq("merchant_id", merchantId)
    .order("occurred_at", { ascending: false })
    .order("ingested_at", { ascending: false });
  if (eventErr) throw eventErr;

  // Reduce to the single latest event per proposal. Rows arrive newest-first,
  // so the first row seen for a proposal_id is its latest event.
  const latestByProposal = new Map<string, LatestEvent>();
  for (const row of eventData ?? []) {
    if (!latestByProposal.has(row.proposal_id)) {
      latestByProposal.set(row.proposal_id, {
        eventType: row.event_type,
        occurredAt: row.occurred_at,
        ingestedAt: row.ingested_at,
      });
    }
  }

  const readyIds = [...latestByProposal.entries()]
    .filter(([, ev]) => ev.eventType === "campaign_approved")
    .map(([proposalId]) => proposalId);

  if (readyIds.length === 0) return [];

  const { data: proposals, error: propErr } = await serviceClient
    .from("campaign_proposals")
    .select("id, group_slug, version_number, model_version, approved_at, approved_by_user_id")
    .eq("merchant_id", merchantId)
    .in("id", readyIds)
    .order("approved_at", { ascending: false });
  if (propErr) throw propErr;

  return (proposals ?? []).map((p) => ({
    proposalId: p.id,
    groupSlug: p.group_slug,
    versionNumber: p.version_number,
    modelVersion: p.model_version,
    approvedAt: p.approved_at,
    approvedByUserId: p.approved_by_user_id,
  }));
}
