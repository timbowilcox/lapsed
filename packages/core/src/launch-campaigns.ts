// Campaign launcher — turns approved campaign proposals into outbound SMS.
// Implements the body of Sprint 07 chunk 8. The /api/cron/launch-campaigns
// route owns merchant iteration + auth; this module owns the per-merchant
// launch flow:
//
//   getReadyCampaigns → for each proposal: load the frozen group snapshot
//   (decision 15), drop the holdout, Thompson-sample an arm per customer
//   (decision 4), and sendMessage the arm's variant draft.
//
// IDEMPOTENCY (deliberate deviation from SPRINT.md's "mark launched_at"):
// there is no launched_at column or campaign_launched event. Re-running the
// cron is idempotent at the per-customer grain — sendMessage's campaign guard
// returns `already_sent` for any (campaign, customer) already messaged. This
// achieves SPRINT.md's "re-running the cron doesn't re-launch" guarantee
// without a schema change or a Sprint-06 campaign_events taxonomy change.
// Recorded in HANDOFF.md deliberate-deviations.
//
// Decision 18: every send is gated by assertNotOptedOut inside sendMessage —
// opted-out customers are silently excluded.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type { TwilioClient } from "./twilio-client";
import { getReadyCampaigns } from "./campaign-events";
import { thompsonSample, type BanditState } from "./bandit";
import { sendMessage } from "./send-message";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface LaunchMerchantCampaignsOpts {
  merchantId: string;
  /** Merchant outbound Twilio number (TWILIO_PHONE_NUMBER). */
  fromNumber: string;
  /** Per-merchant per-UTC-day outbound cap (OUTBOUND_DAILY_CAP_DEFAULT). */
  outboundDailyCap: number;
  now?: () => Date;
}

export interface LaunchMerchantCampaignsResult {
  merchantId: string;
  proposalsConsidered: number;
  sent: number;
  skippedAlreadySent: number;
  skippedOptedOut: number;
  skippedNoPhone: number;
  failed: number;
  /** True when the daily cap was hit — remaining customers resume next day. */
  capReached: boolean;
}

