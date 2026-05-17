// Sprint 07 chunk 12 — conversation engine end-to-end flow.
//
// This is the integration test of the FULL conversation engine: an approved
// campaign launches → an outbound is sent + recorded → a customer reply is
// handled in-band (classified, replied to, posterior updated) → a STOP reply
// opts the customer out → a re-launch excludes the opted-out customer.
//
// It runs at the orchestration layer with the in-memory Supabase fake, a fake
// Twilio client, and mock Anthropic clients — the same seams the per-chunk
// unit tests use. See HANDOFF.md "Deliberate deviations": a browser-level
// Playwright run of this flow is constrained by the API routes constructing
// their Twilio/Anthropic clients from env with no injection seam; the
// route-level security boundaries (signature 403, cron 401) are covered by
// apps/web/e2e/conversation-engine.spec.ts.

import { beforeEach, describe, expect, it } from "vitest";
import { launchMerchantCampaigns } from "../src/launch-campaigns";
import { _clearEntitlementsCache } from "../src/entitlements";
import { handleInboundMessage } from "../src/handle-inbound";
import { validateWebhookSignature } from "../src/twilio-client";
import type { TwilioClient } from "../src/twilio-client";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";
import type Anthropic from "@anthropic-ai/sdk";

// The entitlements cache is process-global — clear it between tests.
beforeEach(() => _clearEntitlementsCache());

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const PROPOSAL = "11111111-1111-4111-8111-111111111111";
const ARMS = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const CUSTOMER = "gid://shopify/Customer/9001";
const PHONE = "+15551239001";
const HOLDOUT_CUSTOMER = "gid://shopify/Customer/9002";
const FROM_NUMBER = "+18888800461";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

function fakeTwilio(): { client: TwilioClient; sends: number; optOuts: string[] } {
  const state = { sends: 0, optOuts: [] as string[] };
  const client: TwilioClient = {
    sendSms: async () => {
      state.sends += 1;
      return { ok: true, twilioSid: `SM_${state.sends}`, status: "queued", attempts: 1 };
    },
    recordOptOut: async (phone: string) => {
      state.optOuts.push(phone);
    },
  };
  return {
    client,
    get sends() {
      return state.sends;
    },
    get optOuts() {
      return state.optOuts;
    },
  } as { client: TwilioClient; sends: number; optOuts: string[] };
}

function mockLlm(toolName: string, input: unknown): Anthropic {
  return countingLlm(toolName, input).client;
}

