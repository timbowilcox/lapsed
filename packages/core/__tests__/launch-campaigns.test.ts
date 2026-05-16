import { describe, expect, it } from "vitest";
import { launchMerchantCampaigns } from "../src/launch-campaigns";
import type { TwilioClient } from "../src/twilio-client";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const PROPOSAL = "11111111-1111-4111-8111-111111111111";
const ARMS = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const FROM = "+18888800461";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

function fakeTwilio(opts: { fail?: boolean } = {}): { client: TwilioClient; sendCount: () => number } {
  let calls = 0;
  const client: TwilioClient = {
    sendSms: async () => {
      calls += 1;
      if (opts.fail) {
        return { ok: false, errorCode: 30007, errorClass: "Error", detail: "carrier filtered", attempts: 3 };
      }
      return { ok: true, twilioSid: `SM_${calls}`, status: "queued", attempts: 1 };
    },
    recordOptOut: async () => {},
  };
  return { client, sendCount: () => calls };
}

interface SeedOpts {
  /** Customer gids that are NOT in the holdout. */
  targets?: string[];
  /** Customer gids that ARE in the holdout. */
  holdout?: string[];
  /** Customer gids that have opted out. */
  optedOut?: string[];
  /** message_outbound_sent events already recorded today (cap pressure). */
  sentToday?: number;
  /** Omit arms/bandit_state to simulate an un-initialized proposal. */
  withArms?: boolean;
  /** Omit the campaign_approved event so the proposal is not "ready". */
  ready?: boolean;
}

function seedWorld(opts: SeedOpts = {}) {
  const targets = opts.targets ?? ["gid://shopify/Customer/1", "gid://shopify/Customer/2"];
  const holdout = opts.holdout ?? [];
  const optedOut = opts.optedOut ?? [];
  const withArms = opts.withArms ?? true;
  const ready = opts.ready ?? true;
  const allCustomers = [...targets, ...holdout];

  const seed: Record<string, FakeRow[]> = {
    campaign_proposals: [
      { id: PROPOSAL, merchant_id: MERCHANT, group_slug: "lapsed_vips", version_number: 1, model_version: "claude-sonnet-4-6-test" },
    ],
    customers: allCustomers.map((gid) => ({
      merchant_id: MERCHANT,
      shopify_customer_gid: gid,
      phone: `+1555000${gid.slice(-4).padStart(4, "0")}`,
    })),
    campaign_group_snapshots: [
      ...targets.map((gid) => ({ proposal_id: PROPOSAL, merchant_id: MERCHANT, customer_id: gid, included_in_holdout: false })),
      ...holdout.map((gid) => ({ proposal_id: PROPOSAL, merchant_id: MERCHANT, customer_id: gid, included_in_holdout: true })),
    ],
  };

  if (ready) {
    seed.campaign_events = [
      {
        merchant_id: MERCHANT,
        proposal_id: PROPOSAL,
        event_type: "campaign_approved",
        occurred_at: "2026-05-15T00:00:00.000Z",
        ingested_at: "2026-05-15T00:00:00.000Z",
        payload: { user_id: "u1" },
      },
    ];
  }
  if (withArms) {
    seed.campaign_arms = ARMS.map((armId, i) => ({
      bandit_arm_id: armId,
      proposal_id: PROPOSAL,
      merchant_id: MERCHANT,
      variant_index: i,
      message_draft: `Variant ${i} — we miss you, here's an offer.`,
    }));
    seed.bandit_state = ARMS.map((armId) => ({
      arm_id: armId,
      merchant_id: MERCHANT,
      proposal_id: PROPOSAL,
      sentiment_alpha: 1,
      sentiment_beta: 1,
      observation_count: 0,
    }));
  }
  if (optedOut.length > 0) {
    seed.customer_opt_outs = optedOut.map((gid) => ({
      merchant_id: MERCHANT,
      customer_id: gid,
      phone_number: "+15550000000",
      source: "stop_keyword",
    }));
  }
  if (opts.sentToday && opts.sentToday > 0) {
    seed.message_events = Array.from({ length: opts.sentToday }, (_, i) => ({
      merchant_id: MERCHANT,
      conversation_id: "c",
      event_type: "message_outbound_sent",
      occurred_at: new Date().toISOString(),
      payload: { twilio_sid: `SM_old_${i}` },
    }));
  }
  return makeFakeSupabase(seed);
}

