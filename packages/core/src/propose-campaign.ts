// Campaign proposal orchestrator — the single entry point that wires the
// chunk 2-5 building blocks into a complete proposal run. Mirrors Sprint 05's
// run-voice-extraction.ts.
//
// Sequence:
//   1.  Create the campaign_proposals row (the anchor every event references)
//   2.  Write proposal_started event
//   3.  Daily-cap check (decision: cost discipline) — fail with proposal_failed
//   4.  Voice-profile presence check — fail if the merchant has no active voice
//   5.  Fetch the group's customers + build a PII-free aggregate summary
//   6.  assertNoPii pre-flight on the summary (decision 10, defense in depth)
//   7.  Call the AI Campaign Designer (Sonnet 4.6)
//   8.  Insert the 3 campaign_arms variant rows
//   9.  Write campaign_proposed event (counts + token metadata only)
//   10. Snapshot the group + assign the deterministic holdout (decision 15)
//   11. Write arms_initialized event
//   12. Materialize the proposal status cache
//
// NOTE on bandit_state: the Beta(1,1) posteriors are NOT written here. Per
// decision 14 and the Sprint 06 acceptance criteria, bandit_state rows are
// initialized at APPROVAL time (chunk 7's approveProposal), not at proposal
// time. This orchestrator creates the campaign_arms variant rows; their
// bandit_arm_id values become the bandit_state keys when the merchant
// approves.
//
// On any failure after the row exists, a proposal_failed event is written and
// the run returns { ok: false, reason }. A failed proposal's latest event is
// proposal_failed, so it never surfaces as pending or ready.

import type { LapsedSupabaseClient, Json } from "@lapsed/db";
import { getActiveVoiceProfile } from "@lapsed/db";
import type Anthropic from "@anthropic-ai/sdk";
import {
  designCampaign,
  CampaignDesignError,
  type DesignCampaignResult,
  type GroupSummary,
} from "./campaign-designer";
import { snapshotGroup, HOLDOUT_RATE_DEFAULT } from "./snapshot-group";
import {
  appendCampaignEvent,
  materializeCampaign,
  type CampaignFailurePhase,
} from "./campaign-events";
import { assertNoPii, PiiLeakError } from "./pii-redactor";
import { parseVoiceProfile, SONNET_MODEL_DEFAULT } from "./voice-synthesizer";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ProposeCampaignInput {
  serviceClient: LapsedSupabaseClient;
  anthropicClient: Anthropic;
  merchantId: string;
  /** The system group to propose a campaign for (a GroupSlug). */
  groupSlug: string;
  /** Max successful proposals per merchant per UTC day (CAMPAIGN_PROPOSAL_DAILY_CAP_DEFAULT). */
  dailyCapDefault: number;
  /** Fraction of the group held out (HOLDOUT_RATE). Defaults to HOLDOUT_RATE_DEFAULT. */
  holdoutRate?: number;
  /** Optional Sonnet model override. */
  model?: string;
  /** Override for unit tests; defaults to () => new Date(). */
  now?: () => Date;
}

