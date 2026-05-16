import { describe, expect, it } from "vitest";
import {
  handleInboundMessage,
  OPT_OUT_ACK,
  DEGRADED_FALLBACK_REPLY,
  type HandleInboundDeps,
} from "../src/handle-inbound";
import type { TwilioClient } from "../src/twilio-client";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";
import type Anthropic from "@anthropic-ai/sdk";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CUSTOMER = "gid://shopify/Customer/1";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ARM = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "33333333-3333-4333-8333-333333333333";
const VOICE_VERSION = "44444444-4444-4444-8444-444444444444";
const PHONE = "+15551234567";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

const VALID_VOICE = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "short",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: [],
  signature_phrases: ["small batch"],
  sample_sentences: ["a", "b", "c", "d", "e"],
};

/** Mock Anthropic client that returns a single tool_use response, or throws. */
function mockLlm(toolName: string, input: unknown | { throws: Error } | { hang: true }): Anthropic {
  return {
    messages: {
      create: async () => {
        if (input && typeof input === "object" && "throws" in input) throw input.throws;
        if (input && typeof input === "object" && "hang" in input) {
          return new Promise(() => {}) as never;
        }
        return {
          content: [{ type: "tool_use", id: "tu", name: toolName, input }],
          usage: { input_tokens: 50, output_tokens: 20 },
        };
      },
    },
  } as unknown as Anthropic;
}

function fakeTwilio(): TwilioClient {
  return {
    sendSms: async () => ({ ok: true, twilioSid: "SM", status: "queued", attempts: 1 }),
    recordOptOut: async () => {},
  };
}

/** A fake DB seeded with a customer, an active voice profile, one prior
 *  campaign outbound (with an arm) and that arm's bandit_state row. */
function seededWorld(over: { withArm?: boolean; conversation?: boolean; voice?: boolean } = {}) {
  const withArm = over.withArm ?? true;
  const seed: Record<string, FakeRow[]> = {
    customers: [
      {
        merchant_id: MERCHANT,
        shopify_customer_gid: CUSTOMER,
        phone: PHONE,
        last_order_at: "2026-01-10T00:00:00.000Z",
      },
    ],
    customer_inferred_state: [
      {
        merchant_id: MERCHANT,
        shopify_customer_gid: CUSTOMER,
        lifecycle_stage: "lapsed",
        propensity_90d: 0.6,
      },
    ],
  };
  if (over.voice !== false) {
    seed.agent_profiles = [{ merchant_id: MERCHANT, active_voice_version_id: VOICE_VERSION }];
    seed.voice_versions = [
      {
        id: VOICE_VERSION,
        merchant_id: MERCHANT,
        version_number: 1,
        profile: VALID_VOICE,
        model_version: "claude-sonnet-4-6-test",
        extracted_at: "2026-02-01T00:00:00.000Z",
      },
    ];
  }
  if (over.conversation !== false) {
    seed.conversations = [
      {
        id: CONVERSATION,
        merchant_id: MERCHANT,
        customer_id: CUSTOMER,
        channel: "sms",
        message_count: 1,
        last_message_at: "2026-05-15T00:00:00.000Z",
      },
    ];
    seed.messages = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        merchant_id: MERCHANT,
        conversation_id: CONVERSATION,
        direction: "outbound",
        channel: "sms",
        body: "Hey — we miss you. 15% off if you'd like it.",
        pii_redacted_body: "Hey — we miss you. 15% off if you'd like it.",
        campaign_id: PROPOSAL,
        arm_id: withArm ? ARM : null,
        status: "sent",
        sent_at: "2026-05-15T00:00:00.000Z",
        posterior_updated_at: null,
      },
    ];
  }
  if (withArm) {
    seed.bandit_state = [
      { arm_id: ARM, merchant_id: MERCHANT, proposal_id: PROPOSAL, alpha: 1, beta: 1, observation_count: 0 },
    ];
  }
  return makeFakeSupabase(seed);
}

function deps(
  fake: ReturnType<typeof makeFakeSupabase>,
  classify: unknown,
  generate: unknown,
): HandleInboundDeps {
  return {
    serviceClient: fake.client,
    twilioClient: fakeTwilio(),
    classifyClient: mockLlm("classify_reply", classify),
    generateClient: mockLlm("generate_reply", generate),
  };
}

const POSITIVE = { sentiment: "positive", intent: "engagement", confidence: 0.9 };
const REPLY = { body: "So glad you asked — here's your 15% link, no rush at all." };