interface ArmVariant {
  banditArmId: string;
  messageDraft: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// launchMerchantCampaigns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launches every ready (approved, not-yet-fully-sent) campaign for one
 * merchant. For each proposal: loads the frozen `campaign_group_snapshots`
 * customer set, excludes the holdout, and for each remaining customer
 * Thompson-samples an arm and sends its variant draft via `sendMessage`.
 *
 * Stops sending for the merchant as soon as `sendMessage` reports
 * `cap_reached` — the daily cap is exhausted and remaining customers resume
 * on the next cron tick (cost discipline). Returns a per-merchant tally.
 */
export async function launchMerchantCampaigns(
  serviceClient: LapsedSupabaseClient,
  twilioClient: TwilioClient,
  opts: LaunchMerchantCampaignsOpts,
): Promise<LaunchMerchantCampaignsResult> {
  z.string().uuid("merchantId must be a UUID").parse(opts.merchantId);

  const result: LaunchMerchantCampaignsResult = {
    merchantId: opts.merchantId,
    proposalsConsidered: 0,
    sent: 0,
    skippedAlreadySent: 0,
    skippedOptedOut: 0,
    skippedNoPhone: 0,
    failed: 0,
    capReached: false,
  };

  const ready = await getReadyCampaigns(serviceClient, opts.merchantId);
  // proposalsConsidered counts every ready campaign this run looked at — it is
  // set up front so a mid-run cap stop does not undercount the proposals that
  // were deferred. capReached signals that some were not sent.
  result.proposalsConsidered = ready.length;

  for (const campaign of ready) {
    if (result.capReached) break;

    const arms = await loadArms(serviceClient, opts.merchantId, campaign.proposalId);
    const banditStates = await loadBanditStates(serviceClient, opts.merchantId, campaign.proposalId);
    if (arms.size === 0 || banditStates.length === 0) {
      // Both absent → an un-initialized proposal (benign skip). Exactly one
      // absent → a partial-initialization fault (decision 14 — arms and their
      // bandit_state are written together at approval); surface it distinctly.
      const partialInit = !(arms.size === 0 && banditStates.length === 0);
      logStructured(partialInit ? "launch_campaign_partial_init" : "launch_campaign_skipped_no_arms", {
        merchant_id: opts.merchantId,
        proposal_id: campaign.proposalId,
        arm_count: arms.size,
        bandit_state_count: banditStates.length,
      });
      continue;
    }

    // Decision 15: the targeted customers are the frozen snapshot MINUS the
    // holdout. The holdout never receives a send.
    const targets = await loadNonHoldoutCustomers(
      serviceClient,
      opts.merchantId,
      campaign.proposalId,
    );

    for (const customerId of targets) {
      // Decision 4: Thompson-sample an arm. The seed is deterministic per
      // (proposal, customer) so a re-run samples the same arm — though the
      // sendMessage guard makes a re-run a no-op regardless.
      const seed = hashSeed(`${campaign.proposalId}:${customerId}`);
      const armId = thompsonSample(banditStates, { seed });
      const variant = arms.get(armId);
      if (!variant) {
        // A sampled arm with no campaign_arms row — a data integrity fault.
        logStructured("launch_campaign_arm_missing", {
          merchant_id: opts.merchantId,
          proposal_id: campaign.proposalId,
          arm_id: armId,
        });
        result.failed += 1;
        continue;
      }

      const send = await sendMessage(
        serviceClient,
        twilioClient,
        {
          merchantId: opts.merchantId,
          customerId,
          body: variant.messageDraft,
          fromNumber: opts.fromNumber,
          campaignId: campaign.proposalId,
          armId,
          outboundDailyCap: opts.outboundDailyCap,
        },
        { now: opts.now },
      );

      if (send.ok) {
        result.sent += 1;
      } else if (send.reason === "cap_reached") {
        result.capReached = true;
        logStructured("launch_campaign_cap_reached", {
          merchant_id: opts.merchantId,
          proposal_id: campaign.proposalId,
        });
        break;
      } else if (send.reason === "already_sent") {
        result.skippedAlreadySent += 1;
      } else if (send.reason === "opted_out") {
        result.skippedOptedOut += 1;
      } else if (send.reason === "no_phone") {
        result.skippedNoPhone += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  logStructured("launch_campaigns_merchant_complete", {
    merchant_id: opts.merchantId,
    proposals_considered: result.proposalsConsidered,
    sent: result.sent,
    skipped_already_sent: result.skippedAlreadySent,
    skipped_opted_out: result.skippedOptedOut,
    skipped_no_phone: result.skippedNoPhone,
    failed: result.failed,
    cap_reached: result.capReached,
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────

/** Loads the proposal's arms, keyed by bandit_arm_id → variant draft. */
async function loadArms(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
): Promise<Map<string, ArmVariant>> {
  const { data, error } = await serviceClient
    .from("campaign_arms")
    .select("bandit_arm_id, message_draft")
    .eq("merchant_id", merchantId)
    .eq("proposal_id", proposalId);
  if (error) throw error;
  const map = new Map<string, ArmVariant>();
  for (const row of data ?? []) {
    map.set(row.bandit_arm_id, {
      banditArmId: row.bandit_arm_id,
      messageDraft: row.message_draft,
    });
  }
  return map;
}

/** Loads the proposal's bandit posteriors as BanditState[] for thompsonSample. */
async function loadBanditStates(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
): Promise<BanditState[]> {
  const { data, error } = await serviceClient
    .from("bandit_state")
    .select("arm_id, merchant_id, proposal_id, alpha, beta, observation_count, last_updated_at")
    .eq("merchant_id", merchantId)
    .eq("proposal_id", proposalId);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    armId: row.arm_id,
    merchantId: row.merchant_id,
    proposalId: row.proposal_id,
    alpha: row.alpha,
    beta: row.beta,
    observationCount: row.observation_count,
    lastUpdatedAt: row.last_updated_at,
  }));
}

/** Loads the non-holdout customer ids from the frozen group snapshot. */
async function loadNonHoldoutCustomers(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
  proposalId: string,
): Promise<string[]> {
  const { data, error } = await serviceClient
    .from("campaign_group_snapshots")
    .select("customer_id")
    .eq("merchant_id", merchantId)
    .eq("proposal_id", proposalId)
    .eq("included_in_holdout", false);
  if (error) throw error;
  return (data ?? []).map((row) => row.customer_id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** FNV-1a hash of a string to a 32-bit unsigned int — a deterministic seed. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Single-line JSON structured log. Never includes raw phone, body, or PII. */
function logStructured(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}