export type ProposeCampaignResult =
  | {
      ok: true;
      proposalId: string;
      variantCount: number;
      customerCount: number;
      holdoutCount: number;
      tokensInput: number;
      tokensOutput: number;
      retries: number;
    }
  | {
      ok: false;
      reason: CampaignFailurePhase;
      detail: string;
      /** The proposal row id, if it was created before the failure. */
      proposalId: string | null;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function proposeCampaign(
  input: ProposeCampaignInput,
): Promise<ProposeCampaignResult> {
  const now = input.now ?? (() => new Date());
  const holdoutRate = input.holdoutRate ?? HOLDOUT_RATE_DEFAULT;
  const model = input.model ?? SONNET_MODEL_DEFAULT;

  // ── Step 1: create the campaign_proposals anchor row ─────────────────────
  let proposalId: string;
  try {
    const { data, error } = await input.serviceClient
      .from("campaign_proposals")
      .insert({
        merchant_id: input.merchantId,
        group_slug: input.groupSlug,
        model_version: model,
        status: "proposed",
      })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("proposal insert returned no row");
    proposalId = data.id;
  } catch (err) {
    // No row exists — nothing to attach a proposal_failed event to.
    logStructured("propose_campaign_failed", {
      merchant_id: input.merchantId,
      phase: "cap_check",
      reason: "proposal_row_insert_failed",
      error_class: errorClassName(err),
    });
    return { ok: false, reason: "cap_check", detail: errorReason(err), proposalId: null };
  }

  // ── Step 2: proposal_started event ───────────────────────────────────────
  const startedAt = now().toISOString();
  try {
    await appendCampaignEvent(input.serviceClient, {
      eventType: "proposal_started",
      merchantId: input.merchantId,
      proposalId,
      occurredAt: startedAt,
      payload: {},
    });
  } catch (err) {
    return await failProposal(input, proposalId, "cap_check", err);
  }

  // ── Step 3: daily-cap check ──────────────────────────────────────────────
  // The cap counts SUCCESSFUL proposals — campaign_proposed events today — so
  // a capped attempt's zombie row does not itself consume cap headroom.
  let proposedToday: number;
  try {
    proposedToday = await countProposedToday(input.serviceClient, input.merchantId, now());
  } catch (err) {
    return await failProposal(input, proposalId, "cap_check", err);
  }
  if (proposedToday >= input.dailyCapDefault) {
    await failProposal(input, proposalId, "cap_check", new Error("daily_cap_exhausted"));
    logStructured("propose_campaign_cap_exhausted", {
      merchant_id: input.merchantId,
      proposal_id: proposalId,
      proposed_today: proposedToday,
      cap: input.dailyCapDefault,
    });
    return {
      ok: false,
      reason: "cap_check",
      detail: "daily_cap_exhausted",
      proposalId,
    };
  }

  // ── Step 4: voice-profile presence check ─────────────────────────────────
  let voiceProfile;
  try {
    const active = await getActiveVoiceProfile(input.serviceClient, input.merchantId);
    if (!active) {
      return await failProposal(
        input,
        proposalId,
        "voice_profile",
        new Error("no_active_voice_profile"),
      );
    }
    voiceProfile = parseVoiceProfile(active.profile);
  } catch (err) {
    return await failProposal(input, proposalId, "voice_profile", err);
  }

  // ── Step 5: fetch the group's customers + build the aggregate summary ────
  let customerIds: string[];
  let groupSummary: GroupSummary;
  try {
    const group = await fetchGroupSummary(input.serviceClient, input.merchantId, input.groupSlug);
    if (group.customerIds.length === 0) {
      return await failProposal(
        input,
        proposalId,
        "group_fetch",
        new Error("group_has_no_customers"),
      );
    }
    customerIds = group.customerIds;
    groupSummary = group.summary;
  } catch (err) {
    return await failProposal(input, proposalId, "group_fetch", err);
  }

  // ── Step 6: PII pre-flight (decision 10, defense in depth) ───────────────
  try {
    assertNoPii(JSON.stringify(groupSummary));
  } catch (err) {
    return await failProposal(input, proposalId, "redact", err);
  }

  // ── Step 7: AI Campaign Designer ─────────────────────────────────────────
  let design: DesignCampaignResult;
  try {
    design = await designCampaign(input.anthropicClient, {
      merchantId: input.merchantId,
      groupSlug: input.groupSlug,
      voiceProfile,
      groupSummary,
      model: input.model,
    });
  } catch (err) {
    return await failProposal(input, proposalId, "design", err);
  }

  // ── Step 8: insert the campaign_arms variant rows ────────────────────────
  try {
    const armRows = design.variants.map((v, index) => ({
      proposal_id: proposalId,
      merchant_id: input.merchantId,
      variant_index: index,
      offer_type: v.offer_type,
      offer_value: v.offer_value,
      message_draft: v.message_draft,
      send_time_window: v.send_time_window,
      tone: v.tone,
      expected_impact: v.expected_impact as unknown as Json,
    }));
    const { error } = await input.serviceClient.from("campaign_arms").insert(armRows);
    if (error) throw error;
  } catch (err) {
    return await failProposal(input, proposalId, "design", err);
  }

  // ── Step 9: campaign_proposed event ──────────────────────────────────────
  const occurredAt = now().toISOString();
  try {
    await appendCampaignEvent(input.serviceClient, {
      eventType: "campaign_proposed",
      merchantId: input.merchantId,
      proposalId,
      occurredAt,
      payload: {
        variant_count: design.variants.length,
        model_version: design.modelVersion,
        tokens_input: design.tokensInput,
        tokens_output: design.tokensOutput,
        retries: design.retries,
      },
    });
  } catch (err) {
    return await failProposal(input, proposalId, "design", err);
  }

  // ── Step 10: snapshot the group + assign the holdout (decision 15) ───────
  let holdoutCount: number;
  let snapshotCustomerCount: number;
  try {
    const snapshot = await snapshotGroup(input.serviceClient, {
      merchantId: input.merchantId,
      proposalId,
      groupSlug: input.groupSlug,
      customerIds,
      holdoutRate,
    });
    holdoutCount = snapshot.holdoutIds.length;
    snapshotCustomerCount = snapshot.customerIds.length;
  } catch (err) {
    return await failProposal(input, proposalId, "snapshot", err);
  }

  // ── Step 11: arms_initialized event ──────────────────────────────────────
  try {
    await appendCampaignEvent(input.serviceClient, {
      eventType: "arms_initialized",
      merchantId: input.merchantId,
      proposalId,
      occurredAt: addMs(occurredAt, 1),
      payload: { arm_count: design.variants.length },
    });
  } catch (err) {
    return await failProposal(input, proposalId, "snapshot", err);
  }

  // ── Step 12: materialize the proposal status cache ───────────────────────
  try {
    await materializeCampaign(input.serviceClient, input.merchantId, proposalId);
  } catch (err) {
    return await failProposal(input, proposalId, "snapshot", err);
  }

  logStructured("propose_campaign_complete", {
    merchant_id: input.merchantId,
    proposal_id: proposalId,
    variant_count: design.variants.length,
    customer_count: snapshotCustomerCount,
    holdout_count: holdoutCount,
    tokens_input: design.tokensInput,
    tokens_output: design.tokensOutput,
    retries: design.retries,
  });

  return {
    ok: true,
    proposalId,
    variantCount: design.variants.length,
    customerCount: snapshotCustomerCount,
    holdoutCount,
    tokensInput: design.tokensInput,
    tokensOutput: design.tokensOutput,
    retries: design.retries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Count of campaign_proposed events for the merchant since UTC midnight. */
async function countProposedToday(
  client: LapsedSupabaseClient,
  merchantId: string,
  now: Date,
): Promise<number> {
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const { count, error } = await client
    .from("campaign_events")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("event_type", "campaign_proposed")
    .gte("occurred_at", utcMidnight.toISOString());
  if (error) throw error;
  return count ?? 0;
}

interface FetchGroupSummaryResult {
  customerIds: string[];
  summary: GroupSummary;
}

/**
 * Reads the group's current customer set from customer_inferred_state and
 * builds a PII-free aggregate summary from customer_rfm. Returns only counts,
 * medians, and shopify_customer_gid identifiers — never customer names,
 * emails, or phone numbers.
 */
async function fetchGroupSummary(
  client: LapsedSupabaseClient,
  merchantId: string,
  groupSlug: string,
): Promise<FetchGroupSummaryResult> {
  const { data: stateRows, error: stateErr } = await client
    .from("customer_inferred_state")
    .select("shopify_customer_gid, lifecycle_stage")
    .eq("merchant_id", merchantId)
    .contains("group_memberships", [groupSlug]);
  if (stateErr) throw stateErr;

  const rows = stateRows ?? [];
  const customerIds = rows.map((r) => r.shopify_customer_gid);

  const lifecycleCounts: Record<string, number> = {};
  for (const r of rows) {
    const stage = r.lifecycle_stage ?? "unknown";
    lifecycleCounts[stage] = (lifecycleCounts[stage] ?? 0) + 1;
  }

  if (customerIds.length === 0) {
    return {
      customerIds: [],
      summary: {
        customerCount: 0,
        lifecycleCounts: {},
        medianAovCents: 0,
        medianRecencyDays: 0,
        avgOrderCount: 0,
      },
    };
  }

  const { data: rfmRows, error: rfmErr } = await client
    .from("customer_rfm")
    .select("recency_days, frequency, monetary_cents")
    .eq("merchant_id", merchantId)
    .in("shopify_customer_gid", customerIds);
  if (rfmErr) throw rfmErr;

  const rfm = rfmRows ?? [];
  const aovValues: number[] = [];
  const recencyValues: number[] = [];
  let frequencySum = 0;
  for (const r of rfm) {
    const frequency = r.frequency ?? 0;
    const monetary = Number(r.monetary_cents ?? 0);
    frequencySum += frequency;
    if (frequency > 0) aovValues.push(Math.round(monetary / frequency));
    if (r.recency_days !== null && r.recency_days !== undefined) {
      recencyValues.push(r.recency_days);
    }
  }

  return {
    customerIds,
    summary: {
      customerCount: customerIds.length,
      lifecycleCounts,
      medianAovCents: median(aovValues),
      medianRecencyDays: median(recencyValues),
      avgOrderCount: rfm.length > 0 ? frequencySum / rfm.length : 0,
    },
  };
}

/** Median of a numeric list (0 for an empty list). Pure. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

/**
 * Writes a proposal_failed event for `phase`, materializes the proposal so its
 * cache reflects the (still-`proposed`) status, logs structurally, and returns
 * the failure result.
 */
async function failProposal(
  input: ProposeCampaignInput,
  proposalId: string,
  phase: CampaignFailurePhase,
  err: unknown,
): Promise<ProposeCampaignResult> {
  const reason = errorReason(err).slice(0, 128);
  try {
    await appendCampaignEvent(input.serviceClient, {
      eventType: "proposal_failed",
      merchantId: input.merchantId,
      proposalId,
      occurredAt: new Date().toISOString(),
      payload: { phase, reason },
    });
  } catch (appendErr) {
    logStructured("propose_campaign_event_append_failed", {
      merchant_id: input.merchantId,
      proposal_id: proposalId,
      phase,
      error: errorClassName(appendErr),
    });
  }
  logStructured("propose_campaign_failed", {
    merchant_id: input.merchantId,
    proposal_id: proposalId,
    phase,
    reason,
    error_class: errorClassName(err),
  });
  return { ok: false, reason: phase, detail: reason, proposalId };
}

function errorClassName(err: unknown): string {
  if (err instanceof PiiLeakError) return "PiiLeakError";
  if (err instanceof CampaignDesignError) return `CampaignDesignError:${err.reason}`;
  if (err instanceof Error) return err.name || "Error";
  return "UnknownError";
}

function errorReason(err: unknown): string {
  if (err instanceof PiiLeakError) return `pii_leak:${err.kinds.join(",")}`;
  if (err instanceof CampaignDesignError) return err.reason;
  if (err instanceof Error) return err.message || "unknown_error";
  return String(err);
}

/** Adds milliseconds to an ISO timestamp so same-tick events stay distinct. */
function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function logStructured(event: string, fields: Record<string, unknown>): void {
  // Single-line JSON for log aggregation. NEVER includes customer PII or
  // LLM-generated message text (decision 10 + criterion 8).
  console.log(JSON.stringify({ event, ...fields }));
}
