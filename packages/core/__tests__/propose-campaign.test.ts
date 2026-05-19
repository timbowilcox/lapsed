import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import type Anthropic from "@anthropic-ai/sdk";
import { proposeCampaign, median } from "../src/propose-campaign";
import type { CampaignVariant } from "../src/campaign-designer";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const VOICE_VERSION_ID = "22222222-2222-4222-8222-222222222222";

const VOICE_PROFILE_JSON = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "medium",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: [],
  signature_phrases: ["small batch"],
  sample_sentences: ["s1", "s2", "s3", "s4", "s5"],
};

function validVariants(): CampaignVariant[] {
  const base = {
    offer_value: "10%",
    message_draft: "We saved your spot — come back soon.",
    expected_impact: { estimated_response_rate: 0.12, estimated_recovered_revenue: 900 },
  };
  return [
    { ...base, offer_type: "percent_discount", send_time_window: "evening", tone: "warm" },
    { ...base, offer_type: "free_shipping", send_time_window: "morning", tone: "direct" },
    { ...base, offer_type: "bundle", send_time_window: "weekend_morning", tone: "playful" },
  ] as CampaignVariant[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Anthropic client
// ─────────────────────────────────────────────────────────────────────────────

function mockAnthropic(
  opts: { variants?: CampaignVariant[]; throwError?: Error; noToolUse?: boolean } = {},
): Anthropic {
  const create = vi.fn(async () => {
    if (opts.throwError) throw opts.throwError;
    const usage = { input_tokens: 1000, output_tokens: 500 };
    if (opts.noToolUse) return { content: [{ type: "text", text: "no tool" }], usage };
    return {
      content: [
        { type: "tool_use", name: "propose_campaign", input: { variants: opts.variants ?? validVariants() } },
      ],
      usage,
    };
  });
  return { messages: { create } } as unknown as Anthropic;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Supabase client — covers every table the orchestrator touches
// ─────────────────────────────────────────────────────────────────────────────

interface SupabaseConfig {
  proposalInsertId?: string;
  proposalInsertError?: { message: string };
  countProposedToday?: number;
  countError?: { message: string };
  /** agent_profiles row; null → no active voice profile. */
  agentProfile?: { active_voice_version_id: string | null } | null;
  /** voice_versions row. */
  voiceVersion?: Record<string, unknown> | null;
  /** customer_inferred_state rows for the group. */
  stateRows?: Array<{ shopify_customer_gid: string; lifecycle_stage: string | null }>;
  stateError?: { message: string };
  /** customer_rfm rows. */
  rfmRows?: Array<{ recency_days: number | null; frequency: number; monetary_cents: number }>;
  armsInsertError?: { message: string };
  eventUpsertError?: { message: string };
  snapshotUpsertError?: { message: string };
}

interface Log {
  proposalInserts: Record<string, unknown>[];
  armInserts: Record<string, unknown>[][];
  eventUpserts: Record<string, unknown>[];
  snapshotUpserts: unknown[];
  proposalUpdates: Record<string, unknown>[];
}

function makeSupabase(c: SupabaseConfig = {}) {
  const log: Log = {
    proposalInserts: [],
    armInserts: [],
    eventUpserts: [],
    snapshotUpserts: [],
    proposalUpdates: [],
  };

  // Thenable query builder; `resolve` computes the {data,error} at await time.
  function builder(resolve: () => unknown) {
    const qb: Record<string, unknown> = {};
    const chain = () => qb;
    qb.eq = chain;
    qb.in = chain;
    qb.contains = chain;
    qb.gte = chain;
    qb.order = chain;
    qb.select = chain;
    qb.single = chain;
    qb.maybeSingle = chain;
    qb.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(onFulfilled(resolve()));
    return qb;
  }

  function fromTable(table: string) {
    return {
      insert: vi.fn((row: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table === "campaign_proposals") {
          log.proposalInserts.push(row as Record<string, unknown>);
          return builder(() =>
            c.proposalInsertError
              ? { data: null, error: c.proposalInsertError }
              : { data: { id: c.proposalInsertId ?? PROPOSAL_ID }, error: null },
          );
        }
        if (table === "campaign_arms") {
          log.armInserts.push(row as Record<string, unknown>[]);
          return builder(() => ({
            data: null,
            error: c.armsInsertError ?? null,
          }));
        }
        return builder(() => ({ data: null, error: null }));
      }),

      upsert: vi.fn((row: unknown) => {
        if (table === "campaign_events") {
          log.eventUpserts.push(row as Record<string, unknown>);
          return Promise.resolve({ data: null, error: c.eventUpsertError ?? null });
        }
        if (table === "campaign_group_snapshots") {
          log.snapshotUpserts.push(row);
          return Promise.resolve({ data: null, error: c.snapshotUpsertError ?? null });
        }
        return Promise.resolve({ data: null, error: null });
      }),

      update: vi.fn((row: Record<string, unknown>) => {
        if (table === "campaign_proposals") log.proposalUpdates.push(row);
        return builder(() => ({ data: { version_number: 1 }, error: null }));
      }),

      select: vi.fn((_cols?: string, selectOpts?: { count?: string; head?: boolean }) => {
        if (table === "campaign_events") {
          if (selectOpts?.head) {
            // countProposedToday
            return builder(() =>
              c.countError
                ? { count: null, error: c.countError }
                : { count: c.countProposedToday ?? 0, error: null },
            );
          }
          // materializeCampaign event replay
          return builder(() => ({ data: [], error: null }));
        }
        if (table === "agent_profiles") {
          return builder(() => ({
            data: c.agentProfile === undefined ? { active_voice_version_id: VOICE_VERSION_ID } : c.agentProfile,
            error: null,
          }));
        }
        if (table === "voice_versions") {
          return builder(() => ({
            data:
              c.voiceVersion === undefined
                ? {
                    id: VOICE_VERSION_ID,
                    version_number: 1,
                    profile: VOICE_PROFILE_JSON,
                    model_version: "claude-sonnet-4-6",
                    extracted_at: "2026-05-01T00:00:00.000Z",
                  }
                : c.voiceVersion,
            error: null,
          }));
        }
        if (table === "customer_inferred_state") {
          return builder(() =>
            c.stateError
              ? { data: null, error: c.stateError }
              : {
                  data:
                    c.stateRows ??
                    [
                      { shopify_customer_gid: "gid://shopify/Customer/1", lifecycle_stage: "lapsed" },
                      { shopify_customer_gid: "gid://shopify/Customer/2", lifecycle_stage: "lapsed" },
                      { shopify_customer_gid: "gid://shopify/Customer/3", lifecycle_stage: "at_risk" },
                    ],
                  error: null,
                },
          );
        }
        if (table === "customer_rfm") {
          return builder(() => ({
            data:
              c.rfmRows ??
              [
                { recency_days: 120, frequency: 3, monetary_cents: 18000 },
                { recency_days: 200, frequency: 2, monetary_cents: 9000 },
                { recency_days: 90, frequency: 1, monetary_cents: 4000 },
              ],
            error: null,
          }));
        }
        return builder(() => ({ data: null, error: null }));
      }),
    };
  }

  const client = { from: vi.fn(fromTable) } as unknown as LapsedSupabaseClient;
  return { client, log };
}

const NOW = () => new Date("2026-05-16T12:00:00.000Z");

function runInput(
  client: LapsedSupabaseClient,
  anthropic: Anthropic,
  overrides: Record<string, unknown> = {},
) {
  return {
    serviceClient: client,
    anthropicClient: anthropic,
    merchantId: MERCHANT_ID,
    groupSlug: "lapsed_vips",
    dailyCapDefault: 5,
    now: NOW,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("proposeCampaign — happy path", () => {
  it("runs the full proposal pipeline and returns ok", async () => {
    const { client } = makeSupabase();
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposalId).toBe(PROPOSAL_ID);
      expect(result.variantCount).toBe(3);
      expect(result.customerCount).toBe(3);
      expect(result.tokensInput).toBe(1000);
      expect(result.tokensOutput).toBe(500);
    }
  });

  it("inserts exactly three campaign_arms variant rows", async () => {
    const { client, log } = makeSupabase();
    await proposeCampaign(runInput(client, mockAnthropic()));
    expect(log.armInserts).toHaveLength(1);
    expect(log.armInserts[0]).toHaveLength(3);
    expect(log.armInserts[0]!.map((r) => r.variant_index)).toEqual([0, 1, 2]);
    expect(log.armInserts[0]!.every((r) => r.proposal_id === PROPOSAL_ID)).toBe(true);
  });

  it("writes proposal_started, campaign_proposed and arms_initialized events", async () => {
    const { client, log } = makeSupabase();
    await proposeCampaign(runInput(client, mockAnthropic()));
    const types = log.eventUpserts.map((e) => e.event_type);
    expect(types).toContain("proposal_started");
    expect(types).toContain("campaign_proposed");
    expect(types).toContain("arms_initialized");
    expect(types).not.toContain("proposal_failed");
  });

  it("the campaign_proposed event payload carries counts + token metadata, no message text", async () => {
    const { client, log } = makeSupabase();
    await proposeCampaign(runInput(client, mockAnthropic()));
    const proposed = log.eventUpserts.find((e) => e.event_type === "campaign_proposed")!;
    const payload = proposed.payload as Record<string, unknown>;
    expect(payload).toEqual({
      variant_count: 3,
      model_version: expect.any(String),
      tokens_input: 1000,
      tokens_output: 500,
      retries: 0,
    });
    expect(JSON.stringify(payload)).not.toContain("come back");
  });

  it("snapshots the group with a deterministic holdout subset", async () => {
    const { client, log } = makeSupabase();
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(log.snapshotUpserts.length).toBeGreaterThan(0);
    if (result.ok) {
      expect(result.holdoutCount).toBeGreaterThanOrEqual(0);
      expect(result.holdoutCount).toBeLessThanOrEqual(result.customerCount);
    }
  });

  it("does NOT write bandit_state — that happens at approval (decision 14)", async () => {
    const { client } = makeSupabase();
    await proposeCampaign(runInput(client, mockAnthropic()));
    const fromMock = client.from as unknown as ReturnType<typeof vi.fn>;
    const tablesTouched = fromMock.mock.calls.map((call) => call[0]);
    expect(tablesTouched).not.toContain("bandit_state");
  });

  it("propagates source: 'manual' to the campaign_proposals insert", async () => {
    const { client, log } = makeSupabase();
    await proposeCampaign(runInput(client, mockAnthropic(), { source: "manual" }));
    expect(log.proposalInserts[0]).toMatchObject({ source: "manual" });
  });

  it("defaults source to 'agent' when not provided", async () => {
    const { client, log } = makeSupabase();
    await proposeCampaign(runInput(client, mockAnthropic()));
    expect(log.proposalInserts[0]).toMatchObject({ source: "agent" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cap exhaustion
// ─────────────────────────────────────────────────────────────────────────────

describe("proposeCampaign — daily cap", () => {
  it("fails with reason cap_check when the merchant is at the cap", async () => {
    const { client, log } = makeSupabase({ countProposedToday: 5 });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("cap_check");
      expect(result.detail).toBe("daily_cap_exhausted");
    }
    // A proposal_failed event is recorded against the row.
    expect(log.eventUpserts.some((e) => e.event_type === "proposal_failed")).toBe(true);
  });

  it("does not call the Anthropic API when capped", async () => {
    const { client } = makeSupabase({ countProposedToday: 9 });
    const anthropic = mockAnthropic();
    await proposeCampaign(runInput(client, anthropic));
    expect((anthropic.messages.create as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("proceeds when proposals today are below the cap", async () => {
    const { client } = makeSupabase({ countProposedToday: 4 });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────────────────────────────────────

describe("proposeCampaign — failure paths", () => {
  it("fails with reason voice_profile when the merchant has no active voice", async () => {
    const { client, log } = makeSupabase({ agentProfile: null });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("voice_profile");
    expect(log.eventUpserts.some((e) => e.event_type === "proposal_failed")).toBe(true);
  });

  it("fails with reason group_fetch when the group has no customers", async () => {
    const { client } = makeSupabase({ stateRows: [] });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("group_fetch");
  });

  it("fails with reason design when the Campaign Designer errors", async () => {
    const { client } = makeSupabase();
    const anthropic = mockAnthropic({ throwError: Object.assign(new Error("bad key"), { status: 401 }) });
    const result = await proposeCampaign(runInput(client, anthropic));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("design");
  });

  it("fails with reason proposal_init when the proposal row cannot be inserted", async () => {
    const { client } = makeSupabase({ proposalInsertError: { message: "insert blew up" } });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("proposal_init");
      expect(result.proposalId).toBeNull();
    }
  });

  it("fails with reason proposal_init when the proposal_started event cannot be written", async () => {
    const { client } = makeSupabase({ eventUpsertError: { message: "event write failed" } });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("proposal_init");
  });

  it("fails with reason proposal_init when the cap-count query errors", async () => {
    const { client } = makeSupabase({ countError: { message: "count query failed" } });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("proposal_init");
  });

  it("fails with reason group_fetch when the customer query errors", async () => {
    const { client } = makeSupabase({ stateError: { message: "state query failed" } });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("group_fetch");
  });

  it("fails with reason redact when PII reaches the group summary (decision 10)", async () => {
    // A regression that let a customer email become a lifecycle-stage value
    // would surface it as a lifecycleCounts key — the PII pre-flight catches it.
    const { client } = makeSupabase({
      stateRows: [
        { shopify_customer_gid: "gid://shopify/Customer/1", lifecycle_stage: "jane.doe@example.com" },
      ],
    });
    const anthropic = mockAnthropic();
    const result = await proposeCampaign(runInput(client, anthropic));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("redact");
    // The PII pre-flight ran before the LLM — Anthropic was never called.
    expect((anthropic.messages.create as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("fails with reason design when the designer exhausts retries (no tool_use block)", async () => {
    const { client } = makeSupabase();
    const result = await proposeCampaign(runInput(client, mockAnthropic({ noToolUse: true })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("design");
  });

  it("fails with reason design when the campaign_arms insert errors", async () => {
    const { client } = makeSupabase({ armsInsertError: { message: "arms insert failed" } });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("design");
  });

  it("fails with reason snapshot when the group snapshot write errors", async () => {
    const { client } = makeSupabase({ snapshotUpsertError: { message: "snapshot failed" } });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("snapshot");
  });

  it("a failed proposal still records a proposalId for audit", async () => {
    const { client } = makeSupabase({ stateRows: [] });
    const result = await proposeCampaign(runInput(client, mockAnthropic()));
    if (!result.ok) expect(result.proposalId).toBe(PROPOSAL_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Holdout determinism
// ─────────────────────────────────────────────────────────────────────────────

describe("proposeCampaign — holdout determinism", () => {
  it("produces an identical holdout count across two runs with the same inputs", async () => {
    const a = await proposeCampaign(runInput(makeSupabase().client, mockAnthropic()));
    const b = await proposeCampaign(runInput(makeSupabase().client, mockAnthropic()));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.holdoutCount).toBe(b.holdoutCount);
      expect(a.customerCount).toBe(b.customerCount);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// median helper
// ─────────────────────────────────────────────────────────────────────────────

describe("median", () => {
  it("returns 0 for an empty list", () => {
    expect(median([])).toBe(0);
  });

  it("returns the middle element of an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle elements of an even-length list", () => {
    expect(median([1, 2, 3, 4])).toBe(3); // round((2+3)/2) = round(2.5) = 3
  });

  it("does not depend on input ordering", () => {
    expect(median([9, 1, 5, 3, 7])).toBe(median([1, 3, 5, 7, 9]));
  });

  it("returns a single element for a one-element list", () => {
    expect(median([42])).toBe(42);
  });
});
