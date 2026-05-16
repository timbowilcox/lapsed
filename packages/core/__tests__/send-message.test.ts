import { describe, expect, it } from "vitest";
import { sendMessage, type SendMessageInput } from "../src/send-message";
import type { TwilioClient, SendSmsResult } from "../src/twilio-client";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CUSTOMER = "gid://shopify/Customer/1";
const CAMPAIGN = "660e8400-e29b-41d4-a716-446655440111";
const ARM = "770e8400-e29b-41d4-a716-446655440222";
const PHONE = "+15551234567";
const FROM = "+18888800461";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

function fakeTwilio(
  sendResult: SendSmsResult = { ok: true, twilioSid: "SM_ok", status: "queued", attempts: 1 },
): { client: TwilioClient; sendCalls: unknown[] } {
  const sendCalls: unknown[] = [];
  const client: TwilioClient = {
    sendSms: async (input) => {
      sendCalls.push(input);
      return sendResult;
    },
    recordOptOut: async () => {},
  };
  return { client, sendCalls };
}

/** A fake DB seeded with one customer that has a phone. */
function seededDb(over: { customerPhone?: string | null; opted?: boolean; sentToday?: number } = {}) {
  const seed: Record<string, FakeRow[]> = {
    customers: [
      {
        merchant_id: MERCHANT,
        shopify_customer_gid: CUSTOMER,
        phone: over.customerPhone === undefined ? PHONE : over.customerPhone,
      },
    ],
  };
  if (over.opted) {
    seed.customer_opt_outs = [
      { merchant_id: MERCHANT, customer_id: CUSTOMER, phone_number: PHONE, source: "stop_keyword" },
    ];
  }
  if (over.sentToday && over.sentToday > 0) {
    seed.message_events = Array.from({ length: over.sentToday }, (_, i) => ({
      merchant_id: MERCHANT,
      conversation_id: "c",
      event_type: "message_outbound_sent",
      occurred_at: new Date().toISOString(),
      payload: { twilio_sid: `SM_${i}` },
    }));
  }
  return makeFakeSupabase(seed);
}