/** A mock Anthropic client that also exposes how many times it was invoked. */
function countingLlm(
  toolName: string,
  input: unknown,
): { client: Anthropic; calls: () => number } {
  let calls = 0;
  const client = {
    messages: {
      create: async () => {
        calls += 1;
        return {
          content: [{ type: "tool_use", id: "tu", name: toolName, input }],
          usage: { input_tokens: 40, output_tokens: 20 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => calls };
}

/** Seeds an approved Sprint-06 campaign with one targeted customer. */
function seedApprovedCampaign() {
  return makeFakeSupabase({
    // Sprint 09: the launcher gates on merchant entitlements — an active
    // subscription is required for outbound sends to proceed.
    merchants: [
      {
        id: MERCHANT,
        shopify_shop_domain: "flow-test.myshopify.com",
        subscription_tier: "growth",
        subscription_status: "active",
      },
    ],
    campaign_proposals: [
      { id: PROPOSAL, merchant_id: MERCHANT, group_slug: "lapsed_vips", version_number: 1, model_version: "m" },
    ],
    campaign_events: [
      {
        merchant_id: MERCHANT,
        proposal_id: PROPOSAL,
        event_type: "campaign_approved",
        occurred_at: "2026-05-15T00:00:00.000Z",
        ingested_at: "2026-05-15T00:00:00.000Z",
        payload: { user_id: "u1" },
      },
    ],
    campaign_arms: ARMS.map((armId, i) => ({
      bandit_arm_id: armId,
      proposal_id: PROPOSAL,
      merchant_id: MERCHANT,
      variant_index: i,
      message_draft: `Variant ${i} — we've missed you, here's 15% off.`,
    })),
    bandit_state: ARMS.map((armId) => ({
      arm_id: armId,
      merchant_id: MERCHANT,
      proposal_id: PROPOSAL,
      sentiment_alpha: 1,
      sentiment_beta: 1,
      observation_count: 0,
      order_alpha: 1,
      order_beta: 1,
      order_observation_count: 0,
      order_last_updated_at: null,
    })),
    campaign_group_snapshots: [
      { proposal_id: PROPOSAL, merchant_id: MERCHANT, customer_id: CUSTOMER, included_in_holdout: false },
      // A holdout customer — decision 5/15: never receives a send.
      { proposal_id: PROPOSAL, merchant_id: MERCHANT, customer_id: HOLDOUT_CUSTOMER, included_in_holdout: true },
    ],
    customers: [
      { merchant_id: MERCHANT, shopify_customer_gid: CUSTOMER, phone: PHONE, last_order_at: "2026-01-01" },
      { merchant_id: MERCHANT, shopify_customer_gid: HOLDOUT_CUSTOMER, phone: "+15551239002" },
    ],
    customer_inferred_state: [
      { merchant_id: MERCHANT, shopify_customer_gid: CUSTOMER, lifecycle_stage: "lapsed", propensity_90d: 0.5 },
    ],
  });
}

const POSITIVE = { sentiment: "positive", intent: "purchase", confidence: 0.92 };
const REPLY = { body: "Brilliant — here's your 15% link. No rush at all." };

// ─────────────────────────────────────────────────────────────────────────────
// The full flow
// ─────────────────────────────────────────────────────────────────────────────

describe("conversation engine — end-to-end flow (chunk 12)", () => {
  it("launch → outbound → inbound reply → posterior → STOP opt-out → re-launch excludes", async () => {
    const fake = seedApprovedCampaign();
    const twilio = fakeTwilio();

    // ── 1. Launch the approved campaign ──────────────────────────────────────
    const launch = await launchMerchantCampaigns(fake.client, twilio.client, {
      merchantId: MERCHANT,
      fromNumber: FROM_NUMBER,
      outboundDailyCap: 200,
    });
    // Exactly one send — the holdout customer is excluded (decision 5/15):
    // they get no conversation and no message.
    expect(launch.sent).toBe(1);
    expect(twilio.sends).toBe(1);
    expect((fake.tables.conversations ?? []).some((c) => c.customer_id === HOLDOUT_CUSTOMER)).toBe(
      false,
    );

    // An outbound message + queued/sent events were recorded.
    const outbound = (fake.tables.messages ?? []).find((m) => m.direction === "outbound") as FakeRow;
    expect(outbound).toBeTruthy();
    expect(outbound.campaign_id).toBe(PROPOSAL);
    const sampledArm = outbound.arm_id as string;
    expect(ARMS).toContain(sampledArm);
    const launchEventTypes = (fake.tables.message_events ?? []).map((e) => e.event_type);
    expect(launchEventTypes).toContain("message_outbound_queued");
    expect(launchEventTypes).toContain("message_outbound_sent");

    // ── 2. The customer replies (positive) — handled in-band ─────────────────
    const deps = {
      serviceClient: fake.client,
      twilioClient: twilio.client,
      classifyClient: mockLlm("classify_reply", POSITIVE),
      generateClient: mockLlm("generate_reply", REPLY),
    };
    const inbound = await handleInboundMessage(deps, {
      fromNumber: PHONE,
      toNumber: FROM_NUMBER,
      body: "yes please send it over",
      twilioSid: "SM_inbound_1",
      latencyBudgetMs: 5000,
    });
    expect(inbound.outcome).toBe("replied");
    expect(inbound.replyBody).toBe(REPLY.body);

    const eventTypes = (fake.tables.message_events ?? []).map((e) => e.event_type);
    expect(eventTypes).toContain("message_inbound_received");
    expect(eventTypes).toContain("inbound_classified");
    expect(eventTypes).toContain("reply_generated");
    expect(eventTypes).toContain("reply_sent");
    expect(eventTypes).toContain("posterior_updated");

    // ── 3. The bandit posterior moved on the sampled arm (positive+purchase
    //       → success → alpha + 1) ───────────────────────────────────────────
    const armState = (fake.tables.bandit_state ?? []).find((b) => b.arm_id === sampledArm) as FakeRow;
    expect(armState.sentiment_alpha).toBe(2);
    expect(armState.sentiment_beta).toBe(1);

    // ── 4. The customer texts STOP — opted out, dual-recorded ────────────────
    const stop = await handleInboundMessage(deps, {
      fromNumber: PHONE,
      toNumber: FROM_NUMBER,
      body: "STOP",
      twilioSid: "SM_inbound_stop",
      latencyBudgetMs: 5000,
    });
    expect(stop.outcome).toBe("opted_out");
    expect(fake.tables.customer_opt_outs).toHaveLength(1);
    expect((fake.tables.customer_opt_outs[0] as FakeRow).source).toBe("stop_keyword");
    // Twilio's opt-out leg was called (dual-record — decision 18).
    expect(twilio.optOuts).toContain(PHONE);

    // ── 5. Re-launch the campaign — the opted-out customer is excluded ───────
    const relaunch = await launchMerchantCampaigns(fake.client, twilio.client, {
      merchantId: MERCHANT,
      fromNumber: FROM_NUMBER,
      outboundDailyCap: 200,
    });
    expect(relaunch.sent).toBe(0);
    expect(relaunch.skippedOptedOut).toBe(1);
    // No second CAMPAIGN outbound was sent — only the original campaign send
    // carries campaign_id (the in-band AI reply is a non-campaign outbound).
    const campaignOutbounds = (fake.tables.messages ?? []).filter(
      (m) => m.direction === "outbound" && m.campaign_id === PROPOSAL,
    );
    expect(campaignOutbounds).toHaveLength(1);
  });

  it("a duplicate inbound webhook (same MessageSid) does not double-fire the posterior", async () => {
    const fake = seedApprovedCampaign();
    const twilio = fakeTwilio();
    await launchMerchantCampaigns(fake.client, twilio.client, {
      merchantId: MERCHANT,
      fromNumber: FROM_NUMBER,
      outboundDailyCap: 200,
    });
    const sampledArm = ((fake.tables.messages ?? []).find((m) => m.direction === "outbound") as FakeRow)
      .arm_id as string;
    const classify = countingLlm("classify_reply", POSITIVE);
    const generate = countingLlm("generate_reply", REPLY);
    const deps = {
      serviceClient: fake.client,
      twilioClient: twilio.client,
      classifyClient: classify.client,
      generateClient: generate.client,
    };
    const inboundInput = {
      fromNumber: PHONE,
      toNumber: FROM_NUMBER,
      body: "yes please",
      twilioSid: "SM_dup_1",
      latencyBudgetMs: 5000,
    };
    await handleInboundMessage(deps, inboundInput);
    const callsAfterFirst = { classify: classify.calls(), generate: generate.calls() };
    // Twilio retries the same MessageSid — must be a no-op.
    const retry = await handleInboundMessage(deps, inboundInput);
    expect(retry.outcome).toBe("duplicate");
    const armState = (fake.tables.bandit_state ?? []).find((b) => b.arm_id === sampledArm) as FakeRow;
    // sentiment_alpha stayed at 2 — the posterior was not double-counted.
    expect(armState.sentiment_alpha).toBe(2);
    // Neither Sonnet call was re-invoked on the retry (decision 17 — the
    // dedup short-circuit happens before any LLM call).
    expect(classify.calls()).toBe(callsAfterFirst.classify);
    expect(generate.calls()).toBe(callsAfterFirst.generate);
  });

  it("a tampered Twilio webhook signature fails validation", () => {
    // The /api/sms/inbound route 403s a request whose signature does not
    // validate — before any DB write or LLM call (criterion 2).
    const authToken = "twilio_auth_token";
    const url = "https://app.lapsed.ai/api/sms/inbound";
    const params = { From: PHONE, To: FROM_NUMBER, Body: "hello", MessageSid: "SM_x" };
    expect(
      validateWebhookSignature({ authToken, signature: "forged-signature", url, params }),
    ).toBe(false);
  });

  it("an LLM step over the latency budget degrades to a safe fallback reply", async () => {
    const fake = seedApprovedCampaign();
    const twilio = fakeTwilio();
    await launchMerchantCampaigns(fake.client, twilio.client, {
      merchantId: MERCHANT,
      fromNumber: FROM_NUMBER,
      outboundDailyCap: 200,
    });
    // A hanging classify client + a tiny budget forces the degraded path.
    const hangingClassify = {
      messages: { create: async () => new Promise(() => {}) },
    } as unknown as Anthropic;
    const result = await handleInboundMessage(
      {
        serviceClient: fake.client,
        twilioClient: twilio.client,
        classifyClient: hangingClassify,
        generateClient: mockLlm("generate_reply", REPLY),
      },
      {
        fromNumber: PHONE,
        toNumber: FROM_NUMBER,
        body: "anyone there?",
        twilioSid: "SM_degraded_1",
        latencyBudgetMs: 1050,
      },
    );
    expect(result.outcome).toBe("degraded");
    expect((fake.tables.message_events ?? []).map((e) => e.event_type)).toContain("degraded_mode");
  });
});
