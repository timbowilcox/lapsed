// Integration test for the voice-extraction orchestrator (chunk 7).
// Mocks @lapsed/shopify (fetchStorefrontSnapshot + computeSourceHash) and the
// Anthropic SDK client; all other building blocks (redactSnapshot, assertNoPii,
// appendVoiceEvent, insertVoiceVersion, materializeVoice, deriveAgentIdentity)
// execute against a mocked Supabase client that records every DB write.
//
// Key assertions per architectural decision:
// - Decision 8: snapshot row contains BOTH raw + redacted content
// - Decision 10: corpus passed to Anthropic contains [email] token, not raw address
// - Decision 12: storefront_fetched + pii_redacted + voice_extracted events written
// - Decision 5: daily cap exhaustion returns extraction_failed, no Anthropic call made

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type Anthropic from "@anthropic-ai/sdk";

// vi.mock is hoisted above all imports by vitest — the import below resolves
// to the mocked module.
vi.mock("@lapsed/shopify", () => ({
  fetchStorefrontSnapshot: vi.fn(),
  computeSourceHash: vi.fn().mockReturnValue("a".repeat(64)),
}));

import { fetchStorefrontSnapshot } from "@lapsed/shopify";
import { runVoiceExtraction, type RunVoiceExtractionInput } from "../src/run-voice-extraction";
import { ROLE_TAXONOMY } from "../src/derive-agent-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const SNAPSHOT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VERSION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE_HASH = "a".repeat(64);

// Raw snapshot includes an email address to verify PII redaction.
const RAW_SNAPSHOT = {
  about: "Contact founder@example.com with any questions. Small batch granola.",
  products: [{ title: "Granola Bar", body: "Handmade. No GMOs. Best seller." }],
  blog: [{ title: "Our Story", body: "We started in a garage in 2018." }],
  policies: { privacy: "We respect your privacy.", refund: "30-day returns.", shipping: "" },
  footer: "Granola Co",
};

const MOCK_FETCH_RESULT = {
  snapshot: RAW_SNAPSHOT,
  failures: [],
};

const VALID_PROFILE = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "medium",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: [],
  signature_phrases: ["small batch"],
  sample_sentences: ["s1", "s2", "s3", "s4", "s5"],
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock Anthropic client factory
// ─────────────────────────────────────────────────────────────────────────────

