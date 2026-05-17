// Campaign approval state machine — the merchant-facing approve / reject /
// edit operations on a campaign proposal. Implements architectural decisions
// 13 (a campaign becomes "ready" only via a recorded campaign_approved event —
// there is no auto-approval), 14 (editing creates a NEW proposal version with
// NEW arms; the prior version + arms are retained), and 15 (the new version
// inherits the prior version's frozen group snapshot, so an edit never
// re-rolls the customer set or the holdout).
//
// These functions live in @lapsed/core rather than @lapsed/db's queries.ts
// because they must write through the canonical event helper
// (appendCampaignEvent), the materializer (materializeCampaign), and the
// bandit initializer (initializeBanditArm) — all @lapsed/core modules that
// @lapsed/db cannot import without a dependency cycle. The read-only query
// helpers (getPendingProposals / getProposalById / getCampaignStatus) do live
// in queries.ts.

import { z } from "zod";
import type { LapsedSupabaseClient, Json } from "@lapsed/db";
import { appendCampaignEvent, materializeCampaign, type CampaignStatus } from "./campaign-events";
import { initializeBanditArm } from "./bandit";
import { getAttributionWindow } from "./attribution-config";

// ─────────────────────────────────────────────────────────────────────────────
// approveProposal
// ─────────────────────────────────────────────────────────────────────────────

export interface ApproveProposalResult {
  proposalId: string;
  status: CampaignStatus;
  /** True when the proposal was already approved and this call was a no-op. */
  alreadyApproved: boolean;
  /** bandit_arm_id of every arm initialized at Beta(1,1). */
  initializedArmIds: string[];
}

/**
 * Approves a campaign proposal: records a `campaign_approved` event and
 * initializes a Beta(1,1) bandit_state row for each of the proposal's arms
 * (decision 14 — bandit arms are initialized at approval, not proposal time).
 *
 * Idempotent: if the proposal is already approved, this is a no-op that
 * returns `alreadyApproved: true` without writing a second event. A proposal
 * that is `rejected` or `edited` (superseded) cannot be approved — that
 * throws.
 *
 * There is no auto-approval path: a campaign only becomes ready via this
 * function recording an explicit `campaign_approved` event with the approving
 * user id (decision 13).
 */
