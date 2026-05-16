import { describe, expect, it } from "vitest";
import {
  appendMessageEvent,
  ensureConversation,
  recordConversationActivity,
  type AppendMessageEventInput,
} from "../src/message-events";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";
import type { LapsedSupabaseClient } from "@lapsed/db";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const CONVERSATION = "660e8400-e29b-41d4-a716-446655440111";
const MESSAGE = "770e8400-e29b-41d4-a716-446655440222";
const CUSTOMER = "gid://shopify/Customer/1";
const T = "2026-05-16T10:00:00.000Z";

// ─────────────────────────────────────────────────────────────────────────────
// appendMessageEvent
// ─────────────────────────────────────────────────────────────────────────────

describe("appendMessageEvent", () => {
  it("inserts a message_outbound_sent event with the parsed payload", async () => {
    const { client, tables } = makeFakeSupabase();
    await appendMessageEvent(client, {
      eventType: "message_outbound_sent",
      merchantId: MERCHANT,
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      occurredAt: T,
      payload: { twilio_sid: "SM_123" },
    });
    expect(tables.message_events).toHaveLength(1);
    expect(tables.message_events[0]).toMatchObject({
      merchant_id: MERCHANT,
      conversation_id: CONVERSATION,
      message_id: MESSAGE,
      event_type: "message_outbound_sent",
      payload: { twilio_sid: "SM_123" },
    });
  });

  it("allows a null message_id (queued fires before the messages row exists)", async () => {
    const { client, tables } = makeFakeSupabase();
    await appendMessageEvent(client, {
      eventType: "message_outbound_queued",
      merchantId: MERCHANT,
      conversationId: CONVERSATION,
      messageId: null,
      occurredAt: T,
      payload: { campaign_id: null, arm_id: null },
    });
    expect((tables.message_events[0] as FakeRow).message_id).toBeNull();
  });

  it("is idempotent — a duplicate (same dedup tuple) is a no-op", async () => {
    const { client, tables } = makeFakeSupabase();
    const ev: AppendMessageEventInput = {
      eventType: "reply_sent",
      merchantId: MERCHANT,
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      occurredAt: T,
      payload: { twilio_sid: "SM_dup" },
    };
    await appendMessageEvent(client, ev);
    await appendMessageEvent(client, ev);
    expect(tables.message_events).toHaveLength(1);
  });

  it("rejects an extra field in the payload (.strict)", async () => {
    const { client } = makeFakeSupabase();
    await expect(
      appendMessageEvent(client, {
        eventType: "message_outbound_sent",
        merchantId: MERCHANT,
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        occurredAt: T,
        payload: { twilio_sid: "SM", leaked_phone: "+15551234567" } as never,
      }),
    ).rejects.toThrow();
  });

  it("rejects an invalid sentiment in an inbound_classified payload", async () => {
    const { client } = makeFakeSupabase();
    await expect(
      appendMessageEvent(client, {
        eventType: "inbound_classified",
        merchantId: MERCHANT,
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        occurredAt: T,
        payload: {
          sentiment: "ecstatic" as never,
          intent: "purchase",
          confidence: 0.9,
          retries: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeFakeSupabase();
    await expect(
      appendMessageEvent(client, {
        eventType: "reply_sent",
        merchantId: "nope",
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        occurredAt: T,
        payload: { twilio_sid: "SM" },
      }),
    ).rejects.toThrow();
  });

  it("accepts a posterior_updated event", async () => {
    const { client, tables } = makeFakeSupabase();
    await appendMessageEvent(client, {
      eventType: "posterior_updated",
      merchantId: MERCHANT,
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      occurredAt: T,
      payload: { arm_id: "880e8400-e29b-41d4-a716-446655440333", success: true },
    });
    expect((tables.message_events[0] as FakeRow).event_type).toBe("posterior_updated");
  });

  it("accepts a degraded_mode event", async () => {
    const { client, tables } = makeFakeSupabase();
    await appendMessageEvent(client, {
      eventType: "degraded_mode",
      merchantId: MERCHANT,
      conversationId: CONVERSATION,
      messageId: MESSAGE,
      occurredAt: T,
      payload: { phase: "generate", reason: "timeout", elapsed_ms: 4001 },
    });
    expect((tables.message_events[0] as FakeRow).event_type).toBe("degraded_mode");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureConversation
// ─────────────────────────────────────────────────────────────────────────────

describe("ensureConversation", () => {
  it("creates a new conversation row when none exists", async () => {
    const { client, tables } = makeFakeSupabase();
    const { conversationId } = await ensureConversation(client, {
      merchantId: MERCHANT,
      customerId: CUSTOMER,
    });
    expect(conversationId).toBeTruthy();
    expect(tables.conversations).toHaveLength(1);
    expect(tables.conversations[0]).toMatchObject({
      merchant_id: MERCHANT,
      customer_id: CUSTOMER,
      channel: "sms",
    });
  });

  it("returns the existing conversation without creating a second (decision 16)", async () => {
    const { client, tables } = makeFakeSupabase({
      conversations: [
        { id: CONVERSATION, merchant_id: MERCHANT, customer_id: CUSTOMER, channel: "sms", message_count: 3 },
      ],
    });
    const { conversationId } = await ensureConversation(client, {
      merchantId: MERCHANT,
      customerId: CUSTOMER,
    });
    expect(conversationId).toBe(CONVERSATION);
    expect(tables.conversations).toHaveLength(1);
  });

  it("honors a custom channel (decision 3)", async () => {
    const { client, tables } = makeFakeSupabase();
    await ensureConversation(client, {
      merchantId: MERCHANT,
      customerId: CUSTOMER,
      channel: "voice",
    });
    expect((tables.conversations[0] as FakeRow).channel).toBe("voice");
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeFakeSupabase();
    await expect(
      ensureConversation(client, { merchantId: "nope", customerId: CUSTOMER }),
    ).rejects.toThrow();
  });

  it("resolves a concurrent-insert race via the 23505 unique-violation re-read", async () => {
    // Stub: the first existence read returns null (no row yet); the INSERT
    // loses a race and fails with a unique violation (23505); the re-read
    // then finds the row a concurrent caller inserted.
    let selectCalls = 0;
    const racedRow = { id: "raced-conversation-id" };
    const client = {
      from: (table: string) => {
        if (table !== "conversations") throw new Error(`unexpected table ${table}`);
        return {
          select: () => {
            const b: Record<string, unknown> = {};
            b.eq = () => b;
            b.maybeSingle = async () => {
              selectCalls += 1;
              return { data: selectCalls === 1 ? null : racedRow, error: null };
            };
            return b;
          },
          insert: () => ({
            select: () => ({
              maybeSingle: async () => ({ data: null, error: { code: "23505" } }),
            }),
          }),
        };
      },
    } as unknown as LapsedSupabaseClient;

    const { conversationId } = await ensureConversation(client, {
      merchantId: MERCHANT,
      customerId: CUSTOMER,
    });
    expect(conversationId).toBe("raced-conversation-id");
    expect(selectCalls).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordConversationActivity
// ─────────────────────────────────────────────────────────────────────────────

describe("recordConversationActivity", () => {
  function seeded() {
    return makeFakeSupabase({
      conversations: [
        {
          id: CONVERSATION,
          merchant_id: MERCHANT,
          customer_id: CUSTOMER,
          channel: "sms",
          message_count: 2,
          last_message_at: null,
          last_inbound_at: null,
        },
      ],
    });
  }

  it("advances last_message_at and increments message_count for an outbound", async () => {
    const { client, tables } = seeded();
    await recordConversationActivity(client, {
      merchantId: MERCHANT,
      customerId: CUSTOMER,
      occurredAt: T,
      direction: "outbound",
    });
    const row = tables.conversations[0] as FakeRow;
    expect(row.last_message_at).toBe(T);
    expect(row.message_count).toBe(3);
    expect(row.last_inbound_at).toBeNull();
  });

  it("also advances last_inbound_at for an inbound message", async () => {
    const { client, tables } = seeded();
    await recordConversationActivity(client, {
      merchantId: MERCHANT,
      customerId: CUSTOMER,
      occurredAt: T,
      direction: "inbound",
    });
    const row = tables.conversations[0] as FakeRow;
    expect(row.last_inbound_at).toBe(T);
    expect(row.last_message_at).toBe(T);
  });

  it("throws when no conversation exists for the merchant/customer", async () => {
    const { client } = makeFakeSupabase();
    await expect(
      recordConversationActivity(client, {
        merchantId: MERCHANT,
        customerId: CUSTOMER,
        occurredAt: T,
        direction: "outbound",
      }),
    ).rejects.toThrow(/no conversation/i);
  });
});
