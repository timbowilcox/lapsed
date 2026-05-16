import { describe, expect, it } from "vitest";
import { sweepNoReplyPosteriors, retryDegradedReplies } from "../src/conversation-sweep";
import type { HandleInboundDeps } from "../src/handle-inbound";
import type { TwilioClient } from "../src/twilio-client";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";
import type Anthropic from "@anthropic-ai/sdk";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ARM = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const INBOUND = "44444444-4444-4444-8444-444444444444";
const PRIOR_OUTBOUND = "55555555-5555-4555-8555-555555555555";
const CUSTOMER = "gid://shopify/Customer/1";

const OLD = "2026-04-01T00:00:00.000Z"; // > 7 days before the 2026-05-16 test date
const RECENT = new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// Part A — sweepNoReplyPosteriors
// ─────────────────────────────────────────────────────────────────────────────

function seedSweep(over: { sentAt?: string; posteriorUpdatedAt?: string | null; armId?: string | null } = {}) {
  return makeFakeSupabase({
    bandit_state: [
      { arm_id: ARM, merchant_id: MERCHANT, proposal_id: PROPOSAL, alpha: 1, beta: 1, observation_count: 0 },
    ],
    messages: [
      {
        id: PRIOR_OUTBOUND,
        merchant_id: MERCHANT,
        conversation_id: CONVERSATION,
        direction: "outbound",
        arm_id: over.armId === undefined ? ARM : over.armId,
        campaign_id: PROPOSAL,
        sent_at: over.sentAt ?? OLD,
        posterior_updated_at: over.posteriorUpdatedAt ?? null,
      },
    ],
  });
}