function inbound(over: Partial<Parameters<typeof handleInboundMessage>[1]> = {}) {
  return {
    fromNumber: PHONE,
    toNumber: "+18888800461",
    body: "ooh tell me more",
    twilioSid: "SM_inbound_1",
    latencyBudgetMs: 5000,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("handleInboundMessage — happy path", () => {
  it("classifies, generates a reply, and returns outcome replied", async () => {
    const fake = seededWorld();
    const result = await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    expect(result.outcome).toBe("replied");
    expect(result.replyBody).toBe(REPLY.body);
  });

  it("records the inbound message and an inbound_received event", async () => {
    const fake = seededWorld();
    await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    const inboundMsg = (fake.tables.messages ?? []).find((m) => m.direction === "inbound");
    expect(inboundMsg).toBeTruthy();
    const types = (fake.tables.message_events ?? []).map((e) => e.event_type);
    expect(types).toContain("message_inbound_received");
    expect(types).toContain("inbound_classified");
    expect(types).toContain("reply_generated");
    expect(types).toContain("reply_sent");
  });

  it("stores a PII-redacted copy of the inbound body", async () => {
    const fake = seededWorld();
    await handleInboundMessage(
      deps(fake, POSITIVE, REPLY),
      inbound({ body: "reach me at jane@example.com" }),
    );
    const inboundMsg = (fake.tables.messages ?? []).find(
      (m) => m.direction === "inbound",
    ) as FakeRow;
    expect(inboundMsg.body).toContain("jane@example.com");
    expect(inboundMsg.pii_redacted_body).not.toContain("jane@example.com");
    expect(inboundMsg.pii_redacted_body).toContain("[email]");
  });

  it("materializes sentiment + intent onto the inbound message row", async () => {
    const fake = seededWorld();
    await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    const inboundMsg = (fake.tables.messages ?? []).find(
      (m) => m.direction === "inbound",
    ) as FakeRow;
    expect(inboundMsg.sentiment).toBe("positive");
    expect(inboundMsg.intent).toBe("engagement");
  });

  it("records per-step elapsed_ms timings", async () => {
    const fake = seededWorld();
    const result = await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    expect(result.timings.resolved).toBeGreaterThanOrEqual(0);
    expect(result.timings.classified).toBeGreaterThanOrEqual(0);
    expect(result.timings.generated).toBeGreaterThanOrEqual(0);
    expect(result.timings.done).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bandit posterior update (decision 19)
// ─────────────────────────────────────────────────────────────────────────────

describe("handleInboundMessage — bandit posterior (decision 19)", () => {
  it("a positive engagement reply increments the arm's alpha (success)", async () => {
    const fake = seededWorld();
    await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    const arm = (fake.tables.bandit_state ?? [])[0] as FakeRow;
    expect(arm.alpha).toBe(2); // success → alpha + 1
    expect(arm.beta).toBe(1);
  });

  it("a positive purchase-intent reply also counts as success", async () => {
    const fake = seededWorld();
    await handleInboundMessage(
      deps(fake, { sentiment: "positive", intent: "purchase", confidence: 0.9 }, REPLY),
      inbound(),
    );
    expect((fake.tables.bandit_state ?? [])[0]!.alpha).toBe(2);
  });

  it("a negative reply increments beta (failure)", async () => {
    const fake = seededWorld();
    await handleInboundMessage(
      deps(fake, { sentiment: "negative", intent: "complaint", confidence: 0.9 }, REPLY),
      inbound(),
    );
    const arm = (fake.tables.bandit_state ?? [])[0] as FakeRow;
    expect(arm.alpha).toBe(1);
    expect(arm.beta).toBe(2);
  });

  it("a neutral reply counts as failure (not positive+engagement/purchase)", async () => {
    const fake = seededWorld();
    await handleInboundMessage(
      deps(fake, { sentiment: "neutral", intent: "question", confidence: 0.8 }, REPLY),
      inbound(),
    );
    expect((fake.tables.bandit_state ?? [])[0]!.beta).toBe(2);
  });

  it("a positive-but-question reply counts as failure (intent not engagement/purchase)", async () => {
    const fake = seededWorld();
    await handleInboundMessage(
      deps(fake, { sentiment: "positive", intent: "question", confidence: 0.8 }, REPLY),
      inbound(),
    );
    expect((fake.tables.bandit_state ?? [])[0]!.beta).toBe(2);
  });

  it("stamps posterior_updated_at on the outbound the posterior was routed to", async () => {
    const fake = seededWorld();
    await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    const prior = (fake.tables.messages ?? []).find((m) => m.id === "55555555-5555-4555-8555-555555555555") as FakeRow;
    expect(prior.posterior_updated_at).toBeTruthy();
  });

  it("writes a posterior_updated event", async () => {
    const fake = seededWorld();
    await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    const types = (fake.tables.message_events ?? []).map((e) => e.event_type);
    expect(types).toContain("posterior_updated");
  });

  it("skips the posterior update when the most recent outbound has no arm", async () => {
    const fake = seededWorld({ withArm: false });
    const result = await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    // Still replies; just no posterior to route to.
    expect(result.outcome).toBe("replied");
    expect(fake.tables.bandit_state ?? []).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Opt-out paths (decision 18)
// ─────────────────────────────────────────────────────────────────────────────

describe("handleInboundMessage — opt-out", () => {
  it("STOP keyword short-circuits before any LLM call", async () => {
    const fake = seededWorld();
    // classify client throws — proves it is never invoked on the STOP path.
    const d = deps(fake, { throws: new Error("classify must not run") }, REPLY);
    const result = await handleInboundMessage(d, inbound({ body: "STOP" }));
    expect(result.outcome).toBe("opted_out");
    expect(result.replyBody).toBe(OPT_OUT_ACK);
    expect(fake.tables.customer_opt_outs).toHaveLength(1);
    expect((fake.tables.customer_opt_outs[0] as FakeRow).source).toBe("stop_keyword");
  });

  it("a high-confidence Sonnet opt_out intent records a sonnet_classified opt-out", async () => {
    const fake = seededWorld();
    const result = await handleInboundMessage(
      deps(fake, { sentiment: "negative", intent: "opt_out", confidence: 0.95 }, REPLY),
      inbound({ body: "please leave me alone" }),
    );
    expect(result.outcome).toBe("opted_out");
    expect((fake.tables.customer_opt_outs[0] as FakeRow).source).toBe("sonnet_classified");
  });

  it("a LOW-confidence opt_out intent does NOT opt the customer out", async () => {
    const fake = seededWorld();
    const result = await handleInboundMessage(
      deps(fake, { sentiment: "neutral", intent: "opt_out", confidence: 0.55 }, REPLY),
      inbound(),
    );
    expect(result.outcome).toBe("replied");
    expect(fake.tables.customer_opt_outs ?? []).toHaveLength(0);
  });

  it("writes an opt_out_recorded event with the matched keyword", async () => {
    const fake = seededWorld();
    await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound({ body: "unsubscribe" }));
    const optEvent = (fake.tables.message_events ?? []).find(
      (e) => e.event_type === "opt_out_recorded",
    ) as FakeRow;
    expect((optEvent.payload as { matched_keyword: string }).matched_keyword).toBe("UNSUBSCRIBE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Degraded mode (decision 17)
// ─────────────────────────────────────────────────────────────────────────────

describe("handleInboundMessage — degraded mode (decision 17)", () => {
  it("returns the fallback reply when the classify step exceeds the budget", async () => {
    const fake = seededWorld();
    // A tiny budget drives the classify step straight past its soft deadline.
    const result = await handleInboundMessage(
      deps(fake, POSITIVE, REPLY),
      inbound({ latencyBudgetMs: 20 }),
    );
    expect(result.outcome).toBe("degraded");
    expect(result.replyBody).toBe(DEGRADED_FALLBACK_REPLY);
    const types = (fake.tables.message_events ?? []).map((e) => e.event_type);
    expect(types).toContain("degraded_mode");
  });

  it("returns the fallback reply when the generate step fails", async () => {
    const fake = seededWorld();
    const result = await handleInboundMessage(
      deps(fake, POSITIVE, { throws: new Error("anthropic 500") }),
      inbound(),
    );
    expect(result.outcome).toBe("degraded");
    expect(result.replyBody).toBe(DEGRADED_FALLBACK_REPLY);
    const degraded = (fake.tables.message_events ?? []).find(
      (e) => e.event_type === "degraded_mode",
    ) as FakeRow;
    expect((degraded.payload as { phase: string }).phase).toBe("generate");
  });

  it("still fires the bandit posterior update before a generate-phase degrade", async () => {
    const fake = seededWorld();
    await handleInboundMessage(
      deps(fake, POSITIVE, { throws: new Error("anthropic 500") }),
      inbound(),
    );
    // classification succeeded → posterior was updated even though generation degraded
    expect((fake.tables.bandit_state ?? [])[0]!.alpha).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolution edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("handleInboundMessage — resolution + edge cases", () => {
  it("returns outcome unresolved when no customer matches the From-number", async () => {
    const fake = makeFakeSupabase({});
    const result = await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    expect(result.outcome).toBe("unresolved");
    expect(result.replyBody).toBe("");
  });

  it("returns outcome empty_body for a blank inbound", async () => {
    const fake = seededWorld();
    const result = await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound({ body: "   " }));
    expect(result.outcome).toBe("empty_body");
  });

  it("creates the conversation when none exists yet", async () => {
    const fake = seededWorld({ conversation: false, withArm: false });
    const result = await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    expect(result.outcome).toBe("replied");
    expect(fake.tables.conversations).toHaveLength(1);
  });

  it("falls back to the default voice profile when the merchant has no active voice", async () => {
    const fake = seededWorld({ voice: false, withArm: false });
    const result = await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    expect(result.outcome).toBe("replied");
  });

  it("resolves the most recently active merchant when a phone matches multiple", async () => {
    const MERCHANT_B = "660e8400-e29b-41d4-a716-446655440aaa";
    const fake = makeFakeSupabase({
      customers: [
        { merchant_id: MERCHANT, shopify_customer_gid: CUSTOMER, phone: PHONE },
        { merchant_id: MERCHANT_B, shopify_customer_gid: CUSTOMER, phone: PHONE },
      ],
      conversations: [
        {
          id: CONVERSATION,
          merchant_id: MERCHANT,
          customer_id: CUSTOMER,
          channel: "sms",
          message_count: 1,
          last_message_at: "2026-04-01T00:00:00.000Z",
        },
        {
          id: "77777777-7777-4777-8777-777777777777",
          merchant_id: MERCHANT_B,
          customer_id: CUSTOMER,
          channel: "sms",
          message_count: 1,
          last_message_at: "2026-05-15T00:00:00.000Z",
        },
      ],
      customer_inferred_state: [
        { merchant_id: MERCHANT_B, shopify_customer_gid: CUSTOMER, lifecycle_stage: "lapsed", propensity_90d: 0.5 },
      ],
    });
    const result = await handleInboundMessage(deps(fake, POSITIVE, REPLY), inbound());
    expect(result.outcome).toBe("replied");
    // The newer-activity merchant (B) won — the inbound is recorded under B.
    const inboundMsg = (fake.tables.messages ?? []).find((m) => m.direction === "inbound");
    expect(inboundMsg?.merchant_id).toBe(MERCHANT_B);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook-retry idempotency (decision 19 integrity)
// ─────────────────────────────────────────────────────────────────────────────

describe("handleInboundMessage — webhook-retry idempotency", () => {
  it("a duplicate MessageSid returns the prior reply without re-processing", async () => {
    const fake = makeFakeSupabase({
      customers: [{ merchant_id: MERCHANT, shopify_customer_gid: CUSTOMER, phone: PHONE }],
      conversations: [
        { id: CONVERSATION, merchant_id: MERCHANT, customer_id: CUSTOMER, channel: "sms", message_count: 3 },
      ],
      messages: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          merchant_id: MERCHANT,
          conversation_id: CONVERSATION,
          direction: "inbound",
          channel: "sms",
          body: "ooh tell me more",
          pii_redacted_body: "ooh tell me more",
          twilio_sid: "SM_inbound_1",
          status: "received",
          sent_at: "2026-05-16T09:00:00.000Z",
        },
        {
          id: "99999999-9999-4999-8999-999999999999",
          merchant_id: MERCHANT,
          conversation_id: CONVERSATION,
          direction: "outbound",
          channel: "sms",
          body: "Here is the prior reply.",
          pii_redacted_body: "Here is the prior reply.",
          status: "sent",
          sent_at: "2026-05-16T09:00:01.000Z",
        },
      ],
    });
    // classify client throws — proves the orchestrator never re-classifies.
    const d = deps(fake, { throws: new Error("must not re-classify") }, REPLY);
    const result = await handleInboundMessage(d, inbound({ twilioSid: "SM_inbound_1" }));
    expect(result.outcome).toBe("duplicate");
    expect(result.replyBody).toBe("Here is the prior reply.");
    // No second inbound row was inserted.
    const inbounds = (fake.tables.messages ?? []).filter((m) => m.direction === "inbound");
    expect(inbounds).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Genuine latency-budget timeouts (decision 17) — withDeadline real-timer race
// ─────────────────────────────────────────────────────────────────────────────

describe("handleInboundMessage — genuine timeouts", () => {
  it("degrades when the classify call hangs past the soft deadline", async () => {
    const fake = seededWorld();
    // A ~50ms soft budget + a hanging classify client exercises the real
    // withDeadline setTimeout race (not the ms<=0 early return).
    const result = await handleInboundMessage(
      deps(fake, { hang: true }, REPLY),
      inbound({ latencyBudgetMs: 1050 }),
    );
    expect(result.outcome).toBe("degraded");
    expect(result.replyBody).toBe(DEGRADED_FALLBACK_REPLY);
    const degraded = (fake.tables.message_events ?? []).find(
      (e) => e.event_type === "degraded_mode",
    ) as FakeRow;
    expect((degraded.payload as { phase: string }).phase).toBe("classify");
  });

  it("degrades when the generate call hangs past the soft deadline", async () => {
    const fake = seededWorld();
    const result = await handleInboundMessage(
      deps(fake, POSITIVE, { hang: true }),
      inbound({ latencyBudgetMs: 1050 }),
    );
    expect(result.outcome).toBe("degraded");
    const degraded = (fake.tables.message_events ?? []).find(
      (e) => e.event_type === "degraded_mode",
    ) as FakeRow;
    expect((degraded.payload as { phase: string }).phase).toBe("generate");
  });
});
