// Gap 1 — tests the assertNoPii pre-flight gate in the orchestrator.
//
// This file lives separately from run-voice-extraction.test.ts because it
// needs its own vi.mock for ../src/pii-redactor so that redactSnapshot can
// be configured to return content that still contains PII. The real
// assertNoPii runs (not mocked) and throws PiiLeakError when it detects
// the un-redacted content. This proves the failExtraction("redact", err)
// path at lines 149–154 of run-voice-extraction.ts is reachable.
//
// Architectural decision tested: decision 10 (PII redaction mandatory before
// any LLM call). The pre-flight check fires BEFORE synthesizeVoice so that
// even a buggy redactSnapshot implementation cannot silently leak PII to
// Anthropic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type Anthropic from "@anthropic-ai/sdk";

// vi.mock is hoisted above all imports. Order matters:
// 1. Mock @lapsed/shopify so fetchStorefrontSnapshot is injectable.
// 2. Mock ../src/pii-redactor — keep assertNoPii real but stub redactSnapshot.

vi.mock("@lapsed/shopify", () => ({
  fetchStorefrontSnapshot: vi.fn(),
  computeSourceHash: vi.fn().mockReturnValue("a".repeat(64)),
}));

vi.mock("../src/pii-redactor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pii-redactor")>();
  return {
    ...actual,
    // redactSnapshot is stubbed so it returns content with PII still present.
    // All other exports (assertNoPii, PiiLeakError, etc.) are the real ones.
    redactSnapshot: vi.fn(),
  };
});

import { fetchStorefrontSnapshot } from "@lapsed/shopify";
import * as PiiRedactor from "../src/pii-redactor";
import { runVoiceExtraction, type RunVoiceExtractionInput } from "../src/run-voice-extraction";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const SNAPSHOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const RAW_SNAPSHOT = {
  about: "Contact founder@example.com with any questions.",
  products: [],
  blog: [],
  policies: { privacy: "", refund: "", shipping: "" },
  footer: "Granola Co",
};

const MOCK_FETCH_RESULT = { snapshot: RAW_SNAPSHOT, failures: [] };

// ─────────────────────────────────────────────────────────────────────────────
// Minimal mock helpers (self-contained — no shared imports from the other file)
// ─────────────────────────────────────────────────────────────────────────────

function makeDummyAnthropicClient(): { client: Anthropic; createFn: ReturnType<typeof vi.fn> } {
  const createFn = vi.fn();
  const client = { messages: { create: createFn } } as unknown as Anthropic;
  return { client, createFn };
}

function makeDummySupabaseClient(): LapsedSupabaseClient {
  let eventUpsertCount = 0;
  const materializeExtractedRow = {
    payload: {
      version_id: VERSION_ID,
      snapshot_id: SNAPSHOT_ID,
      model_version: "claude-sonnet-4-6-latest",
      prompt_version: "57ffb74af71b3063",
      tokens_input: 0,
      tokens_output: 0,
      retries: 0,
    },
    occurred_at: "2026-05-16T10:00:00.000Z",
  };
  const client = {
    from: vi.fn((table: string) => {
      if (table === "voice_events") {
        let isCount = false;
        let eventTypeFilter: string | null = null;
        const chain: Record<string, unknown> = {
          select: (_: unknown, opts?: { count?: string }) => { if (opts?.count === "exact") isCount = true; return chain; },
          eq: (_: string, v: string) => { if (_ === "event_type") eventTypeFilter = v; return chain; },
          gte: () => isCount ? Promise.resolve({ count: 0, error: null }) : chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => {
            if (eventTypeFilter === "voice_activated") return Promise.resolve({ data: null, error: null });
            if (eventTypeFilter === "voice_extracted") return Promise.resolve({ data: materializeExtractedRow, error: null });
            return Promise.resolve({ data: null, error: null });
          },
          upsert: () => { eventUpsertCount++; return Promise.resolve({ data: null, error: null }); },
        };
        return chain;
      }
      if (table === "storefront_snapshots") {
        const c: Record<string, unknown> = {
          select: () => c, eq: () => c,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          insert: () => {
            const ic: Record<string, unknown> = {
              select: () => ic,
              single: () => Promise.resolve({ data: { id: SNAPSHOT_ID }, error: null }),
            };
            return ic;
          },
        };
        return c;
      }
      if (table === "voice_versions") {
        let inserted = false;
        const c: Record<string, unknown> = {
          select: () => c, eq: () => c, order: () => c, limit: () => c,
          maybeSingle: () => Promise.resolve({ data: inserted ? { id: VERSION_ID } : null, error: null }),
          insert: () => {
            inserted = true;
            const ic: Record<string, unknown> = {
              select: () => ic,
              single: () => Promise.resolve({ data: { id: VERSION_ID, version_number: 1 }, error: null }),
            };
            return ic;
          },
        };
        return c;
      }
      if (table === "agent_profiles") {
        return { upsert: () => Promise.resolve({ data: null, error: null }) };
      }
      throw new Error(`unexpected table: ${table}`);
    }),
  } as unknown as LapsedSupabaseClient;
  return client;
}