function input(over: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    merchantId: MERCHANT,
    customerId: CUSTOMER,
    body: "Hey — we miss you. Here's 15% off your next order.",
    fromNumber: FROM,
    campaignId: CAMPAIGN,
    armId: ARM,
    outboundDailyCap: 200,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("sendMessage — happy path", () => {
  it("sends, inserts the messages row, and returns ok", async () => {
    const { client, tables } = seededDb();
    const { client: twilio } = fakeTwilio();
    const result = await sendMessage(client, twilio, input());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.twilioSid).toBe("SM_ok");
      expect(result.conversationId).toBeTruthy();
    }
    expect(tables.messages).toHaveLength(1);
    const msg = tables.messages[0] as FakeRow;
    expect(msg).toMatchObject({
      merchant_id: MERCHANT,
      direction: "outbound",
      status: "sent",
      twilio_sid: "SM_ok",
      campaign_id: CAMPAIGN,
      arm_id: ARM,
    });
  });

  it("writes a queued event and a sent event", async () => {
    const { client, tables } = seededDb();
    const { client: twilio } = fakeTwilio();
    await sendMessage(client, twilio, input());
    const types = (tables.message_events ?? []).map((e) => e.event_type);
    expect(types).toContain("message_outbound_queued");
    expect(types).toContain("message_outbound_sent");
  });

  it("stores a PII-redacted copy of the body", async () => {
    const { client, tables } = seededDb();
    const { client: twilio } = fakeTwilio();
    await sendMessage(
      client,
      twilio,
      input({ body: "Reach Jane Smith — your code is ready." }),
    );
    const msg = tables.messages[0] as FakeRow;
    expect(msg.body).toContain("Jane Smith");
    expect(msg.pii_redacted_body).not.toContain("Jane Smith");
    expect(msg.pii_redacted_body).toContain("[name]");
  });

  it("advances the conversation activity counters", async () => {
    const { client, tables } = seededDb();
    const { client: twilio } = fakeTwilio();
    await sendMessage(client, twilio, input());
    const conv = tables.conversations[0] as FakeRow;
    expect(conv.message_count).toBe(1);
    expect(conv.last_message_at).toBeTruthy();
  });

  it("honors a custom channel (decision 3)", async () => {
    const { client, tables } = seededDb();
    const { client: twilio } = fakeTwilio();
    await sendMessage(client, twilio, input({ channel: "sms" }));
    expect((tables.messages[0] as FakeRow).channel).toBe("sms");
    expect((tables.conversations[0] as FakeRow).channel).toBe("sms");
  });

  it("passes campaign + arm + customer metadata to Twilio", async () => {
    const { client } = seededDb();
    const { client: twilio, sendCalls } = fakeTwilio();
    await sendMessage(client, twilio, input());
    expect(sendCalls[0]).toMatchObject({
      to: PHONE,
      from: FROM,
      metadata: { campaignId: CAMPAIGN, armId: ARM, customerId: CUSTOMER },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight skips
// ─────────────────────────────────────────────────────────────────────────────

describe("sendMessage — opt-out gate (decision 18)", () => {
  it("skips an opted-out customer without calling Twilio", async () => {
    const { client, tables } = seededDb({ opted: true });
    const { client: twilio, sendCalls } = fakeTwilio();
    const result = await sendMessage(client, twilio, input());
    expect(result).toMatchObject({ ok: false, reason: "opted_out" });
    expect(sendCalls).toHaveLength(0);
    expect(tables.messages ?? []).toHaveLength(0);
  });
});

describe("sendMessage — daily cap (cost discipline)", () => {
  it("skips with cap_reached when the merchant is at the daily cap", async () => {
    const { client } = seededDb({ sentToday: 5 });
    const { client: twilio, sendCalls } = fakeTwilio();
    const result = await sendMessage(client, twilio, input({ outboundDailyCap: 5 }));
    expect(result).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(sendCalls).toHaveLength(0);
  });

  it("treats a cap of 0 as a kill switch (always cap_reached)", async () => {
    const { client } = seededDb();
    const { client: twilio, sendCalls } = fakeTwilio();
    const result = await sendMessage(client, twilio, input({ outboundDailyCap: 0 }));
    expect(result).toMatchObject({ ok: false, reason: "cap_reached" });
    expect(sendCalls).toHaveLength(0);
  });

  it("sends when below the cap", async () => {
    const { client } = seededDb({ sentToday: 3 });
    const { client: twilio } = fakeTwilio();
    const result = await sendMessage(client, twilio, input({ outboundDailyCap: 5 }));
    expect(result.ok).toBe(true);
  });
});

describe("sendMessage — missing phone", () => {
  it("skips with no_phone when the customer has no phone number", async () => {
    const { client } = seededDb({ customerPhone: null });
    const { client: twilio, sendCalls } = fakeTwilio();
    const result = await sendMessage(client, twilio, input());
    expect(result).toMatchObject({ ok: false, reason: "no_phone" });
    expect(sendCalls).toHaveLength(0);
  });

  it("skips with no_phone when the phone is an empty string", async () => {
    const { client } = seededDb({ customerPhone: "   " });
    const { client: twilio } = fakeTwilio();
    const result = await sendMessage(client, twilio, input());
    expect(result).toMatchObject({ ok: false, reason: "no_phone" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — a campaign send is at-most-once per (campaign, customer)
// ─────────────────────────────────────────────────────────────────────────────

describe("sendMessage — campaign idempotency guard", () => {
  it("skips with already_sent when a campaign outbound already exists for the customer", async () => {
    const fake = makeFakeSupabase({
      customers: [{ merchant_id: MERCHANT, shopify_customer_gid: CUSTOMER, phone: PHONE }],
      conversations: [
        { id: "11111111-1111-4111-8111-111111111111", merchant_id: MERCHANT, customer_id: CUSTOMER, channel: "sms", message_count: 1 },
      ],
      messages: [
        {
          id: "prior-msg",
          conversation_id: "11111111-1111-4111-8111-111111111111",
          merchant_id: MERCHANT,
          campaign_id: CAMPAIGN,
          direction: "outbound",
          status: "sent",
        },
      ],
    });
    const { client: twilio, sendCalls } = fakeTwilio();
    const result = await sendMessage(fake.client, twilio, input());
    expect(result).toMatchObject({ ok: false, reason: "already_sent" });
    expect(sendCalls).toHaveLength(0);
    // No second messages row was inserted.
    expect(fake.tables.messages).toHaveLength(1);
  });

  it("still sends when a prior outbound belongs to a DIFFERENT campaign", async () => {
    const fake = makeFakeSupabase({
      customers: [{ merchant_id: MERCHANT, shopify_customer_gid: CUSTOMER, phone: PHONE }],
      conversations: [
        { id: "11111111-1111-4111-8111-111111111111", merchant_id: MERCHANT, customer_id: CUSTOMER, channel: "sms", message_count: 1 },
      ],
      messages: [
        {
          id: "other-campaign-msg",
          conversation_id: "11111111-1111-4111-8111-111111111111",
          merchant_id: MERCHANT,
          campaign_id: "990e8400-e29b-41d4-a716-446655440999",
          direction: "outbound",
          status: "sent",
        },
      ],
    });
    const { client: twilio } = fakeTwilio();
    const result = await sendMessage(fake.client, twilio, input());
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Twilio failure
// ─────────────────────────────────────────────────────────────────────────────

describe("sendMessage — Twilio failure", () => {
  it("returns twilio_failed and writes a failed event, no messages row", async () => {
    const { client, tables } = seededDb();
    const { client: twilio } = fakeTwilio({
      ok: false,
      errorCode: 21610,
      errorClass: "Error",
      detail: "opted out",
      attempts: 1,
    });
    const result = await sendMessage(client, twilio, input());
    expect(result).toMatchObject({ ok: false, reason: "twilio_failed" });
    expect(tables.messages ?? []).toHaveLength(0);
    const types = (tables.message_events ?? []).map((e) => e.event_type);
    expect(types).toContain("message_outbound_queued");
    expect(types).toContain("message_outbound_failed");
    expect(types).not.toContain("message_outbound_sent");
  });

  it("records the Twilio error code in the failed event", async () => {
    const { client, tables } = seededDb();
    const { client: twilio } = fakeTwilio({
      ok: false,
      errorCode: 30007,
      errorClass: "Error",
      detail: "carrier filtered",
      attempts: 3,
    });
    await sendMessage(client, twilio, input());
    const failed = (tables.message_events ?? []).find(
      (e) => e.event_type === "message_outbound_failed",
    ) as FakeRow;
    expect((failed.payload as { error_code: number }).error_code).toBe(30007);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation + determinism
// ─────────────────────────────────────────────────────────────────────────────

describe("sendMessage — input validation", () => {
  it("rejects a non-UUID merchantId", async () => {
    const { client } = seededDb();
    const { client: twilio } = fakeTwilio();
    await expect(
      sendMessage(client, twilio, input({ merchantId: "nope" })),
    ).rejects.toThrow();
  });

  it("rejects an empty body", async () => {
    const { client } = seededDb();
    const { client: twilio } = fakeTwilio();
    await expect(sendMessage(client, twilio, input({ body: "" }))).rejects.toThrow();
  });

  it("uses the injected clock for the daily-cap window", async () => {
    const { client } = seededDb({ sentToday: 1 });
    const { client: twilio } = fakeTwilio();
    const fixedNow = () => new Date("2026-05-16T12:00:00.000Z");
    const result = await sendMessage(client, twilio, input({ outboundDailyCap: 5 }), {
      now: fixedNow,
    });
    expect(result.ok).toBe(true);
  });

  it("throws (does not swallow) when the messages row insert fails after a successful send", async () => {
    const fake = makeFakeSupabase(
      { customers: [{ merchant_id: MERCHANT, shopify_customer_gid: CUSTOMER, phone: PHONE }] },
      { failOn: [{ table: "messages", op: "insert" }] },
    );
    const { client: twilio } = fakeTwilio();
    await expect(sendMessage(fake.client, twilio, input())).rejects.toBeTruthy();
    // The send happened but no message_outbound_sent event was written —
    // the campaign idempotency guard (messages row) will skip a re-run only
    // once the row exists, so the orphaned-send window is bounded + observable.
    const types = (fake.tables.message_events ?? []).map((e) => e.event_type);
    expect(types).toContain("message_outbound_queued");
    expect(types).not.toContain("message_outbound_sent");
  });
});
