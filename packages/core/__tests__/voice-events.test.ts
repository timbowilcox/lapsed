import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import {
  appendVoiceEvent,
  materializeVoice,
  insertVoiceVersion,
  type VoiceEventInput,
} from "../src/voice-events";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID_2 = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-05-15T10:30:00.000Z";

const VALID_PROFILE = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "medium",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: [],
  signature_phrases: ["small batch"],
  sample_sentences: ["s1", "s2", "s3", "s4", "s5"],
} as const satisfies {
  tone_descriptors: readonly string[];
  sentence_length: string;
  register: string;
  emoji_policy: string;
  forbidden_phrases: readonly string[];
  signature_phrases: readonly string[];
  sample_sentences: readonly string[];
};
// Cast to mutable VoiceProfile for the insertVoiceVersion calls below.
const VALID_PROFILE_FOR_INSERT = VALID_PROFILE as unknown as import("../src/voice-synthesizer").VoiceProfile;

// ─────────────────────────────────────────────────────────────────────────────
// appendVoiceEvent — mock client + payload validation
// ─────────────────────────────────────────────────────────────────────────────

type UpsertCall = { table: string; row: Record<string, unknown>; opts: unknown };

function makeMockClient(upsertError?: { message: string }) {
  const upserts: UpsertCall[] = [];
  const client = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn((row: Record<string, unknown>, opts: unknown) => {
        upserts.push({ table, row, opts });
        return Promise.resolve(
          upsertError ? { data: null, error: upsertError } : { data: null, error: null },
        );
      }),
    })),
  } as unknown as LapsedSupabaseClient;
  return { client, upserts };
}

describe("appendVoiceEvent — happy path", () => {
  it("writes a storefront_fetched event with the DB column shape", async () => {
    const { client, upserts } = makeMockClient();
    const event: VoiceEventInput = {
      merchantId: MERCHANT_ID,
      eventType: "storefront_fetched",
      source: "install_orchestrator",
      occurredAt: NOW,
      payload: { snapshot_id: SNAPSHOT_ID, byte_count: 4096, source_hash: "a".repeat(64) },
    };
    await appendVoiceEvent(client, event);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.table).toBe("voice_events");
    const row = upserts[0]?.row ?? {};
    expect(row.merchant_id).toBe(MERCHANT_ID);
    expect(row.event_type).toBe("storefront_fetched");
    expect(row.source).toBe("install_orchestrator");
    expect(row.occurred_at).toBe(NOW);
  });

  it("passes ignoreDuplicates:true so duplicate appends silently no-op", async () => {
    const { client, upserts } = makeMockClient();
    await appendVoiceEvent(client, {
      merchantId: MERCHANT_ID,
      eventType: "pii_redacted",
      source: "install_orchestrator",
      occurredAt: NOW,
      payload: {
        snapshot_id: SNAPSHOT_ID,
        pii_match_summary: { email: 1, phone: 0, name: 2, social: 0 },
      },
    });
    expect((upserts[0]?.opts as { ignoreDuplicates?: boolean })?.ignoreDuplicates).toBe(true);
  });

  it("accepts every defined event type", async () => {
    const { client } = makeMockClient();
    const variants: VoiceEventInput[] = [
      {
        merchantId: MERCHANT_ID,
        eventType: "voice_extracted",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: {
          version_id: VERSION_ID,
          snapshot_id: SNAPSHOT_ID,
          model_version: "claude-sonnet-4-6-test",
          prompt_version: "57ffb74af71b3063",
          tokens_input: 1200,
          tokens_output: 350,
          retries: 0,
        },
      },
      {
        merchantId: MERCHANT_ID,
        eventType: "voice_edited",
        source: "settings_edit",
        occurredAt: NOW,
        payload: { version_id: VERSION_ID_2, previous_version_id: VERSION_ID, fields_changed: ["register"] },
      },
      {
        merchantId: MERCHANT_ID,
        eventType: "voice_activated",
        source: "settings_activate",
        occurredAt: NOW,
        payload: { version_id: VERSION_ID, previous_version_id: VERSION_ID_2 },
      },
      {
        merchantId: MERCHANT_ID,
        eventType: "extraction_failed",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: { phase: "synthesize", reason: "exhausted_retries", attempt: 3 },
      },
    ];
    for (const v of variants) {
      await expect(appendVoiceEvent(client, v)).resolves.toBeUndefined();
    }
  });
});