function makeInput(overrides: Partial<RunVoiceExtractionInput> & { serviceClient: LapsedSupabaseClient; anthropicClient: Anthropic }): RunVoiceExtractionInput {
  return {
    merchantId: MERCHANT_ID,
    shopDomain: "test-shop.myshopify.com",
    accessToken: "shpat_test",
    dailyCapDefault: 10,
    now: () => new Date("2026-05-16T10:00:00.000Z"),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gap 1: assertNoPii pre-flight throws PiiLeakError
// ─────────────────────────────────────────────────────────────────────────────

describe("runVoiceExtraction — assertNoPii pre-flight gate (decision 10, gap 1)", () => {
  beforeEach(() => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    // redactSnapshot returns content with PII still present so assertNoPii fires.
    vi.mocked(PiiRedactor.redactSnapshot).mockReturnValue({
      redacted: {
        about: "Contact founder@example.com with any questions.",  // email NOT removed
        products: [],
        blog: [],
        policies: { privacy: "", refund: "", shipping: "" },
        footer: "Granola Co",
      } as unknown as Record<string, unknown>,
      summary: { email: 0, phone: 0, name: 0, social: 0 },
    } as ReturnType<typeof PiiRedactor.redactSnapshot>);
  });

  it("returns ok:false with reason:redact when assertNoPii detects PII in redacted corpus", async () => {
    const serviceClient = makeDummySupabaseClient();
    const { client: anthropic, createFn } = makeDummyAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("redact");
    // Sonnet must NOT be called — PII gate fired before LLM call.
    expect(createFn).not.toHaveBeenCalled();
  });

  it("writes extraction_failed event with phase:redact when assertNoPii throws", async () => {
    const serviceClient = makeDummySupabaseClient();
    const { client: anthropic } = makeDummyAnthropicClient();
    // Capture events via the client's from("voice_events").upsert spy.
    const upsertedRows: Array<Record<string, unknown>> = [];
    const originalFrom = (serviceClient as unknown as { from: ReturnType<typeof vi.fn> }).from;
    const wrappedFrom = vi.fn((table: string) => {
      const chain = originalFrom(table);
      if (table === "voice_events" && chain && typeof chain === "object") {
        const originalUpsert = (chain as Record<string, unknown>).upsert as (r: Record<string, unknown>) => unknown;
        (chain as Record<string, unknown>).upsert = (row: Record<string, unknown>) => {
          upsertedRows.push(row);
          return originalUpsert(row);
        };
      }
      return chain;
    });
    (serviceClient as unknown as { from: unknown }).from = wrappedFrom;
    await runVoiceExtraction(makeInput({ serviceClient, anthropicClient: anthropic }));
    const failEvent = upsertedRows.find((r) => r.event_type === "extraction_failed");
    expect(failEvent).toBeDefined();
    expect((failEvent!.payload as { phase: string }).phase).toBe("redact");
  });
});
