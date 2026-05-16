import { describe, expect, it, vi } from "vitest";
import {
  detectOptOutKeyword,
  isOptedOut,
  assertNotOptedOut,
  recordOptOut,
  OptOutError,
  type RecordOptOutInput,
} from "../src/opt-out-registry";
import type { TwilioClient } from "../src/twilio-client";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const MERCHANT_B = "660e8400-e29b-41d4-a716-446655440111";
const CUSTOMER = "gid://shopify/Customer/1";
const PHONE = "+15551234567";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

function fakeTwilio(opts: { optOutThrows?: boolean } = {}): {
  client: TwilioClient;
  optOutCalls: string[];
} {
  const optOutCalls: string[] = [];
  const client: TwilioClient = {
    sendSms: async () => ({ ok: true, twilioSid: "SM_x", status: "queued", attempts: 1 }),
    recordOptOut: async (phone: string) => {
      optOutCalls.push(phone);
      if (opts.optOutThrows) throw new Error("twilio opt-out endpoint 500");
    },
  };
  return { client, optOutCalls };
}

function input(over: Partial<RecordOptOutInput> = {}): RecordOptOutInput {
  return {
    merchantId: MERCHANT,
    customerId: CUSTOMER,
    phoneNumber: PHONE,
    source: "stop_keyword",
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// detectOptOutKeyword
// ─────────────────────────────────────────────────────────────────────────────

describe("detectOptOutKeyword — keyword matches", () => {
  const keywords = ["STOP", "STOPALL", "UNSUBSCRIBE", "REMOVE", "CANCEL", "END", "QUIT"];
  for (const kw of keywords) {
    it(`matches the bare keyword "${kw}"`, () => {
      expect(detectOptOutKeyword(kw)).toBe(kw);
    });
    it(`matches the lower-case form of "${kw}"`, () => {
      expect(detectOptOutKeyword(kw.toLowerCase())).toBe(kw);
    });
    it(`matches "${kw}" with surrounding whitespace`, () => {
      expect(detectOptOutKeyword(`  ${kw}  `)).toBe(kw);
    });
    it(`matches "${kw}" with trailing punctuation`, () => {
      expect(detectOptOutKeyword(`${kw}!`)).toBe(kw);
    });
  }

  it("matches a mixed-case keyword", () => {
    expect(detectOptOutKeyword("StOp")).toBe("STOP");
  });

  it("matches a keyword surrounded by tabs and newlines", () => {
    expect(detectOptOutKeyword("\n\tstop\t\n")).toBe("STOP");
  });

  it("matches a keyword wrapped in punctuation on both sides", () => {
    expect(detectOptOutKeyword('"STOP."')).toBe("STOP");
  });

  it("matches a keyword with a trailing zero-width space", () => {
    expect(detectOptOutKeyword("STOP​")).toBe("STOP");
  });
});

describe("detectOptOutKeyword — non-matches", () => {
  it("returns null for an empty string", () => {
    expect(detectOptOutKeyword("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(detectOptOutKeyword("    ")).toBeNull();
  });

  it("returns null for a sentence containing 'stop'", () => {
    expect(detectOptOutKeyword("please stop sending me deals")).toBeNull();
  });

  it("returns null for 'stop' followed by other words", () => {
    expect(detectOptOutKeyword("stop now")).toBeNull();
  });

  it("returns null for a near-miss keyword", () => {
    expect(detectOptOutKeyword("STOPP")).toBeNull();
  });

  it("returns null for a normal positive reply", () => {
    expect(detectOptOutKeyword("yes please send me the discount")).toBeNull();
  });

  it("returns null for 'I want to stop' (intent, not a keyword)", () => {
    expect(detectOptOutKeyword("I want to stop")).toBeNull();
  });

  it("returns null for an unrelated single word", () => {
    expect(detectOptOutKeyword("hello")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isOptedOut
// ─────────────────────────────────────────────────────────────────────────────

describe("isOptedOut", () => {
  it("returns false when the customer has no opt-out row", async () => {
    const { client } = makeFakeSupabase();
    expect(await isOptedOut(client, MERCHANT, CUSTOMER)).toBe(false);
  });

  it("returns true when the customer has an opt-out row", async () => {
    const { client } = makeFakeSupabase({
      customer_opt_outs: [
        { merchant_id: MERCHANT, customer_id: CUSTOMER, phone_number: PHONE, source: "stop_keyword" },
      ],
    });
    expect(await isOptedOut(client, MERCHANT, CUSTOMER)).toBe(true);
  });

  it("does not leak another merchant's opt-out (tenancy)", async () => {
    const { client } = makeFakeSupabase({
      customer_opt_outs: [
        { merchant_id: MERCHANT_B, customer_id: CUSTOMER, phone_number: PHONE, source: "stop_keyword" },
      ],
    });
    expect(await isOptedOut(client, MERCHANT, CUSTOMER)).toBe(false);
  });

  it("does not match a different customer of the same merchant", async () => {
    const { client } = makeFakeSupabase({
      customer_opt_outs: [
        {
          merchant_id: MERCHANT,
          customer_id: "gid://shopify/Customer/999",
          phone_number: PHONE,
          source: "stop_keyword",
        },
      ],
    });
    expect(await isOptedOut(client, MERCHANT, CUSTOMER)).toBe(false);
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeFakeSupabase();
    await expect(isOptedOut(client, "not-a-uuid", CUSTOMER)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertNotOptedOut
// ─────────────────────────────────────────────────────────────────────────────

describe("assertNotOptedOut", () => {
  it("resolves when the customer has not opted out", async () => {
    const { client } = makeFakeSupabase();
    await expect(assertNotOptedOut(client, MERCHANT, CUSTOMER)).resolves.toBeUndefined();
  });

  it("throws OptOutError when the customer has opted out", async () => {
    const { client } = makeFakeSupabase({
      customer_opt_outs: [
        { merchant_id: MERCHANT, customer_id: CUSTOMER, phone_number: PHONE, source: "stop_keyword" },
      ],
    });
    await expect(assertNotOptedOut(client, MERCHANT, CUSTOMER)).rejects.toBeInstanceOf(OptOutError);
  });

  it("the thrown OptOutError carries merchantId and customerId", async () => {
    const { client } = makeFakeSupabase({
      customer_opt_outs: [
        { merchant_id: MERCHANT, customer_id: CUSTOMER, phone_number: PHONE, source: "merchant_manual" },
      ],
    });
    await expect(assertNotOptedOut(client, MERCHANT, CUSTOMER)).rejects.toMatchObject({
      name: "OptOutError",
      merchantId: MERCHANT,
      customerId: CUSTOMER,
    });
  });

  it("does not throw for a customer opted out under a different merchant", async () => {
    const { client } = makeFakeSupabase({
      customer_opt_outs: [
        { merchant_id: MERCHANT_B, customer_id: CUSTOMER, phone_number: PHONE, source: "stop_keyword" },
      ],
    });
    await expect(assertNotOptedOut(client, MERCHANT, CUSTOMER)).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordOptOut
// ─────────────────────────────────────────────────────────────────────────────

describe("recordOptOut — happy path", () => {
  it("writes a customer_opt_outs row with the supplied fields", async () => {
    const { client, tables } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    await recordOptOut(client, twilio, input({ source: "stop_keyword" }));
    expect(tables.customer_opt_outs).toHaveLength(1);
    const row = tables.customer_opt_outs[0]!;
    expect(row).toMatchObject({
      merchant_id: MERCHANT,
      customer_id: CUSTOMER,
      phone_number: PHONE,
      source: "stop_keyword",
      inbound_message_id: null,
    });
  });

  it("calls the Twilio opt-out leg with the phone number", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio, optOutCalls } = fakeTwilio();
    await recordOptOut(client, twilio, input());
    expect(optOutCalls).toEqual([PHONE]);
  });

  it("returns recorded:true, alreadyOptedOut:false, twilioRecorded:true", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    const result = await recordOptOut(client, twilio, input());
    expect(result).toEqual({ recorded: true, alreadyOptedOut: false, twilioRecorded: true });
  });

  it("stores inbound_message_id when provided", async () => {
    const { client, tables } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    const msgId = "770e8400-e29b-41d4-a716-446655440222";
    await recordOptOut(client, twilio, input({ inboundMessageId: msgId }));
    expect((tables.customer_opt_outs[0] as FakeRow).inbound_message_id).toBe(msgId);
  });

  it("makes the customer test as opted-out afterwards", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    await recordOptOut(client, twilio, input());
    expect(await isOptedOut(client, MERCHANT, CUSTOMER)).toBe(true);
    await expect(assertNotOptedOut(client, MERCHANT, CUSTOMER)).rejects.toBeInstanceOf(OptOutError);
  });
});

describe("recordOptOut — every source enum value", () => {
  for (const source of ["stop_keyword", "sonnet_classified", "merchant_manual", "twilio_native"] as const) {
    it(`accepts source "${source}"`, async () => {
      const { client, tables } = makeFakeSupabase();
      const { client: twilio } = fakeTwilio();
      const result = await recordOptOut(client, twilio, input({ source }));
      expect(result.recorded).toBe(true);
      expect((tables.customer_opt_outs[0] as FakeRow).source).toBe(source);
    });
  }
});

describe("recordOptOut — idempotency (decision 18, append-only)", () => {
  it("a second recordOptOut is a no-op that returns alreadyOptedOut:true", async () => {
    const { client, tables } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    await recordOptOut(client, twilio, input());
    const second = await recordOptOut(client, twilio, input({ source: "sonnet_classified" }));
    expect(second).toEqual({ recorded: false, alreadyOptedOut: true, twilioRecorded: false });
    // No second row appended.
    expect(tables.customer_opt_outs).toHaveLength(1);
  });

  it("does not re-call Twilio on an idempotent no-op", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio, optOutCalls } = fakeTwilio();
    await recordOptOut(client, twilio, input());
    await recordOptOut(client, twilio, input());
    expect(optOutCalls).toHaveLength(1);
  });

  it("a pre-existing opt-out row makes the first call a no-op", async () => {
    const { client, tables } = makeFakeSupabase({
      customer_opt_outs: [
        { merchant_id: MERCHANT, customer_id: CUSTOMER, phone_number: PHONE, source: "twilio_native" },
      ],
    });
    const { client: twilio } = fakeTwilio();
    const result = await recordOptOut(client, twilio, input());
    expect(result.alreadyOptedOut).toBe(true);
    expect(tables.customer_opt_outs).toHaveLength(1);
  });
});

describe("recordOptOut — failure handling", () => {
  it("does NOT throw when the Twilio leg fails — opt-out is still honored by the table", async () => {
    const { client, tables } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio({ optOutThrows: true });
    const result = await recordOptOut(client, twilio, input());
    expect(result).toEqual({ recorded: true, alreadyOptedOut: false, twilioRecorded: false });
    // The customer_opt_outs row was still written — our table is the gate.
    expect(tables.customer_opt_outs).toHaveLength(1);
    expect(await isOptedOut(client, MERCHANT, CUSTOMER)).toBe(true);
  });

  it("throws when the customer_opt_outs table write fails", async () => {
    const { client } = makeFakeSupabase({}, { failOn: [{ table: "customer_opt_outs", op: "insert" }] });
    const { client: twilio } = fakeTwilio();
    await expect(recordOptOut(client, twilio, input())).rejects.toBeTruthy();
  });

  it("does not call Twilio when the table write fails", async () => {
    const { client } = makeFakeSupabase({}, { failOn: [{ table: "customer_opt_outs", op: "insert" }] });
    const { client: twilio, optOutCalls } = fakeTwilio();
    await expect(recordOptOut(client, twilio, input())).rejects.toBeTruthy();
    expect(optOutCalls).toHaveLength(0);
  });

  it("the twilio-leg-failure log masks the phone and never contains it raw", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { client } = makeFakeSupabase();
      const { client: twilio } = fakeTwilio({ optOutThrows: true });
      await recordOptOut(client, twilio, input());
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("opt_out_twilio_leg_failed");
      expect(logged).toContain("***4567");
      expect(logged).not.toContain(PHONE);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("isOptedOut — fails closed on a DB read error", () => {
  it("propagates a customer_opt_outs select error rather than returning false", async () => {
    const { client } = makeFakeSupabase({}, { failOn: [{ table: "customer_opt_outs", op: "select" }] });
    await expect(isOptedOut(client, MERCHANT, CUSTOMER)).rejects.toBeTruthy();
  });

  it("assertNotOptedOut surfaces a read error instead of allowing the send", async () => {
    const { client } = makeFakeSupabase({}, { failOn: [{ table: "customer_opt_outs", op: "select" }] });
    await expect(assertNotOptedOut(client, MERCHANT, CUSTOMER)).rejects.toBeTruthy();
  });
});

describe("recordOptOut — input validation", () => {
  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    await expect(recordOptOut(client, twilio, input({ merchantId: "nope" }))).rejects.toThrow();
  });

  it("rejects an empty customerId", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    await expect(recordOptOut(client, twilio, input({ customerId: "" }))).rejects.toThrow();
  });

  it("rejects an empty phoneNumber", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    await expect(recordOptOut(client, twilio, input({ phoneNumber: "" }))).rejects.toThrow();
  });

  it("rejects an invalid source", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    await expect(
      recordOptOut(client, twilio, input({ source: "made_up" as unknown as RecordOptOutInput["source"] })),
    ).rejects.toThrow();
  });

  it("rejects a non-UUID inboundMessageId", async () => {
    const { client } = makeFakeSupabase();
    const { client: twilio } = fakeTwilio();
    await expect(
      recordOptOut(client, twilio, input({ inboundMessageId: "not-a-uuid" })),
    ).rejects.toThrow();
  });
});