describe("sweepNoReplyPosteriors", () => {
  it("fires success=false for an old campaign outbound with no posterior yet", async () => {
    const fake = seedSweep();
    const result = await sweepNoReplyPosteriors(fake.client, {
      merchantId: MERCHANT,
      noReplySweepDays: 7,
    });
    expect(result.sweptCount).toBe(1);
    const arm = (fake.tables.bandit_state ?? [])[0] as FakeRow;
    expect(arm.beta).toBe(2); // failure → beta + 1
    expect(arm.alpha).toBe(1);
  });

  it("stamps posterior_updated_at and writes a posterior_updated event", async () => {
    const fake = seedSweep();
    await sweepNoReplyPosteriors(fake.client, { merchantId: MERCHANT, noReplySweepDays: 7 });
    const msg = (fake.tables.messages ?? [])[0] as FakeRow;
    expect(msg.posterior_updated_at).toBeTruthy();
    const evt = (fake.tables.message_events ?? [])[0] as FakeRow;
    expect(evt.event_type).toBe("posterior_updated");
    expect((evt.payload as { success: boolean }).success).toBe(false);
  });

  it("does not sweep an outbound younger than the sweep window", async () => {
    const fake = seedSweep({ sentAt: RECENT });
    const result = await sweepNoReplyPosteriors(fake.client, {
      merchantId: MERCHANT,
      noReplySweepDays: 7,
    });
    expect(result.sweptCount).toBe(0);
  });

  it("does not re-sweep an outbound whose posterior was already updated", async () => {
    const fake = seedSweep({ posteriorUpdatedAt: "2026-05-10T00:00:00.000Z" });
    const result = await sweepNoReplyPosteriors(fake.client, {
      merchantId: MERCHANT,
      noReplySweepDays: 7,
    });
    expect(result.sweptCount).toBe(0);
  });

  it("ignores a non-campaign outbound (arm_id null)", async () => {
    const fake = seedSweep({ armId: null });
    const result = await sweepNoReplyPosteriors(fake.client, {
      merchantId: MERCHANT,
      noReplySweepDays: 7,
    });
    expect(result.sweptCount).toBe(0);
  });

  it("is idempotent — a second run sweeps nothing", async () => {
    const fake = seedSweep();
    await sweepNoReplyPosteriors(fake.client, { merchantId: MERCHANT, noReplySweepDays: 7 });
    const second = await sweepNoReplyPosteriors(fake.client, {
      merchantId: MERCHANT,
      noReplySweepDays: 7,
    });
    expect(second.sweptCount).toBe(0);
  });

  it("rejects a non-UUID merchantId", async () => {
    const fake = seedSweep();
    await expect(
      sweepNoReplyPosteriors(fake.client, { merchantId: "nope", noReplySweepDays: 7 }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B — retryDegradedReplies
// ─────────────────────────────────────────────────────────────────────────────

function mockLlm(toolName: string, input: unknown | { throws: Error }): Anthropic {
  return {
    messages: {
      create: async () => {
        if (input && typeof input === "object" && "throws" in input) throw input.throws;
        return {
          content: [{ type: "tool_use", id: "tu", name: toolName, input }],
          usage: { input_tokens: 40, output_tokens: 20 },
        };
      },
    },
  } as unknown as Anthropic;
}

function fakeTwilio(): TwilioClient {
  return {
    sendSms: async () => ({ ok: true, twilioSid: "SM_retry", status: "queued", attempts: 1 }),
    recordOptOut: async () => {},
  };
}

const POSITIVE = { sentiment: "positive", intent: "engagement", confidence: 0.9 };
const REPLY = { body: "So glad you got back to us — here's the link, no rush." };

/** Seeds a conversation with a degraded inbound and (optionally) a reply after it. */
function seedDegraded(
  over: { phase?: string; alreadyReplied?: boolean; hasArm?: boolean } = {},
) {
  const phase = over.phase ?? "classify";
  const seed: Record<string, FakeRow[]> = {
    conversations: [
      { id: CONVERSATION, merchant_id: MERCHANT, customer_id: CUSTOMER, channel: "sms", message_count: 2 },
    ],
    customers: [{ merchant_id: MERCHANT, shopify_customer_gid: CUSTOMER, phone: "+15551234567" }],
    messages: [
      {
        id: PRIOR_OUTBOUND,
        merchant_id: MERCHANT,
        conversation_id: CONVERSATION,
        direction: "outbound",
        channel: "sms",
        body: "Hey — we miss you.",
        pii_redacted_body: "Hey — we miss you.",
        arm_id: over.hasArm === false ? null : ARM,
        campaign_id: PROPOSAL,
        sent_at: "2026-05-15T09:00:00.000Z",
        posterior_updated_at: null,
      },
      {
        id: INBOUND,
        merchant_id: MERCHANT,
        conversation_id: CONVERSATION,
        direction: "inbound",
        channel: "sms",
        body: "ooh tell me more",
        pii_redacted_body: "ooh tell me more",
        status: "received",
        sent_at: "2026-05-15T10:00:00.000Z",
      },
    ],
    message_events: [
      {
        merchant_id: MERCHANT,
        conversation_id: CONVERSATION,
        message_id: INBOUND,
        event_type: "degraded_mode",
        occurred_at: "2026-05-15T10:00:01.000Z",
        payload: { phase, reason: "timeout", elapsed_ms: 4001 },
      },
    ],
  };
  if (over.alreadyReplied) {
    seed.messages.push({
      id: "66666666-6666-4666-8666-666666666666",
      merchant_id: MERCHANT,
      conversation_id: CONVERSATION,
      direction: "outbound",
      channel: "sms",
      body: "already replied",
      pii_redacted_body: "already replied",
      sent_at: "2026-05-15T10:00:05.000Z",
    });
  }
  if (over.hasArm !== false) {
    seed.bandit_state = [
      { arm_id: ARM, merchant_id: MERCHANT, proposal_id: PROPOSAL, alpha: 1, beta: 1, observation_count: 0 },
    ];
  }
  return makeFakeSupabase(seed);
}

function deps(fake: ReturnType<typeof makeFakeSupabase>, classify: unknown, generate: unknown): HandleInboundDeps {
  return {
    serviceClient: fake.client,
    twilioClient: fakeTwilio(),
    classifyClient: mockLlm("classify_reply", classify),
    generateClient: mockLlm("generate_reply", generate),
  };
}

const retryOpts = { merchantId: MERCHANT, fromNumber: "+18888800461", outboundDailyCap: 200 };

describe("retryDegradedReplies", () => {
  it("re-classifies, generates, and sends a reply for a degraded inbound", async () => {
    const fake = seedDegraded();
    const result = await retryDegradedReplies(deps(fake, POSITIVE, REPLY), retryOpts);
    expect(result.retried).toBe(1);
    // A new outbound reply was sent.
    const outbounds = (fake.tables.messages ?? []).filter((m) => m.direction === "outbound");
    expect(outbounds.length).toBe(2); // prior campaign outbound + the retry reply
  });

  it("skips a degraded inbound that already has a reply", async () => {
    const fake = seedDegraded({ alreadyReplied: true });
    const result = await retryDegradedReplies(deps(fake, POSITIVE, REPLY), retryOpts);
    expect(result.retried).toBe(0);
  });

  it("fires the bandit posterior for a classify-phase degrade", async () => {
    const fake = seedDegraded({ phase: "classify" });
    await retryDegradedReplies(deps(fake, POSITIVE, REPLY), retryOpts);
    // positive + engagement → success → alpha + 1
    expect((fake.tables.bandit_state ?? [])[0]!.alpha).toBe(2);
  });

  it("does NOT fire the posterior for a generate-phase degrade (already fired)", async () => {
    const fake = seedDegraded({ phase: "generate" });
    await retryDegradedReplies(deps(fake, POSITIVE, REPLY), retryOpts);
    // posterior untouched — alpha/beta still at the prior
    expect((fake.tables.bandit_state ?? [])[0]!.alpha).toBe(1);
    expect((fake.tables.bandit_state ?? [])[0]!.beta).toBe(1);
  });

  it("records a Sonnet-classified opt-out instead of replying", async () => {
    const fake = seedDegraded();
    const result = await retryDegradedReplies(
      deps(fake, { sentiment: "negative", intent: "opt_out", confidence: 0.95 }, REPLY),
      retryOpts,
    );
    expect(result.optedOut).toBe(1);
    expect(result.retried).toBe(0);
    expect(fake.tables.customer_opt_outs).toHaveLength(1);
  });

  it("counts a re-classify failure as stillDegraded", async () => {
    const fake = seedDegraded();
    const result = await retryDegradedReplies(
      deps(fake, { throws: new Error("anthropic 500") }, REPLY),
      retryOpts,
    );
    expect(result.stillDegraded).toBe(1);
    expect(result.retried).toBe(0);
  });

  it("a second sweep does not re-retry an inbound that now has a reply", async () => {
    const fake = seedDegraded();
    const first = await retryDegradedReplies(deps(fake, POSITIVE, REPLY), retryOpts);
    expect(first.retried).toBe(1);
    const second = await retryDegradedReplies(deps(fake, POSITIVE, REPLY), retryOpts);
    expect(second.retried).toBe(0);
  });
});
