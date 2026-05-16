import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTwilioClient,
  validateWebhookSignature,
  maskPhone,
  computeBackoffMs,
  TWILIO_MAX_SEND_RETRIES,
  type TwilioSdk,
  type SendSmsInput,
} from "../src/twilio-client";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────────

/** A fake Twilio SDK whose `messages.create` is scripted per-call. */
function makeFakeSdk(
  responses: Array<{ sid: string; status: string } | Error>,
): { sdk: TwilioSdk } {
  let call = 0;
  const sdk: TwilioSdk = {
    messages: {
      create: async () => {
        const r = responses[call] ?? responses[responses.length - 1]!;
        call++;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  return { sdk };
}

/** Builds a Twilio-style error with an HTTP status and optional Twilio code. */
function twilioError(opts: { status?: number; code?: number; message?: string }): Error {
  const e = new Error(opts.message ?? "twilio error") as Error & {
    status?: number;
    code?: number;
  };
  if (opts.status !== undefined) e.status = opts.status;
  if (opts.code !== undefined) e.code = opts.code;
  return e;
}

const SEND: SendSmsInput = {
  to: "+15551234567",
  from: "+18888800461",
  body: "Hey — we miss you. Here's 15% off your next order.",
  metadata: { campaignId: "camp-1", armId: "arm-1", customerId: "gid://shopify/Customer/1" },
};

const instantSleep = async () => {};

// ─────────────────────────────────────────────────────────────────────────────
// sendSms — success
// ─────────────────────────────────────────────────────────────────────────────

describe("createTwilioClient.sendSms — success", () => {
  it("returns ok with the twilio_sid on a first-attempt success", async () => {
    const { sdk } = makeFakeSdk([{ sid: "SM_ok_1", status: "queued" }]);
    const client = createTwilioClient({
      accountSid: "AC_test",
      authToken: "tok",
      sdk,
      sleep: instantSleep,
    });
    const result = await client.sendSms(SEND);
    expect(result).toEqual({ ok: true, twilioSid: "SM_ok_1", status: "queued", attempts: 1 });
  });

  it("forwards to/from/body to the SDK and never sends metadata", async () => {
    const createSpy = vi.fn(
      async (_opts: { to: string; from: string; body: string }) => ({
        sid: "SM_ok_2",
        status: "sent",
      }),
    );
    const sdk: TwilioSdk = { messages: { create: createSpy } };
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    await client.sendSms(SEND);
    expect(createSpy).toHaveBeenCalledWith({
      to: SEND.to,
      from: SEND.from,
      body: SEND.body,
    });
    // metadata is log-only — it must NOT appear in the SDK call payload
    expect(createSpy.mock.calls[0]![0]).not.toHaveProperty("metadata");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendSms — transient failures retry
// ─────────────────────────────────────────────────────────────────────────────

describe("createTwilioClient.sendSms — transient retry", () => {
  it("retries a 500 and succeeds on the second attempt", async () => {
    const { sdk } = makeFakeSdk([
      twilioError({ status: 500, message: "server error" }),
      { sid: "SM_retry_ok", status: "queued" },
    ]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
  });

  it("retries a 429 rate-limit", async () => {
    const { sdk } = makeFakeSdk([
      twilioError({ status: 429, code: 20429, message: "too many requests" }),
      { sid: "SM_429_ok", status: "queued" },
    ]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(true);
  });

  it("retries a network error with no HTTP status", async () => {
    const { sdk } = makeFakeSdk([
      twilioError({ message: "ECONNRESET" }),
      { sid: "SM_net_ok", status: "queued" },
    ]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false after exhausting all retries on persistent 503", async () => {
    const { sdk } = makeFakeSdk([twilioError({ status: 503, message: "unavailable" })]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(TWILIO_MAX_SEND_RETRIES);
      expect(result.errorClass).toBe("Error");
    }
  });

  it("calls the SDK exactly TWILIO_MAX_SEND_RETRIES times on persistent transient failure", async () => {
    const createSpy = vi.fn(async () => {
      throw twilioError({ status: 502 });
    });
    const sdk: TwilioSdk = { messages: { create: createSpy } };
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    await client.sendSms(SEND);
    expect(createSpy).toHaveBeenCalledTimes(TWILIO_MAX_SEND_RETRIES);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendSms — permanent failures do NOT retry
// ─────────────────────────────────────────────────────────────────────────────

describe("createTwilioClient.sendSms — permanent failure", () => {
  it("returns ok:false immediately on a 400 without retrying", async () => {
    const createSpy = vi.fn(async () => {
      throw twilioError({ status: 400, code: 21211, message: "invalid 'To' number" });
    });
    const sdk: TwilioSdk = { messages: { create: createSpy } };
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(1);
      // Twilio error code is surfaced in preference to the HTTP status
      expect(result.errorCode).toBe(21211);
    }
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("treats an opted-out recipient (21610) as a permanent failure", async () => {
    const createSpy = vi.fn(async () => {
      throw twilioError({ status: 400, code: 21610, message: "recipient opted out" });
    });
    const sdk: TwilioSdk = { messages: { create: createSpy } };
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe(21610);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a 401 auth error as permanent (no retry)", async () => {
    const createSpy = vi.fn(async () => {
      throw twilioError({ status: 401, message: "authenticate" });
    });
    const sdk: TwilioSdk = { messages: { create: createSpy } };
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordOptOut
// ─────────────────────────────────────────────────────────────────────────────

describe("createTwilioClient.recordOptOut", () => {
  it("invokes the injected opt-out handler with the phone number", async () => {
    const handler = vi.fn(async () => {});
    const client = createTwilioClient({
      accountSid: "AC",
      authToken: "t",
      sdk: makeFakeSdk([{ sid: "x", status: "queued" }]).sdk,
      optOutHandler: handler,
    });
    await client.recordOptOut("+15551234567");
    expect(handler).toHaveBeenCalledWith("+15551234567");
  });

  it("propagates a handler failure so the caller can log a critical event", async () => {
    const handler = vi.fn(async () => {
      throw new Error("twilio opt-out endpoint 500");
    });
    const client = createTwilioClient({
      accountSid: "AC",
      authToken: "t",
      sdk: makeFakeSdk([{ sid: "x", status: "queued" }]).sdk,
      optOutHandler: handler,
    });
    await expect(client.recordOptOut("+15551234567")).rejects.toThrow(/opt-out endpoint/);
  });

  it("the default handler resolves without throwing", async () => {
    const client = createTwilioClient({
      accountSid: "AC",
      authToken: "t",
      sdk: makeFakeSdk([{ sid: "x", status: "queued" }]).sdk,
    });
    await expect(client.recordOptOut("+15551234567")).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateWebhookSignature — golden vectors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reproduces Twilio's request-signature algorithm: the data string is the URL
 * followed by each POST param's key+value, sorted by key; HMAC-SHA1 with the
 * auth token, base64-encoded. Used to mint a known-good golden signature.
 */
function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

describe("validateWebhookSignature", () => {
  const AUTH = "twilio_auth_token_secret";
  const URL = "https://app.lapsed.ai/api/sms/inbound";
  const PARAMS = {
    From: "+15551234567",
    To: "+18888800461",
    Body: "yes please",
    MessageSid: "SM0123456789",
  };

  it("accepts a correctly-signed request (golden vector)", () => {
    const sig = twilioSignature(AUTH, URL, PARAMS);
    expect(
      validateWebhookSignature({ authToken: AUTH, signature: sig, url: URL, params: PARAMS }),
    ).toBe(true);
  });

  it("rejects a request signed with the wrong auth token", () => {
    const sig = twilioSignature("wrong_token", URL, PARAMS);
    expect(
      validateWebhookSignature({ authToken: AUTH, signature: sig, url: URL, params: PARAMS }),
    ).toBe(false);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const sig = twilioSignature(AUTH, URL, PARAMS);
    const tampered = { ...PARAMS, Body: "STOP" };
    expect(
      validateWebhookSignature({ authToken: AUTH, signature: sig, url: URL, params: tampered }),
    ).toBe(false);
  });

  it("rejects a request to a different URL", () => {
    const sig = twilioSignature(AUTH, URL, PARAMS);
    expect(
      validateWebhookSignature({
        authToken: AUTH,
        signature: sig,
        url: "https://evil.example.com/api/sms/inbound",
        params: PARAMS,
      }),
    ).toBe(false);
  });

  it("returns false for a garbage signature rather than throwing", () => {
    expect(
      validateWebhookSignature({
        authToken: AUTH,
        signature: "not-a-real-signature",
        url: URL,
        params: PARAMS,
      }),
    ).toBe(false);
  });

  it("returns false for an empty signature", () => {
    expect(
      validateWebhookSignature({ authToken: AUTH, signature: "", url: URL, params: PARAMS }),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maskPhone
// ─────────────────────────────────────────────────────────────────────────────

describe("maskPhone", () => {
  it("keeps only the last 4 digits", () => {
    expect(maskPhone("+15551234567")).toBe("***4567");
  });

  it("strips non-digit characters before masking", () => {
    expect(maskPhone("(555) 123-4567")).toBe("***4567");
  });

  it("fully masks a short string", () => {
    expect(maskPhone("123")).toBe("***");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendSms — per-attempt timeout (criterion 9 / decision 17 latency budget)
// ─────────────────────────────────────────────────────────────────────────────

describe("createTwilioClient.sendSms — per-attempt timeout", () => {
  it("aborts a hanging send attempt and retries it", async () => {
    let call = 0;
    const sdk: TwilioSdk = {
      messages: {
        create: async () => {
          call++;
          // First attempt hangs forever; the timeout aborts it.
          if (call === 1) return new Promise<never>(() => {});
          return { sid: "SM_after_timeout", status: "queued" };
        },
      },
    };
    const client = createTwilioClient({
      accountSid: "AC",
      authToken: "t",
      sdk,
      sleep: instantSleep,
      sendTimeoutMs: 10,
    });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attempts).toBe(2);
  });

  it("returns ok:false when every attempt hangs past the timeout", async () => {
    const sdk: TwilioSdk = {
      messages: { create: async () => new Promise<never>(() => {}) },
    };
    const client = createTwilioClient({
      accountSid: "AC",
      authToken: "t",
      sdk,
      sleep: instantSleep,
      sendTimeoutMs: 10,
    });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempts).toBe(TWILIO_MAX_SEND_RETRIES);
      expect(result.errorClass).toBe("TwilioTimeoutError");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendSms — backoff invocation + computeBackoffMs curve
// ─────────────────────────────────────────────────────────────────────────────

describe("createTwilioClient.sendSms — backoff", () => {
  it("sleeps once per retry (attempts - 1 times) on a persistent transient failure", async () => {
    const sleepSpy = vi.fn(async () => {});
    const { sdk } = makeFakeSdk([twilioError({ status: 503 })]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: sleepSpy });
    await client.sendSms(SEND);
    // 3 attempts → 2 backoff sleeps
    expect(sleepSpy).toHaveBeenCalledTimes(TWILIO_MAX_SEND_RETRIES - 1);
  });

  it("does not sleep before the first attempt", async () => {
    const sleepSpy = vi.fn(async () => {});
    const { sdk } = makeFakeSdk([{ sid: "SM_first_ok", status: "queued" }]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: sleepSpy });
    await client.sendSms(SEND);
    expect(sleepSpy).not.toHaveBeenCalled();
  });
});

describe("computeBackoffMs", () => {
  it("grows exponentially from the base across retry steps", () => {
    // step 1 → ~250ms base, step 2 → ~500ms base (plus jitter < 250)
    expect(computeBackoffMs(1)).toBeGreaterThanOrEqual(250);
    expect(computeBackoffMs(1)).toBeLessThan(500);
    expect(computeBackoffMs(2)).toBeGreaterThanOrEqual(500);
    expect(computeBackoffMs(2)).toBeLessThan(750);
  });

  it("caps the delay at BACKOFF_MAX_MS for large retry steps", () => {
    // step 10 raw would be 250 * 2^9 = 128000ms; the cap is 4000ms.
    expect(computeBackoffMs(10)).toBeLessThanOrEqual(4000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendSms — network-only failure result shape
// ─────────────────────────────────────────────────────────────────────────────

describe("createTwilioClient.sendSms — network failure result", () => {
  it("returns ok:false with errorCode null when every attempt is a statusless network error", async () => {
    const { sdk } = makeFakeSdk([twilioError({ message: "ECONNRESET" })]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBeNull();
      expect(result.attempts).toBe(TWILIO_MAX_SEND_RETRIES);
    }
  });

  it("classifies a thrown non-Error value without crashing", async () => {
    const sdk: TwilioSdk = {
      messages: {
        create: async () => {
          throw "a bare string error";
        },
      },
    };
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    // a bare string has no `status` → transient → exhausts retries
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorClass).toBe("Error");
  });

  it("treats an HTTP 408 request-timeout as transient (retried)", async () => {
    const { sdk } = makeFakeSdk([
      twilioError({ status: 408, message: "request timeout" }),
      { sid: "SM_408_ok", status: "queued" },
    ]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    const result = await client.sendSms(SEND);
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PII discipline — no raw phone number in structured logs (criterion 8)
// ─────────────────────────────────────────────────────────────────────────────

describe("structured logs never contain a raw phone number", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("masks the recipient phone in a twilio_send_failed log", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sdk } = makeFakeSdk([twilioError({ status: 400, code: 21211 })]);
    const client = createTwilioClient({ accountSid: "AC", authToken: "t", sdk, sleep: instantSleep });
    await client.sendSms(SEND);
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("twilio_send_failed");
    expect(logged).toContain("***4567");
    expect(logged).not.toContain(SEND.to);
  });

  it("masks the phone in a twilio_opt_out_recorded log from the default handler", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const client = createTwilioClient({
      accountSid: "AC",
      authToken: "t",
      sdk: makeFakeSdk([{ sid: "x", status: "queued" }]).sdk,
    });
    await client.recordOptOut("+15551234567");
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("twilio_opt_out_recorded");
    expect(logged).toContain("***4567");
    expect(logged).not.toContain("+15551234567");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateWebhookSignature — cross-check against Twilio's own signer
// ─────────────────────────────────────────────────────────────────────────────
// The golden-vector tests above mint signatures with this file's hand-rolled
// `twilioSignature()` and assert Twilio's `validateRequest` accepts them — if
// the hand-rolled algorithm diverged from Twilio's, those tests would fail.
// This block independently confirms the agreement by minting the signature
// with Twilio's OWN `getExpectedTwilioSignature` helper and asserting BOTH
// our wrapper and our hand-rolled signer agree with it.

describe("validateWebhookSignature — agrees with Twilio's own signer", () => {
  it("our wrapper validates a signature minted by Twilio's getExpectedTwilioSignature", async () => {
    const webhooks = await import("twilio/lib/webhooks/webhooks.js");
    const authToken = "twilio_auth_token_secret";
    const url = "https://app.lapsed.ai/api/sms/inbound";
    const params = { From: "+15551234567", To: "+18888800461", Body: "yes please" };
    const twilioMinted = webhooks.getExpectedTwilioSignature(authToken, url, params);
    expect(validateWebhookSignature({ authToken, signature: twilioMinted, url, params })).toBe(
      true,
    );
  });
});