function opts(over: Partial<Parameters<typeof launchMerchantCampaigns>[2]> = {}) {
  return { merchantId: MERCHANT, fromNumber: FROM, outboundDailyCap: 200, ...over };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("launchMerchantCampaigns — happy path", () => {
  it("sends one message per non-holdout customer", async () => {
    const fake = seedWorld({ targets: ["gid://shopify/Customer/1", "gid://shopify/Customer/2"] });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(result.sent).toBe(2);
    expect(result.proposalsConsidered).toBe(1);
    expect(twilio.sendCount()).toBe(2);
    expect((fake.tables.messages ?? []).filter((m) => m.direction === "outbound")).toHaveLength(2);
  });

  it("records each outbound with its sampled arm_id and the campaign_id", async () => {
    const fake = seedWorld({ targets: ["gid://shopify/Customer/1"] });
    const twilio = fakeTwilio();
    await launchMerchantCampaigns(fake.client, twilio.client, opts());
    const msg = (fake.tables.messages ?? [])[0] as FakeRow;
    expect(msg.campaign_id).toBe(PROPOSAL);
    expect(ARMS).toContain(msg.arm_id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Holdout exclusion (decision 5 / 15)
// ─────────────────────────────────────────────────────────────────────────────

describe("launchMerchantCampaigns — holdout exclusion", () => {
  it("never sends to a holdout customer", async () => {
    const fake = seedWorld({
      targets: ["gid://shopify/Customer/1"],
      holdout: ["gid://shopify/Customer/9"],
    });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(result.sent).toBe(1);
    const sentTo = (fake.tables.messages ?? []).map((m) => m.conversation_id);
    // The holdout customer has no conversation / message at all.
    const holdoutConv = (fake.tables.conversations ?? []).find(
      (c) => c.customer_id === "gid://shopify/Customer/9",
    );
    expect(holdoutConv).toBeUndefined();
    expect(sentTo).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Opt-out exclusion (decision 18)
// ─────────────────────────────────────────────────────────────────────────────

describe("launchMerchantCampaigns — opt-out exclusion", () => {
  it("silently excludes an opted-out customer", async () => {
    const fake = seedWorld({
      targets: ["gid://shopify/Customer/1", "gid://shopify/Customer/2"],
      optedOut: ["gid://shopify/Customer/2"],
    });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(result.sent).toBe(1);
    expect(result.skippedOptedOut).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — re-running does not re-launch
// ─────────────────────────────────────────────────────────────────────────────

describe("launchMerchantCampaigns — idempotency", () => {
  it("a second run skips every already-sent customer", async () => {
    const fake = seedWorld({ targets: ["gid://shopify/Customer/1", "gid://shopify/Customer/2"] });
    const twilio = fakeTwilio();
    const first = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(first.sent).toBe(2);

    const second = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(second.sent).toBe(0);
    expect(second.skippedAlreadySent).toBe(2);
    // No new outbound rows.
    expect((fake.tables.messages ?? []).filter((m) => m.direction === "outbound")).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Daily cap (cost discipline)
// ─────────────────────────────────────────────────────────────────────────────

describe("launchMerchantCampaigns — daily cap", () => {
  it("stops sending and sets capReached when the cap is exhausted", async () => {
    const fake = seedWorld({
      targets: ["gid://shopify/Customer/1", "gid://shopify/Customer/2", "gid://shopify/Customer/3"],
      sentToday: 5,
    });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts({ outboundDailyCap: 5 }));
    expect(result.capReached).toBe(true);
    expect(result.sent).toBe(0);
    expect(twilio.sendCount()).toBe(0);
  });

  it("sends up to the cap then stops", async () => {
    const fake = seedWorld({
      targets: ["gid://shopify/Customer/1", "gid://shopify/Customer/2", "gid://shopify/Customer/3"],
      sentToday: 3,
    });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts({ outboundDailyCap: 5 }));
    // cap is 5, 3 already used → 2 sends then cap_reached
    expect(result.sent).toBe(2);
    expect(result.capReached).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("launchMerchantCampaigns — edge cases", () => {
  it("considers no proposals when none are approved", async () => {
    const fake = seedWorld({ ready: false });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(result.proposalsConsidered).toBe(0);
    expect(result.sent).toBe(0);
  });

  it("skips a proposal with no initialized arms", async () => {
    const fake = seedWorld({ withArms: false });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(result.proposalsConsidered).toBe(1);
    expect(result.sent).toBe(0);
    expect(twilio.sendCount()).toBe(0);
  });

  it("rejects a non-UUID merchantId", async () => {
    const fake = seedWorld();
    const twilio = fakeTwilio();
    await expect(
      launchMerchantCampaigns(fake.client, twilio.client, opts({ merchantId: "nope" })),
    ).rejects.toThrow();
  });

  it("counts a customer with no phone as skippedNoPhone", async () => {
    const fake = seedWorld({ targets: ["gid://shopify/Customer/1"] });
    // Strip the phone from the seeded customer.
    (fake.tables.customers[0] as FakeRow).phone = null;
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(result.sent).toBe(0);
    expect(result.skippedNoPhone).toBe(1);
  });

  it("counts a Twilio send failure as failed", async () => {
    const fake = seedWorld({ targets: ["gid://shopify/Customer/1"] });
    const twilio = fakeTwilio({ fail: true });
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("counts a sampled arm with no campaign_arms row as failed (integrity fault)", async () => {
    // bandit_state has arm Z; campaign_arms has a DIFFERENT arm W. thompsonSample
    // can only pick Z (the sole bandit_state row), and arms.get(Z) is undefined.
    const ARM_Z = "99999999-9999-4999-8999-999999999999";
    const ARM_W = "88888888-8888-4888-8888-888888888888";
    const fake = makeFakeSupabase({
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
      campaign_arms: [
        { bandit_arm_id: ARM_W, proposal_id: PROPOSAL, merchant_id: MERCHANT, variant_index: 0, message_draft: "x" },
      ],
      bandit_state: [
        { arm_id: ARM_Z, merchant_id: MERCHANT, proposal_id: PROPOSAL, sentiment_alpha: 1, sentiment_beta: 1, observation_count: 0 },
      ],
      campaign_group_snapshots: [
        { proposal_id: PROPOSAL, merchant_id: MERCHANT, customer_id: "gid://shopify/Customer/1", included_in_holdout: false },
      ],
      customers: [{ merchant_id: MERCHANT, shopify_customer_gid: "gid://shopify/Customer/1", phone: "+15550001111" }],
    });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts());
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(twilio.sendCount()).toBe(0);
  });

  it("a cap hit mid-proposal stops the outer loop — a later ready proposal sends nothing", async () => {
    const PROPOSAL_2 = "55555555-5555-4555-8555-555555555555";
    const ARM_2 = "66666666-6666-4666-8666-666666666666";
    const fake = makeFakeSupabase({
      campaign_proposals: [
        { id: PROPOSAL, merchant_id: MERCHANT, group_slug: "g1", version_number: 1, model_version: "m" },
        { id: PROPOSAL_2, merchant_id: MERCHANT, group_slug: "g2", version_number: 1, model_version: "m" },
      ],
      campaign_events: [
        { merchant_id: MERCHANT, proposal_id: PROPOSAL, event_type: "campaign_approved", occurred_at: "2026-05-15T00:00:00.000Z", ingested_at: "2026-05-15T00:00:00.000Z", payload: { user_id: "u" } },
        { merchant_id: MERCHANT, proposal_id: PROPOSAL_2, event_type: "campaign_approved", occurred_at: "2026-05-14T00:00:00.000Z", ingested_at: "2026-05-14T00:00:00.000Z", payload: { user_id: "u" } },
      ],
      campaign_arms: [
        { bandit_arm_id: ARMS[0], proposal_id: PROPOSAL, merchant_id: MERCHANT, variant_index: 0, message_draft: "p1" },
        { bandit_arm_id: ARM_2, proposal_id: PROPOSAL_2, merchant_id: MERCHANT, variant_index: 0, message_draft: "p2" },
      ],
      bandit_state: [
        { arm_id: ARMS[0], merchant_id: MERCHANT, proposal_id: PROPOSAL, sentiment_alpha: 1, sentiment_beta: 1, observation_count: 0 },
        { arm_id: ARM_2, merchant_id: MERCHANT, proposal_id: PROPOSAL_2, sentiment_alpha: 1, sentiment_beta: 1, observation_count: 0 },
      ],
      campaign_group_snapshots: [
        { proposal_id: PROPOSAL, merchant_id: MERCHANT, customer_id: "gid://shopify/Customer/1", included_in_holdout: false },
        { proposal_id: PROPOSAL_2, merchant_id: MERCHANT, customer_id: "gid://shopify/Customer/2", included_in_holdout: false },
      ],
      customers: [
        { merchant_id: MERCHANT, shopify_customer_gid: "gid://shopify/Customer/1", phone: "+15550001111" },
        { merchant_id: MERCHANT, shopify_customer_gid: "gid://shopify/Customer/2", phone: "+15550002222" },
      ],
      // Cap already exhausted before the run begins.
      message_events: [
        { merchant_id: MERCHANT, conversation_id: "c", event_type: "message_outbound_sent", occurred_at: new Date().toISOString(), payload: { twilio_sid: "SM_old" } },
      ],
    });
    const twilio = fakeTwilio();
    const result = await launchMerchantCampaigns(fake.client, twilio.client, opts({ outboundDailyCap: 1 }));
    expect(result.capReached).toBe(true);
    expect(result.sent).toBe(0);
    // Both ready proposals were counted even though the loop stopped at the first.
    expect(result.proposalsConsidered).toBe(2);
    // The second proposal's customer was never messaged.
    expect((fake.tables.messages ?? [])).toHaveLength(0);
  });
});