function makeAnthropicClient(profile = VALID_PROFILE): {
  client: Anthropic;
  createFn: ReturnType<typeof vi.fn>;
} {
  const createFn = vi.fn().mockResolvedValue({
    content: [{ type: "tool_use", id: "tu_1", name: "extract_brand_voice", input: profile }],
    usage: { input_tokens: 1200, output_tokens: 350 },
  });
  const client = { messages: { create: createFn } } as unknown as Anthropic;
  return { client, createFn };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Supabase client factory
// ─────────────────────────────────────────────────────────────────────────────

interface DbWrites {
  snapshots: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  versions: Array<Record<string, unknown>>;
  agentProfiles: Array<Record<string, unknown>>;
}

interface MockClientConfig {
  todayExtractionCount?: number;
  existingSnapshot?: boolean;
  // Error injection — allows targeted DB failure tests without separate mock modules.
  snapshotLookupError?: { message: string };
  snapshotInsertError?: { message: string };
  /** 1-based: the Nth voice_events.upsert() call returns this error. */
  eventUpsertErrorOnCall?: number;
  versionInsertError?: { message: string };
  agentProfileUpsertError?: { message: string };
  /** If set, voice_events.maybeSingle() (used by materializeVoice) returns this error. */
  materializeVoiceEventsError?: { message: string };
}

function makeMockClient(cfg: MockClientConfig = {}): {
  client: LapsedSupabaseClient;
  writes: DbWrites;
} {
  const todayCount = cfg.todayExtractionCount ?? 0;
  const existingSnapshot = cfg.existingSnapshot ?? false;

  const writes: DbWrites = {
    snapshots: [],
    events: [],
    versions: [],
    agentProfiles: [],
  };

  // Shared counter across all from("voice_events") calls so
  // eventUpsertErrorOnCall targets the globally Nth upsert.
  let eventUpsertCount = 0;

  // State for the materializeVoice call: after voice_extracted event is
  // written, materializeVoice queries for the latest voice_extracted event.
  // We return it pre-configured so the materializer finds VERSION_ID.
  const materializeExtractedRow = {
    payload: {
      version_id: VERSION_ID,
      snapshot_id: SNAPSHOT_ID,
      model_version: "claude-sonnet-4-6-latest",
      prompt_version: "57ffb74af71b3063",
      tokens_input: 1200,
      tokens_output: 350,
      retries: 0,
    },
    occurred_at: "2026-05-16T10:00:00.000Z",
  };

  function makeVoiceEventsChain() {
    let isCountQuery = false;
    let eventTypeFilter: string | null = null;

    const chain: Record<string, unknown> = {
      select: (_cols?: unknown, opts?: { count?: string }) => {
        if (opts?.count === "exact") isCountQuery = true;
        return chain;
      },
      eq: (_col: string, val: string) => {
        if (_col === "event_type") eventTypeFilter = val;
        return chain;
      },
      // Terminal for the daily-cap count query.
      gte: () => {
        if (isCountQuery) {
          return Promise.resolve({ count: todayCount, error: null });
        }
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      // Terminal for materializeVoice selects.
      maybeSingle: () => {
        if (cfg.materializeVoiceEventsError) {
          return Promise.resolve({ data: null, error: cfg.materializeVoiceEventsError });
        }
        if (eventTypeFilter === "voice_activated") {
          return Promise.resolve({ data: null, error: null });
        }
        if (eventTypeFilter === "voice_extracted") {
          return Promise.resolve({ data: materializeExtractedRow, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // appendVoiceEvent uses upsert.
      upsert: (row: Record<string, unknown>) => {
        eventUpsertCount++;
        if (cfg.eventUpsertErrorOnCall !== undefined && eventUpsertCount === cfg.eventUpsertErrorOnCall) {
          return Promise.resolve({ data: null, error: { message: "injected event upsert error" } });
        }
        writes.events.push(row);
        return Promise.resolve({ data: null, error: null });
      },
    };
    return chain;
  }

  function makeSnapshotChain() {
    const lookupInsertChain: Record<string, unknown> = {
      // Lookup path: .select().eq().eq().maybeSingle()
      select: () => lookupInsertChain,
      eq: () => lookupInsertChain,
      maybeSingle: () => {
        if (cfg.snapshotLookupError) {
          return Promise.resolve({ data: null, error: cfg.snapshotLookupError });
        }
        return Promise.resolve({
          data: existingSnapshot ? { id: SNAPSHOT_ID } : null,
          error: null,
        });
      },
      // Insert path: .insert(row).select().single()
      insert: (row: Record<string, unknown>) => {
        writes.snapshots.push(row);
        const insertChain: Record<string, unknown> = {
          select: () => insertChain,
          single: () => {
            if (cfg.snapshotInsertError) {
              return Promise.resolve({ data: null, error: cfg.snapshotInsertError });
            }
            return Promise.resolve({ data: { id: SNAPSHOT_ID }, error: null });
          },
        };
        return insertChain;
      },
    };
    return lookupInsertChain;
  }

  function makeVersionsChain() {
    let insertedRow: Record<string, unknown> | null = null;

    const chain: Record<string, unknown> = {
      // Select for max version number (insertVoiceVersion) or existence check (materializeVoice).
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        // materializeVoice checks existence of VERSION_ID after the insert.
        // insertVoiceVersion looks up max version_number — returns null (first version).
        if (insertedRow !== null) {
          // Post-insert call from materializeVoice — version exists.
          return Promise.resolve({ data: { id: VERSION_ID }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // insertVoiceVersion insert path.
      insert: (row: Record<string, unknown>) => {
        insertedRow = row;
        writes.versions.push(row);
        const insertChain: Record<string, unknown> = {
          select: () => insertChain,
          single: () => {
            if (cfg.versionInsertError) {
              return Promise.resolve({ data: null, error: cfg.versionInsertError });
            }
            return Promise.resolve({
              data: { id: VERSION_ID, version_number: 1 },
              error: null,
            });
          },
        };
        return insertChain;
      },
    };
    return chain;
  }

  function makeAgentProfilesChain() {
    return {
      upsert: (row: Record<string, unknown>) => {
        writes.agentProfiles.push(row);
        if (cfg.agentProfileUpsertError) {
          return Promise.resolve({ data: null, error: cfg.agentProfileUpsertError });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  const client = {
    from: vi.fn((table: string) => {
      if (table === "voice_events") return makeVoiceEventsChain();
      if (table === "storefront_snapshots") return makeSnapshotChain();
      if (table === "voice_versions") return makeVersionsChain();
      if (table === "agent_profiles") return makeAgentProfilesChain();
      throw new Error(`unexpected table: ${table}`);
    }),
  } as unknown as LapsedSupabaseClient;

  return { client, writes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared input builder
// ─────────────────────────────────────────────────────────────────────────────

function makeInput(
  overrides: Partial<RunVoiceExtractionInput> & {
    serviceClient: LapsedSupabaseClient;
    anthropicClient: Anthropic;
  },
): RunVoiceExtractionInput {
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
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("runVoiceExtraction — happy path", () => {
  beforeEach(() => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
  });

  it("returns ok:true with versionId, snapshotId, and token counts", async () => {
    const { client } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.versionId).toBe(VERSION_ID);
    expect(result.snapshotId).toBe(SNAPSHOT_ID);
    expect(result.versionNumber).toBe(1);
    expect(result.tokensInput).toBe(1200);
    expect(result.tokensOutput).toBe(350);
    expect(result.retries).toBe(0);
  });

  it("inserts snapshot row with both raw and redacted content (decision 8)", async () => {
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(writes.snapshots).toHaveLength(1);
    const row = writes.snapshots[0]!;
    expect(row.merchant_id).toBe(MERCHANT_ID);
    expect(row.source_hash).toBe(SOURCE_HASH);
    // Raw content preserved.
    expect((row.raw_content as { about: string }).about).toContain("founder@example.com");
    // Redacted content has PII stripped.
    expect((row.redacted_content as { about: string }).about).toContain("[email]");
    expect((row.redacted_content as { about: string }).about).not.toContain("founder@example.com");
  });

  it("passes REDACTED corpus to Anthropic — not raw PII (decision 10)", async () => {
    const { client } = makeMockClient();
    const { client: anthropic, createFn } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    const callArgs = createFn.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const corpus: string = callArgs.messages[0]!.content;
    expect(corpus).toContain("[email]");
    expect(corpus).not.toContain("founder@example.com");
  });

  it("writes storefront_fetched event (decision 12)", async () => {
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    const eventTypes = writes.events.map((e) => e.event_type);
    expect(eventTypes).toContain("storefront_fetched");
    const ev = writes.events.find((e) => e.event_type === "storefront_fetched")!;
    expect(ev.merchant_id).toBe(MERCHANT_ID);
    expect((ev.payload as { snapshot_id: string }).snapshot_id).toBe(SNAPSHOT_ID);
  });

  it("writes pii_redacted event after storefront_fetched (decision 12)", async () => {
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    const eventTypes = writes.events.map((e) => e.event_type);
    expect(eventTypes).toContain("pii_redacted");
    // pii_redacted event is written after storefront_fetched.
    const fetchedIdx = eventTypes.indexOf("storefront_fetched");
    const redactedIdx = eventTypes.indexOf("pii_redacted");
    expect(redactedIdx).toBeGreaterThan(fetchedIdx);
  });

  it("writes voice_extracted event (decision 12)", async () => {
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    const ev = writes.events.find((e) => e.event_type === "voice_extracted");
    expect(ev).toBeDefined();
    expect((ev!.payload as { version_id: string }).version_id).toBe(VERSION_ID);
    expect((ev!.payload as { snapshot_id: string }).snapshot_id).toBe(SNAPSHOT_ID);
  });

  it("upserts agent_profiles with role_descriptor from ROLE_TAXONOMY (decision 11)", async () => {
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    // agentProfiles[0] is the materializeVoice pointer upsert (active_voice_version_id only).
    // agentProfiles[1] is the identity-defaults upsert (role_descriptor, channel_prefs, etc.).
    const identityUpsert = writes.agentProfiles.find((u) => "role_descriptor" in u);
    expect(identityUpsert).toBeDefined();
    expect(ROLE_TAXONOMY).toContain(identityUpsert!.role_descriptor);
    expect(identityUpsert!.active_voice_version_id).toBe(VERSION_ID);
    expect(identityUpsert!.merchant_id).toBe(MERCHANT_ID);
  });

  it("inserts a voice_versions row with the synthesized profile", async () => {
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(writes.versions).toHaveLength(1);
    const row = writes.versions[0]!;
    expect(row.merchant_id).toBe(MERCHANT_ID);
    expect(row.source_snapshot_id).toBe(SNAPSHOT_ID);
    expect(row.version_number).toBe(1);
    const profile = row.profile as typeof VALID_PROFILE;
    expect(profile.tone_descriptors).toEqual(["warm", "playful", "down_to_earth"]);
    expect(profile.sample_sentences).toHaveLength(5);
  });

  it("deduplicates re-fetch: returns existing snapshot id without re-inserting", async () => {
    const { client, writes } = makeMockClient({ existingSnapshot: true });
    const { client: anthropic } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Snapshot already existed — no new insert.
    expect(writes.snapshots).toHaveLength(0);
    expect(result.snapshotId).toBe(SNAPSHOT_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Daily cap exhaustion (decision 5)
// ─────────────────────────────────────────────────────────────────────────────

describe("runVoiceExtraction — daily cap exhaustion", () => {
  it("11th call same UTC day returns ok:false with reason cap_check", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    // 11 prior successful extractions today (cap default = 10 → exhausted).
    const { client } = makeMockClient({ todayExtractionCount: 11 });
    const { client: anthropic, createFn } = makeAnthropicClient();
    const result = await runVoiceExtraction(
      makeInput({ serviceClient: client, anthropicClient: anthropic, dailyCapDefault: 10 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("cap_check");
    expect(result.detail).toBe("daily_cap_exhausted");
    // No Sonnet call made.
    expect(createFn).not.toHaveBeenCalled();
  });

  it("exactly at cap (count === cap) returns ok:false — cap is exclusive", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    const { client } = makeMockClient({ todayExtractionCount: 10 });
    const { client: anthropic, createFn } = makeAnthropicClient();
    const result = await runVoiceExtraction(
      makeInput({ serviceClient: client, anthropicClient: anthropic, dailyCapDefault: 10 }),
    );
    expect(result.ok).toBe(false);
    // No Sonnet call when at cap.
    expect(createFn).not.toHaveBeenCalled();
  });

  it("writes extraction_failed event with reason daily_cap_exhausted on cap hit", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    const { client, writes } = makeMockClient({ todayExtractionCount: 10 });
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(
      makeInput({ serviceClient: client, anthropicClient: anthropic, dailyCapDefault: 10 }),
    );
    const failEvent = writes.events.find((e) => e.event_type === "extraction_failed");
    expect(failEvent).toBeDefined();
    expect((failEvent!.payload as { reason: string }).reason).toBe("daily_cap_exhausted");
  });

  it("one below cap (count = cap - 1) proceeds normally", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    const { client } = makeMockClient({ todayExtractionCount: 9 });
    const { client: anthropic, createFn } = makeAnthropicClient();
    const result = await runVoiceExtraction(
      makeInput({ serviceClient: client, anthropicClient: anthropic, dailyCapDefault: 10 }),
    );
    expect(result.ok).toBe(true);
    expect(createFn).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extraction failure paths
// ─────────────────────────────────────────────────────────────────────────────

describe("runVoiceExtraction — extraction failure paths", () => {
  it("returns ok:false with reason fetch when fetchStorefrontSnapshot throws", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockRejectedValue(new Error("shopify 503"));
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fetch");
    const failEv = writes.events.find((e) => e.event_type === "extraction_failed");
    expect(failEv).toBeDefined();
    expect((failEv!.payload as { phase: string }).phase).toBe("fetch");
  });

  it("returns ok:false with reason fetch when all snapshot resources fail", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue({
      snapshot: {
        about: "",
        products: [],
        blog: [],
        policies: { privacy: "", refund: "", shipping: "" },
        footer: "",
      },
      failures: [
        { resource: "about", reason: "http", status: 503 },
        { resource: "products", reason: "http", status: 503 },
        { resource: "blog", reason: "http", status: 503 },
        { resource: "policies", reason: "http", status: 503 },
        { resource: "footer", reason: "http", status: 503 },
      ],
    });
    const { client } = makeMockClient();
    const { client: anthropic, createFn } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    expect(createFn).not.toHaveBeenCalled();
  });

  it("returns ok:false with reason synthesize when Anthropic exhausts retries", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    const { client } = makeMockClient();
    // Return malformed profile on every attempt so VoiceSynthesisError(schema_validation) is thrown.
    const badProfile = { ...VALID_PROFILE, tone_descriptors: ["not_in_taxonomy"] };
    const createFn = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "tu_1", name: "extract_brand_voice", input: badProfile }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    const anthropic = { messages: { create: createFn } } as unknown as Anthropic;
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("synthesize");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decision 10 — voice_extracted events contain no PII
// ─────────────────────────────────────────────────────────────────────────────

describe("decision 10 — voice_extracted event payload is PII-free", () => {
  it("voice_extracted payload contains no email address from raw snapshot", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    const extractedEvent = writes.events.find((e) => e.event_type === "voice_extracted");
    // Payload is metadata-only (version_id, snapshot_id, tokens, etc.) — never contains corpus text.
    const payloadStr = JSON.stringify(extractedEvent?.payload ?? {});
    expect(payloadStr).not.toContain("founder@example.com");
    expect(payloadStr).not.toContain("[email]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// source field forwarding
// ─────────────────────────────────────────────────────────────────────────────

describe("runVoiceExtraction — source field", () => {
  it("defaults to install_orchestrator when source is omitted", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(writes.events[0]!.source).toBe("install_orchestrator");
  });

  it("forwards settings_reextract source to all events", async () => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
    const { client, writes } = makeMockClient();
    const { client: anthropic } = makeAnthropicClient();
    await runVoiceExtraction(
      makeInput({ serviceClient: client, anthropicClient: anthropic, source: "settings_reextract" }),
    );
    const allSources = writes.events.map((e) => e.source);
    expect(allSources.every((s) => s === "settings_reextract")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB error injection paths (gaps 2–5 from test-coverage analysis)
// ─────────────────────────────────────────────────────────────────────────────

describe("runVoiceExtraction — DB error paths", () => {
  beforeEach(() => {
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue(MOCK_FETCH_RESULT);
  });

  it("gap 2a — snapshot lookup DB error returns ok:false reason:fetch with extraction_failed event", async () => {
    const { client, writes } = makeMockClient({ snapshotLookupError: { message: "rls denied" } });
    const { client: anthropic, createFn } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fetch");
    // Anthropic was never called.
    expect(createFn).not.toHaveBeenCalled();
    // extraction_failed event written via safeAppend.
    expect(writes.events.some((e) => e.event_type === "extraction_failed")).toBe(true);
  });

  it("gap 2b — snapshot insert DB error returns ok:false reason:fetch", async () => {
    const { client } = makeMockClient({ snapshotInsertError: { message: "insert failed" } });
    const { client: anthropic, createFn } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fetch");
    expect(createFn).not.toHaveBeenCalled();
  });

  it("gap 3 — storefront_fetched event upsert error returns ok:false reason:fetch", async () => {
    // The 1st voice_events upsert is for storefront_fetched (step 5).
    const { client } = makeMockClient({ eventUpsertErrorOnCall: 1 });
    const { client: anthropic, createFn } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fetch");
    expect(createFn).not.toHaveBeenCalled();
  });

  it("gap 4 — voice_versions insert error returns ok:false reason:materialize", async () => {
    const { client } = makeMockClient({ versionInsertError: { message: "version insert failed" } });
    const { client: anthropic } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("materialize");
  });

  it("gap 5a — materializeVoice voice_events query error returns ok:false reason:materialize", async () => {
    const { client } = makeMockClient({
      materializeVoiceEventsError: { message: "voice_events materialization error" },
    });
    const { client: anthropic } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("materialize");
  });

  it("gap 5b — agent_profiles upsert error returns ok:false reason:materialize", async () => {
    const { client } = makeMockClient({ agentProfileUpsertError: { message: "agent profiles upsert failed" } });
    const { client: anthropic } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("materialize");
  });

  it("gap 6 — partial failures with all-empty snapshot returns ok:false (allFieldsEmpty second branch)", async () => {
    // 2 failures (not 5) + all-empty snapshot → second disjunct of the guard fires.
    vi.mocked(fetchStorefrontSnapshot).mockResolvedValue({
      snapshot: {
        about: "",
        products: [],
        blog: [],
        policies: { privacy: "", refund: "", shipping: "" },
        footer: "",
      },
      failures: [
        { resource: "about", reason: "http", status: 503 },
        { resource: "products", reason: "http", status: 503 },
      ],
    });
    const { client } = makeMockClient();
    const { client: anthropic, createFn } = makeAnthropicClient();
    const result = await runVoiceExtraction(makeInput({ serviceClient: client, anthropicClient: anthropic }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("fetch");
    // Sonnet must not be called when snapshot is degraded beyond usefulness.
    expect(createFn).not.toHaveBeenCalled();
  });
});