describe("appendVoiceEvent — payload validation rejects malformed input", () => {
  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeMockClient();
    await expect(
      appendVoiceEvent(client, {
        merchantId: "not-a-uuid",
        eventType: "storefront_fetched",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: { snapshot_id: SNAPSHOT_ID, byte_count: 0, source_hash: "a".repeat(64) },
      }),
    ).rejects.toThrow();
  });

  it("rejects a non-ISO occurredAt", async () => {
    const { client } = makeMockClient();
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "storefront_fetched",
        source: "install_orchestrator",
        occurredAt: "yesterday",
        payload: { snapshot_id: SNAPSHOT_ID, byte_count: 0, source_hash: "a".repeat(64) },
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown source", async () => {
    const { client } = makeMockClient();
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "storefront_fetched",
        source: "rogue_caller" as never,
        occurredAt: NOW,
        payload: { snapshot_id: SNAPSHOT_ID, byte_count: 0, source_hash: "a".repeat(64) },
      }),
    ).rejects.toThrow();
  });

  it("rejects negative byte_count on storefront_fetched", async () => {
    const { client } = makeMockClient();
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "storefront_fetched",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: { snapshot_id: SNAPSHOT_ID, byte_count: -1, source_hash: "a".repeat(64) },
      }),
    ).rejects.toThrow();
  });

  it("rejects pii_redacted payload with a non-numeric summary value", async () => {
    const { client } = makeMockClient();
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "pii_redacted",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: {
          snapshot_id: SNAPSHOT_ID,
          pii_match_summary: { email: "many" as unknown as number, phone: 0, name: 0, social: 0 },
        },
      }),
    ).rejects.toThrow();
  });

  it("propagates a Supabase error from the upsert", async () => {
    const { client } = makeMockClient({ message: "rls denied" });
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "storefront_fetched",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: { snapshot_id: SNAPSHOT_ID, byte_count: 0, source_hash: "a".repeat(64) },
      }),
    ).rejects.toMatchObject({ message: "rls denied" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// materializeVoice — replays voice_events and writes agent_profiles
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRow {
  payload: unknown;
  occurred_at: string;
}

interface MaterializeOpts {
  activated?: FakeRow | null;
  extracted?: FakeRow | null;
  versionExists?: boolean;
  upsertError?: { message: string };
}

function makeMaterializeClient(opts: MaterializeOpts) {
  const upserts: UpsertCall[] = [];

  type Builder = {
    select: (...args: unknown[]) => Builder;
    eq: (col: string, val: string) => Builder;
    order: (...args: unknown[]) => Builder;
    limit: (...args: unknown[]) => Builder;
    maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    upsert: (row: Record<string, unknown>, upsertOpts: unknown) => Promise<{ data: null; error: unknown }>;
    insert: (...args: unknown[]) => unknown;
  };

  const buildChain = (table: string): Builder => {
    let eventTypeFilter: string | null = null;
    const chain: Builder = {
      select: () => chain,
      eq: (col, val) => {
        if (col === "event_type") eventTypeFilter = val;
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => {
        if (table === "voice_events") {
          if (eventTypeFilter === "voice_activated") {
            return Promise.resolve({ data: opts.activated ?? null, error: null });
          }
          if (eventTypeFilter === "voice_extracted") {
            return Promise.resolve({ data: opts.extracted ?? null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        if (table === "voice_versions") {
          return Promise.resolve({
            data: opts.versionExists === false ? null : { id: "x" },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      upsert: (row, upsertOpts) => {
        upserts.push({ table, row, opts: upsertOpts });
        return Promise.resolve(
          opts.upsertError
            ? { data: null, error: opts.upsertError }
            : { data: null, error: null },
        );
      },
      insert: () => chain,
    };
    return chain;
  };

  const client = {
    from: vi.fn((table: string) => buildChain(table)),
  } as unknown as LapsedSupabaseClient;
  return { client, upserts };
}

describe("materializeVoice", () => {
  it("returns null when no voice events exist for the merchant", async () => {
    const { client, upserts } = makeMaterializeClient({ activated: null, extracted: null });
    const result = await materializeVoice(client, MERCHANT_ID);
    expect(result.activeVoiceVersionId).toBeNull();
    expect(upserts).toHaveLength(0);
  });

  it("uses the latest voice_extracted version when no voice_activated exists", async () => {
    const { client, upserts } = makeMaterializeClient({
      activated: null,
      extracted: {
        payload: {
          version_id: VERSION_ID,
          snapshot_id: SNAPSHOT_ID,
          model_version: "claude-sonnet-4-6-test",
          prompt_version: "p",
          tokens_input: 1,
          tokens_output: 1,
          retries: 0,
        },
        occurred_at: NOW,
      },
    });
    const result = await materializeVoice(client, MERCHANT_ID);
    expect(result.activeVoiceVersionId).toBe(VERSION_ID);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.row.merchant_id).toBe(MERCHANT_ID);
    expect(upserts[0]?.row.active_voice_version_id).toBe(VERSION_ID);
  });

  it("prefers the latest voice_activated over the latest voice_extracted", async () => {
    const { client, upserts } = makeMaterializeClient({
      activated: {
        payload: { version_id: VERSION_ID_2, previous_version_id: VERSION_ID },
        occurred_at: NOW,
      },
      extracted: {
        payload: {
          version_id: VERSION_ID,
          snapshot_id: SNAPSHOT_ID,
          model_version: "x",
          prompt_version: "p",
          tokens_input: 1,
          tokens_output: 1,
          retries: 0,
        },
        occurred_at: NOW,
      },
    });
    const result = await materializeVoice(client, MERCHANT_ID);
    expect(result.activeVoiceVersionId).toBe(VERSION_ID_2);
    expect(upserts[0]?.row.active_voice_version_id).toBe(VERSION_ID_2);
  });

  it("returns null and does NOT upsert when the referenced version is missing (FK backstop)", async () => {
    const { client, upserts } = makeMaterializeClient({
      activated: {
        payload: { version_id: VERSION_ID, previous_version_id: null },
        occurred_at: NOW,
      },
      versionExists: false,
    });
    const result = await materializeVoice(client, MERCHANT_ID);
    expect(result.activeVoiceVersionId).toBeNull();
    expect(upserts).toHaveLength(0);
  });

  it("upserts on conflict(merchant_id) so re-running preserves role_descriptor / channel_prefs", async () => {
    const { client, upserts } = makeMaterializeClient({
      activated: null,
      extracted: {
        payload: {
          version_id: VERSION_ID,
          snapshot_id: SNAPSHOT_ID,
          model_version: "x",
          prompt_version: "p",
          tokens_input: 1,
          tokens_output: 1,
          retries: 0,
        },
        occurred_at: NOW,
      },
    });
    await materializeVoice(client, MERCHANT_ID);
    expect((upserts[0]?.opts as { onConflict?: string })?.onConflict).toBe("merchant_id");
    // Only writes the pointer, not the other fields — preserves merchant edits.
    expect(Object.keys(upserts[0]?.row ?? {})).toEqual(
      expect.arrayContaining(["merchant_id", "active_voice_version_id"]),
    );
    expect(upserts[0]?.row.role_descriptor).toBeUndefined();
  });

  it("idempotency — running twice with the same events produces the same upsert payload", async () => {
    const opts = {
      activated: null,
      extracted: {
        payload: {
          version_id: VERSION_ID,
          snapshot_id: SNAPSHOT_ID,
          model_version: "x",
          prompt_version: "p",
          tokens_input: 1,
          tokens_output: 1,
          retries: 0,
        },
        occurred_at: NOW,
      },
    };
    const first = makeMaterializeClient(opts);
    const second = makeMaterializeClient(opts);
    const a = await materializeVoice(first.client, MERCHANT_ID);
    const b = await materializeVoice(second.client, MERCHANT_ID);
    expect(a).toEqual(b);
    expect(first.upserts[0]?.row).toEqual(second.upserts[0]?.row);
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeMaterializeClient({});
    await expect(materializeVoice(client, "not-a-uuid")).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// insertVoiceVersion — version_number monotonicity + profile validation
// ─────────────────────────────────────────────────────────────────────────────

function makeInsertClient(opts: {
  latestVersionNumber?: number | null;
  insertReturnId?: string;
  insertReturnVersionNumber?: number;
  insertError?: { message: string };
}) {
  let insertedRow: Record<string, unknown> | null = null;
  const fromHandler = (table: string) => {
    if (table === "voice_versions") {
      let isSelect = false;
      const chain = {
        select: () => {
          isSelect = true;
          return chain;
        },
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          if (isSelect) {
            return Promise.resolve({
              data:
                opts.latestVersionNumber == null
                  ? null
                  : { version_number: opts.latestVersionNumber },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert: vi.fn((row: Record<string, unknown>) => {
          insertedRow = row;
          const insertChain = {
            select: () => insertChain,
            single: () =>
              Promise.resolve(
                opts.insertError
                  ? { data: null, error: opts.insertError }
                  : {
                      data: {
                        id: opts.insertReturnId ?? "new-version-id",
                        version_number:
                          opts.insertReturnVersionNumber ??
                          ((opts.latestVersionNumber ?? 0) + 1),
                      },
                      error: null,
                    },
              ),
          };
          return insertChain;
        }),
      };
      return chain;
    }
    throw new Error(`unexpected table: ${table}`);
  };
  const client = { from: vi.fn(fromHandler) } as unknown as LapsedSupabaseClient;
  return { client, get insertedRow() { return insertedRow; } };
}

describe("insertVoiceVersion", () => {
  it("computes version_number = max + 1 when prior versions exist", async () => {
    const ctx = makeInsertClient({ latestVersionNumber: 3 });
    const result = await insertVoiceVersion(ctx.client, {
      merchantId: MERCHANT_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      profile: VALID_PROFILE_FOR_INSERT,
      modelVersion: "x",
      promptVersion: "p",
      tokensInput: 100,
      tokensOutput: 200,
      retries: 0,
    });
    expect(result.versionNumber).toBe(4);
    expect(ctx.insertedRow?.version_number).toBe(4);
  });

  it("computes version_number = 1 when no prior versions exist", async () => {
    const ctx = makeInsertClient({ latestVersionNumber: null });
    const result = await insertVoiceVersion(ctx.client, {
      merchantId: MERCHANT_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      profile: VALID_PROFILE_FOR_INSERT,
      modelVersion: "x",
      promptVersion: "p",
      tokensInput: 100,
      tokensOutput: 200,
      retries: 0,
    });
    expect(result.versionNumber).toBe(1);
  });

  it("rejects an invalid profile shape before any DB call", async () => {
    const ctx = makeInsertClient({});
    await expect(
      insertVoiceVersion(ctx.client, {
        merchantId: MERCHANT_ID,
        sourceSnapshotId: SNAPSHOT_ID,
        profile: { ...VALID_PROFILE, tone_descriptors: ["bogus_tone"] } as unknown as import("../src/voice-synthesizer").VoiceProfile,
        modelVersion: "x",
        promptVersion: "p",
        tokensInput: 0,
        tokensOutput: 0,
        retries: 0,
      }),
    ).rejects.toThrow();
  });

  it("persists model_version + prompt_version + retries + tokens on the inserted row", async () => {
    const ctx = makeInsertClient({ latestVersionNumber: 0 });
    await insertVoiceVersion(ctx.client, {
      merchantId: MERCHANT_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      profile: VALID_PROFILE_FOR_INSERT,
      modelVersion: "claude-sonnet-4-6-test",
      promptVersion: "57ffb74af71b3063",
      tokensInput: 1234,
      tokensOutput: 567,
      retries: 2,
    });
    expect(ctx.insertedRow).toMatchObject({
      merchant_id: MERCHANT_ID,
      source_snapshot_id: SNAPSHOT_ID,
      model_version: "claude-sonnet-4-6-test",
      prompt_version: "57ffb74af71b3063",
      tokens_input: 1234,
      tokens_output: 567,
      retries: 2,
    });
  });

  it("retries on 23505 unique-violation and succeeds on the next attempt", async () => {
    // Mock a client that returns 23505 on the first insert and succeeds on the second.
    let insertCalls = 0;
    let maxReadCalls = 0;
    const inserts: Record<string, unknown>[] = [];
    const client = {
      from: vi.fn(() => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => {
            maxReadCalls++;
            // Simulate that after the first 23505, another writer landed version 4,
            // so the second max-read returns 4 (next attempt picks 5).
            return Promise.resolve({
              data: { version_number: maxReadCalls === 1 ? 3 : 4 },
              error: null,
            });
          },
          insert: (row: Record<string, unknown>) => {
            inserts.push(row);
            insertCalls++;
            return {
              select: () => ({
                single: () =>
                  Promise.resolve(
                    insertCalls === 1
                      ? { data: null, error: { code: "23505", message: "duplicate key" } }
                      : { data: { id: "new-id", version_number: 5 }, error: null },
                  ),
              }),
            };
          },
        };
        return chain;
      }),
    } as unknown as LapsedSupabaseClient;

    const result = await insertVoiceVersion(client, {
      merchantId: MERCHANT_ID,
      sourceSnapshotId: SNAPSHOT_ID,
      profile: VALID_PROFILE_FOR_INSERT,
      modelVersion: "x",
      promptVersion: "p",
      tokensInput: 0,
      tokensOutput: 0,
      retries: 0,
    });
    expect(insertCalls).toBe(2);
    expect(inserts[0]?.version_number).toBe(4);
    expect(inserts[1]?.version_number).toBe(5);
    expect(result.versionNumber).toBe(5);
  });

  it("does NOT retry on a non-23505 insert error — surfaces it directly", async () => {
    const client = {
      from: vi.fn(() => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: null, error: { code: "23503", message: "fk fail" } }),
            }),
          }),
        };
        return chain;
      }),
    } as unknown as LapsedSupabaseClient;
    await expect(
      insertVoiceVersion(client, {
        merchantId: MERCHANT_ID,
        sourceSnapshotId: SNAPSHOT_ID,
        profile: VALID_PROFILE_FOR_INSERT,
        modelVersion: "x",
        promptVersion: "p",
        tokensInput: 0,
        tokensOutput: 0,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decision 10 — strict payload schemas prevent extra fields carrying PII
// ─────────────────────────────────────────────────────────────────────────────

describe("decision 10 — strict payload schemas reject extra fields", () => {
  it("pii_redacted payload with an extra `raw_emails` field is rejected", async () => {
    const { client } = makeMockClient();
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "pii_redacted",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: {
          snapshot_id: SNAPSHOT_ID,
          pii_match_summary: { email: 1, phone: 0, name: 0, social: 0 },
          // Adversarial extra field carrying actual PII content.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          raw_emails: ["leak@example.com"],
        } as never,
      }),
    ).rejects.toThrow();
  });

  it("voice_extracted payload with an extra `prompt_text` field is rejected", async () => {
    const { client } = makeMockClient();
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "voice_extracted",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: {
          version_id: VERSION_ID,
          snapshot_id: SNAPSHOT_ID,
          model_version: "x",
          prompt_version: "p",
          tokens_input: 100,
          tokens_output: 50,
          retries: 0,
          prompt_text: "redacted but should not be persisted",
        } as never,
      }),
    ).rejects.toThrow();
  });

  it("the persisted payload contains ONLY enumerated fields (parsed value, not input)", async () => {
    const { client, upserts } = makeMockClient();
    await appendVoiceEvent(client, {
      merchantId: MERCHANT_ID,
      eventType: "storefront_fetched",
      source: "install_orchestrator",
      occurredAt: NOW,
      payload: { snapshot_id: SNAPSHOT_ID, byte_count: 100, source_hash: "a".repeat(64) },
    });
    expect(Object.keys(upserts[0]?.row.payload as object).sort()).toEqual(
      ["byte_count", "snapshot_id", "source_hash"],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-event-type payload validation rejections (decision 10 + decision 7/12)
// ─────────────────────────────────────────────────────────────────────────────

describe("per-event-type rejection coverage", () => {
  const { client } = makeMockClient();
  it("voice_extracted rejects non-UUID version_id", async () => {
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "voice_extracted",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: {
          version_id: "not-a-uuid",
          snapshot_id: SNAPSHOT_ID,
          model_version: "x",
          prompt_version: "p",
          tokens_input: 0,
          tokens_output: 0,
          retries: 0,
        },
      }),
    ).rejects.toThrow();
  });

  it("voice_activated rejects non-UUID/null previous_version_id", async () => {
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "voice_activated",
        source: "settings_activate",
        occurredAt: NOW,
        payload: {
          version_id: VERSION_ID,
          previous_version_id: 0 as unknown as string,
        },
      }),
    ).rejects.toThrow();
  });

  it("extraction_failed rejects an out-of-enum phase", async () => {
    await expect(
      appendVoiceEvent(client, {
        merchantId: MERCHANT_ID,
        eventType: "extraction_failed",
        source: "install_orchestrator",
        occurredAt: NOW,
        payload: {
          phase: "unknown" as never,
          reason: "x",
        },
      }),
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// materializeVoice — error propagation (each Supabase failure point)
// ─────────────────────────────────────────────────────────────────────────────

describe("materializeVoice — error propagation", () => {
  it("propagates an error from the voice_events select", async () => {
    const client = {
      from: vi.fn(() => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: null, error: { message: "db down" } }),
        };
        return chain;
      }),
    } as unknown as LapsedSupabaseClient;
    await expect(materializeVoice(client, MERCHANT_ID)).rejects.toMatchObject({
      message: "db down",
    });
  });

  it("propagates an error from the agent_profiles upsert", async () => {
    const { client } = makeMaterializeClient({
      activated: null,
      extracted: {
        payload: {
          version_id: VERSION_ID,
          snapshot_id: SNAPSHOT_ID,
          model_version: "x",
          prompt_version: "p",
          tokens_input: 1,
          tokens_output: 1,
          retries: 0,
        },
        occurred_at: NOW,
      },
      upsertError: { message: "rls denied" },
    });
    await expect(materializeVoice(client, MERCHANT_ID)).rejects.toMatchObject({
      message: "rls denied",
    });
  });
});