export async function approveProposal(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
  userId: string,
): Promise<ApproveProposalResult> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);
  z.string().uuid("proposalId must be a UUID").parse(proposalId);
  z.string().min(1).max(128).parse(userId);

  // materializeCampaign validates existence + tenancy (throws if the proposal
  // does not belong to the merchant) and returns the current status.
  const before = await materializeCampaign(serviceClient, merchantId, proposalId);

  if (before.status === "rejected" || before.status === "edited") {
    throw new Error(
      `approveProposal: proposal ${proposalId} is ${before.status} and cannot be approved`,
    );
  }

  const alreadyApproved = before.status === "approved";
  if (!alreadyApproved) {
    // Stamp the merchant's current attribution window onto the proposal
    // (decision 20). This happens BEFORE the campaign_approved event, per the
    // SPRINT.md chunk-3 spec, so the window is fixed as part of becoming
    // approved.
    //
    // Decision-20 immutability holds across a crash between this stamp and the
    // event append: the proposal is still `proposed` (NOT approved) until the
    // campaign_approved event lands, so a retry legitimately re-enters this
    // branch and re-stamps with the merchant's then-current window. Decision 20
    // guarantees immutability AFTER approval — a pre-approval re-stamp is the
    // correct behaviour (the approval, hence the window, is finalised at the
    // moment the event is recorded). Once approved, no code path UPDATEs this
    // column again. A later change to the merchant default affects only future
    // approvals, keeping reported lift figures deterministic and auditable.
    const attributionWindowDays = await getAttributionWindow(serviceClient, merchantId);
    const { data: stamped, error: stampErr } = await serviceClient
      .from("campaign_proposals")
      .update({ attribution_window_days: attributionWindowDays })
      .eq("id", proposalId)
      .eq("merchant_id", merchantId)
      .select("id");
    if (stampErr) throw stampErr;
    // materializeCampaign above already proved existence + tenancy; a zero-row
    // stamp would mean the row vanished mid-call — fail loud rather than
    // append an approval event for an unstamped proposal.
    if (!stamped || stamped.length === 0) {
      throw new Error(
        `approveProposal: attribution-window stamp matched no row for proposal ${proposalId}`,
      );
    }

    await appendCampaignEvent(serviceClient, {
      eventType: "campaign_approved",
      merchantId,
      proposalId,
      occurredAt: new Date().toISOString(),
      payload: { user_id: userId },
    });
    await materializeCampaign(serviceClient, merchantId, proposalId);
  }

  // Initialize the Beta(1,1) bandit posterior for each arm (decision 14).
  // This runs on both the fresh and the already-approved path:
  // initializeBanditArm is idempotent (read-first), so a re-approve after a
  // partial prior approval (crash between the event write and the bandit
  // loop) reconciles the missing arms rather than silently leaving an
  // approved campaign with no bandit state.
  const armIds = await getProposalArmIds(serviceClient, merchantId, proposalId);
  for (const armId of armIds) {
    await initializeBanditArm(serviceClient, { armId, merchantId, proposalId });
  }

  return {
    proposalId,
    status: "approved",
    alreadyApproved,
    initializedArmIds: armIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// rejectProposal
// ─────────────────────────────────────────────────────────────────────────────

export interface RejectProposalResult {
  proposalId: string;
  status: CampaignStatus;
  alreadyRejected: boolean;
}

/**
 * Rejects a campaign proposal: records a `campaign_rejected` event carrying the
 * merchant-supplied reason.
 *
 * Idempotent: a second reject of an already-rejected proposal is a no-op.
 * An `approved` or `edited` proposal cannot be rejected — that throws.
 */
export async function rejectProposal(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
  userId: string,
  reason: string,
): Promise<RejectProposalResult> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);
  z.string().uuid("proposalId must be a UUID").parse(proposalId);
  z.string().min(1).max(128).parse(userId);
  z.string().min(1, "a rejection reason is required").max(500).parse(reason);

  const before = await materializeCampaign(serviceClient, merchantId, proposalId);

  if (before.status === "rejected") {
    return { proposalId, status: "rejected", alreadyRejected: true };
  }
  if (before.status === "approved" || before.status === "edited") {
    throw new Error(
      `rejectProposal: proposal ${proposalId} is ${before.status} and cannot be rejected`,
    );
  }

  await appendCampaignEvent(serviceClient, {
    eventType: "campaign_rejected",
    merchantId,
    proposalId,
    occurredAt: new Date().toISOString(),
    payload: { user_id: userId, reason },
  });
  await materializeCampaign(serviceClient, merchantId, proposalId);

  return { proposalId, status: "rejected", alreadyRejected: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// editProposal
// ─────────────────────────────────────────────────────────────────────────────

const SEND_TIME_WINDOWS = [
  "morning",
  "midday",
  "evening",
  "weekend_morning",
  "weekend_evening",
] as const;

const VariantEditSchema = z
  .object({
    variantIndex: z.number().int().min(0).max(2),
    messageDraft: z.string().min(1).max(160).optional(),
    offerValue: z.string().min(1).max(64).optional(),
    sendTimeWindow: z.enum(SEND_TIME_WINDOWS).optional(),
  })
  .strict();

export type VariantEdit = z.infer<typeof VariantEditSchema>;

const EditProposalInputSchema = z.object({
  edits: z.array(VariantEditSchema).min(1, "at least one variant edit is required"),
});

export interface EditProposalResult {
  /** The proposal that was edited (now superseded; status `edited`). */
  editedProposalId: string;
  /** The new proposal version created by the edit. */
  newProposalId: string;
  newVersionNumber: number;
  /** Field paths changed, e.g. ["variant_0.message_draft"]. */
  fieldsChanged: string[];
}

interface ArmRow {
  variant_index: number;
  offer_type: string;
  offer_value: string;
  message_draft: string;
  send_time_window: string;
  tone: string;
  expected_impact: Json;
}

/**
 * Edits a campaign proposal. Per decision 14, an edit never mutates the
 * existing proposal or its arms in place: it creates a NEW proposal version
 * (version_number + 1, supersedes_proposal_id set) with NEW arms carrying the
 * edits applied. The prior version and its arms are retained for audit, and a
 * `proposal_edited` event is recorded on the prior version (so it materializes
 * to `edited` and drops out of the pending list).
 *
 * Per decision 15, the new version inherits the prior version's frozen
 * `campaign_group_snapshots` rows verbatim — same customer set, same holdout
 * assignment — so an edit never re-rolls the targeted customers or the
 * holdout.
 *
 * Only `message_draft`, `offer_value`, and `send_time_window` are editable;
 * `offer_type` and `tone` are the designer's structural choices and are
 * carried over unchanged. Only a `proposed` (pending) proposal can be edited.
 */
export async function editProposal(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
  userId: string,
  edits: VariantEdit[],
): Promise<EditProposalResult> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);
  z.string().uuid("proposalId must be a UUID").parse(proposalId);
  z.string().min(1).max(128).parse(userId);
  const { edits: validEdits } = EditProposalInputSchema.parse({ edits });

  // Existence + tenancy check; also gives us the current status.
  const before = await materializeCampaign(serviceClient, merchantId, proposalId);
  if (before.status !== "proposed") {
    throw new Error(
      `editProposal: proposal ${proposalId} is ${before.status}; only a pending proposal can be edited`,
    );
  }

  // Read the proposal row + its arms.
  const { data: proposalRow, error: proposalErr } = await serviceClient
    .from("campaign_proposals")
    .select("group_slug, version_number, model_version")
    .eq("id", proposalId)
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (proposalErr) throw proposalErr;
  if (!proposalRow) {
    throw new Error(`editProposal: proposal ${proposalId} not found for merchant ${merchantId}`);
  }

  const { data: armRows, error: armErr } = await serviceClient
    .from("campaign_arms")
    .select("variant_index, offer_type, offer_value, message_draft, send_time_window, tone, expected_impact")
    .eq("proposal_id", proposalId)
    .eq("merchant_id", merchantId)
    .order("variant_index", { ascending: true });
  if (armErr) throw armErr;
  const arms = (armRows ?? []) as ArmRow[];
  if (arms.length === 0) {
    throw new Error(`editProposal: proposal ${proposalId} has no arms to edit`);
  }

  // Every edit must target an arm that actually exists — an edit aimed at a
  // missing variant index would otherwise be silently dropped.
  const armIndices = new Set(arms.map((a) => a.variant_index));
  for (const e of validEdits) {
    if (!armIndices.has(e.variantIndex)) {
      throw new Error(
        `editProposal: edit targets variant ${e.variantIndex}, which does not exist on proposal ${proposalId}`,
      );
    }
  }

  // Apply the edits, recording which fields changed.
  const editByIndex = new Map(validEdits.map((e) => [e.variantIndex, e]));
  const fieldsChanged: string[] = [];
  const newArms = arms.map((arm) => {
    const edit = editByIndex.get(arm.variant_index);
    let messageDraft = arm.message_draft;
    let offerValue = arm.offer_value;
    let sendTimeWindow = arm.send_time_window;
    if (edit) {
      if (edit.messageDraft !== undefined && edit.messageDraft !== arm.message_draft) {
        messageDraft = edit.messageDraft;
        fieldsChanged.push(`variant_${arm.variant_index}.message_draft`);
      }
      if (edit.offerValue !== undefined && edit.offerValue !== arm.offer_value) {
        offerValue = edit.offerValue;
        fieldsChanged.push(`variant_${arm.variant_index}.offer_value`);
      }
      if (edit.sendTimeWindow !== undefined && edit.sendTimeWindow !== arm.send_time_window) {
        sendTimeWindow = edit.sendTimeWindow;
        fieldsChanged.push(`variant_${arm.variant_index}.send_time_window`);
      }
    }
    return {
      variant_index: arm.variant_index,
      offer_type: arm.offer_type, // structural — carried over unchanged
      offer_value: offerValue,
      message_draft: messageDraft,
      send_time_window: sendTimeWindow,
      tone: arm.tone, // structural — carried over unchanged
      expected_impact: arm.expected_impact,
    };
  });

  // Insert the new proposal version row.
  const newVersionNumber = proposalRow.version_number + 1;
  const { data: newProposal, error: newProposalErr } = await serviceClient
    .from("campaign_proposals")
    .insert({
      merchant_id: merchantId,
      group_slug: proposalRow.group_slug,
      model_version: proposalRow.model_version,
      version_number: newVersionNumber,
      supersedes_proposal_id: proposalId,
      status: "proposed",
    })
    .select("id")
    .single();
  if (newProposalErr) {
    // The partial-unique index on supersedes_proposal_id serializes concurrent
    // edits of the same proposal: the loser's insert fails with a unique
    // violation. Surface a clear, actionable error rather than a raw 23505.
    if ((newProposalErr as { code?: string }).code === "23505") {
      throw new Error(
        `editProposal: proposal ${proposalId} was concurrently edited; reload and retry`,
      );
    }
    throw newProposalErr;
  }
  if (!newProposal) {
    throw new Error("editProposal: new proposal insert returned no row");
  }
  const newProposalId = newProposal.id;

  // Insert the new arms (decision 14 — new arms, new bandit_arm_id values).
  const { error: armsInsertErr } = await serviceClient.from("campaign_arms").insert(
    newArms.map((arm) => ({ ...arm, proposal_id: newProposalId, merchant_id: merchantId })),
  );
  if (armsInsertErr) throw armsInsertErr;

  // Inherit the prior version's frozen group snapshot verbatim (decision 15).
  const { data: snapshotRows, error: snapshotErr } = await serviceClient
    .from("campaign_group_snapshots")
    .select("customer_id, included_in_holdout")
    .eq("proposal_id", proposalId)
    .eq("merchant_id", merchantId);
  if (snapshotErr) throw snapshotErr;
  const snapshots = snapshotRows ?? [];
  if (snapshots.length > 0) {
    const { error: copyErr } = await serviceClient.from("campaign_group_snapshots").insert(
      snapshots.map((s) => ({
        proposal_id: newProposalId,
        merchant_id: merchantId,
        customer_id: s.customer_id,
        included_in_holdout: s.included_in_holdout,
      })),
    );
    if (copyErr) throw copyErr;
  }

  // Events: the new version is a real pending proposal; the prior version is
  // now superseded. occurred_at values are offset so same-tick events stay
  // distinct under the campaign_events dedup constraint.
  const baseTime = Date.now();
  const iso = (offsetMs: number) => new Date(baseTime + offsetMs).toISOString();

  await appendCampaignEvent(serviceClient, {
    eventType: "campaign_proposed",
    merchantId,
    proposalId: newProposalId,
    occurredAt: iso(0),
    payload: {
      variant_count: newArms.length,
      model_version: proposalRow.model_version,
      // An edit performs no LLM call — no tokens consumed.
      tokens_input: 0,
      tokens_output: 0,
      retries: 0,
    },
  });
  await appendCampaignEvent(serviceClient, {
    eventType: "arms_initialized",
    merchantId,
    proposalId: newProposalId,
    occurredAt: iso(1),
    payload: { arm_count: newArms.length },
  });
  await appendCampaignEvent(serviceClient, {
    eventType: "proposal_edited",
    merchantId,
    proposalId,
    occurredAt: iso(2),
    payload: { user_id: userId, new_proposal_id: newProposalId, fields_changed: fieldsChanged },
  });

  await materializeCampaign(serviceClient, merchantId, newProposalId);
  await materializeCampaign(serviceClient, merchantId, proposalId);

  return {
    editedProposalId: proposalId,
    newProposalId,
    newVersionNumber,
    fieldsChanged,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the bandit_arm_id of every arm on a proposal, ordered by variant. */
async function getProposalArmIds(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
): Promise<string[]> {
  const { data, error } = await serviceClient
    .from("campaign_arms")
    .select("bandit_arm_id, variant_index")
    .eq("proposal_id", proposalId)
    .eq("merchant_id", merchantId)
    .order("variant_index", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => r.bandit_arm_id);
}
