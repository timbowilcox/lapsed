import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import {
  appendCampaignEvent,
  materializeCampaign,
  getReadyCampaigns,
  CampaignEventType,
  type CampaignEventInput,
} from "../src/campaign-events";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const MERCHANT_ID_2 = "660e8400-e29b-41d4-a716-446655440000";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID_2 = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-05-16T10:30:00.000Z";

// ─────────────────────────────────────────────────────────────────────────────
// Filter/order-aware mock client
// ─────────────────────────────────────────────────────────────────────────────

interface MockConfig {
  campaignEventsRows?: Array<Record<string, unknown>>;
  campaignProposalsRows?: Array<Record<string, unknown>>;
  /** Row returned by the campaign_proposals UPDATE ... .select().maybeSingle(). */
  proposalRow?: Record<string, unknown> | null;
  upsertError?: { message: string };
  updateError?: { message: string };
  eventsSelectError?: { message: string };
  proposalsSelectError?: { message: string };
}

interface UpsertCall {
  table: string;
  row: Record<string, unknown>;
  opts: unknown;
}
interface UpdateCall {
  table: string;
  row: Record<string, unknown>;
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function makeMockClient(config: MockConfig = {}) {
  const upserts: UpsertCall[] = [];
  const updates: UpdateCall[] = [];
  const proposalRow =
    config.proposalRow === undefined ? { version_number: 1 } : config.proposalRow;

  function queryBuilder(table: string, op: "select" | "update") {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const orders: Array<[string, boolean]> = [];
    let wantsMaybeSingle = false;
    let wantsSingle = false;

    function execute() {
      if (op === "update") {
        if (config.updateError) return { data: null, error: config.updateError };
        if (wantsMaybeSingle || wantsSingle) return { data: proposalRow, error: null };
        return { data: proposalRow ? [proposalRow] : [], error: null };
      }
      // select
      const err =
        table === "campaign_events" ? config.eventsSelectError : config.proposalsSelectError;
      if (err) return { data: null, error: err };
      let rows = (
        table === "campaign_events"
          ? config.campaignEventsRows
          : config.campaignProposalsRows
      ) ?? [];
      rows = rows.slice();
      for (const [col, val] of eqs) rows = rows.filter((r) => r[col] === val);
      for (const [col, vals] of ins) rows = rows.filter((r) => vals.includes(r[col]));
      // Apply orders least-significant-first; stable sort makes the first
      // .order() call the primary key — matching PostgREST semantics.
      for (let i = orders.length - 1; i >= 0; i--) {
        const [col, asc] = orders[i]!;
        rows.sort((a, b) => cmp(a[col], b[col]) * (asc ? 1 : -1));
      }
      if (wantsMaybeSingle || wantsSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    const qb: Record<string, unknown> = {};
    qb.eq = (col: string, val: unknown) => {
      eqs.push([col, val]);
      return qb;
    };
    qb.in = (col: string, vals: unknown[]) => {
      ins.push([col, vals]);
      return qb;
    };
    qb.order = (col: string, opts?: { ascending?: boolean }) => {
      orders.push([col, opts?.ascending ?? true]);
      return qb;
    };
    qb.select = () => qb;
    qb.single = () => {
      wantsSingle = true;
      return qb;
    };
    qb.maybeSingle = () => {
      wantsMaybeSingle = true;
      return qb;
    };
    qb.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(execute()));
    return qb;
  }

  const client = {
    from: vi.fn((table: string) => ({
      upsert: vi.fn((row: Record<string, unknown>, opts: unknown) => {
        upserts.push({ table, row, opts });
        return Promise.resolve(
          config.upsertError ? { data: null, error: config.upsertError } : { data: null, error: null },
        );
      }),
      update: vi.fn((row: Record<string, unknown>) => {
        updates.push({ table, row });
        return queryBuilder(table, "update");
      }),
      select: vi.fn(() => queryBuilder(table, "select")),
    })),
  } as unknown as LapsedSupabaseClient;

  return { client, upserts, updates };
}

function eventRow(
  eventType: string,
  occurredAt: string,
  opts: {
    id?: string;
    merchantId?: string;
    proposalId?: string;
    ingestedAt?: string;
    payload?: Record<string, unknown>;
  } = {},
) {
  return {
    id: opts.id ?? `evt-${eventType}-${occurredAt}`,
    merchant_id: opts.merchantId ?? MERCHANT_ID,
    proposal_id: opts.proposalId ?? PROPOSAL_ID,
    event_type: eventType,
    occurred_at: occurredAt,
    ingested_at: opts.ingestedAt ?? occurredAt,
    payload: opts.payload ?? {},
  };
}

function proposalRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    merchant_id: MERCHANT_ID,
    group_slug: "lapsed_vips",
    version_number: 1,
    model_version: "claude-sonnet-4-6",
    ...overrides,
  };
}

/**
 * Calls appendCampaignEvent with an `unknown`-typed event so a deliberately
 * invalid payload can be passed to exercise the runtime Zod rejection without
 * a compile-time error.
 */
function appendRaw(client: LapsedSupabaseClient, event: unknown): Promise<void> {
  return appendCampaignEvent(client, event as CampaignEventInput);
}

// ─────────────────────────────────────────────────────────────────────────────
// appendCampaignEvent — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("appendCampaignEvent — happy path", () => {
  it("writes a campaign_proposed event in the DB column shape", async () => {
    const { client, upserts } = makeMockClient();
    const event: CampaignEventInput = {
      eventType: "campaign_proposed",
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      occurredAt: NOW,
      payload: {
        variant_count: 3,
        model_version: "claude-sonnet-4-6",
        tokens_input: 1200,
        tokens_output: 800,
        retries: 0,
      },
    };
    await appendCampaignEvent(client, event);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.table).toBe("campaign_events");
    expect(upserts[0]!.row).toEqual({
      merchant_id: MERCHANT_ID,
      proposal_id: PROPOSAL_ID,
      event_type: "campaign_proposed",
      payload: {
        variant_count: 3,
        model_version: "claude-sonnet-4-6",
        tokens_input: 1200,
        tokens_output: 800,
        retries: 0,
      },
      occurred_at: NOW,
    });
  });

  it("writes a proposal_started event with an empty payload", async () => {
    const { client, upserts } = makeMockClient();
    await appendCampaignEvent(client, {
      eventType: "proposal_started",
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      occurredAt: NOW,
      payload: {},
    });
    expect(upserts[0]!.row.payload).toEqual({});
  });

  it("writes an arms_initialized event with the arm count", async () => {
    const { client, upserts } = makeMockClient();
    await appendCampaignEvent(client, {
      eventType: "arms_initialized",
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      occurredAt: NOW,
      payload: { arm_count: 3 },
    });
    expect(upserts[0]!.row.payload).toEqual({ arm_count: 3 });
  });

  it("writes a proposal_edited event with the diff payload", async () => {
    const { client, upserts } = makeMockClient();
    await appendCampaignEvent(client, {
      eventType: "proposal_edited",
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      occurredAt: NOW,
      payload: {
        user_id: "user_1",
        new_proposal_id: PROPOSAL_ID_2,
        fields_changed: ["message_draft", "offer_value"],
      },
    });
    expect(upserts[0]!.row.payload).toEqual({
      user_id: "user_1",
      new_proposal_id: PROPOSAL_ID_2,
      fields_changed: ["message_draft", "offer_value"],
    });
  });

  it("uses ON CONFLICT DO NOTHING on the dedup key for idempotency", async () => {
    const { client, upserts } = makeMockClient();
    await appendCampaignEvent(client, {
      eventType: "proposal_started",
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      occurredAt: NOW,
      payload: {},
    });
    expect(upserts[0]!.opts).toEqual({
      onConflict: "merchant_id,proposal_id,event_type,occurred_at",
      ignoreDuplicates: true,
    });
  });

  it("persists campaign_approved with the approving user id", async () => {
    const { client, upserts } = makeMockClient();
    await appendCampaignEvent(client, {
      eventType: "campaign_approved",
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      occurredAt: NOW,
      payload: { user_id: "user_42" },
    });
    expect(upserts[0]!.row.payload).toEqual({ user_id: "user_42" });
  });

  it("persists campaign_rejected with user id and reason", async () => {
    const { client, upserts } = makeMockClient();
    await appendCampaignEvent(client, {
      eventType: "campaign_rejected",
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      occurredAt: NOW,
      payload: { user_id: "user_42", reason: "offer too aggressive" },
    });
    expect(upserts[0]!.row.payload).toEqual({
      user_id: "user_42",
      reason: "offer too aggressive",
    });
  });

  it("persists proposal_failed with phase and reason", async () => {
    const { client, upserts } = makeMockClient();
    await appendCampaignEvent(client, {
      eventType: "proposal_failed",
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      occurredAt: NOW,
      payload: { phase: "cap_check", reason: "daily_cap_exhausted" },
    });
    expect(upserts[0]!.row.payload).toEqual({
      phase: "cap_check",
      reason: "daily_cap_exhausted",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendCampaignEvent — validation
// ─────────────────────────────────────────────────────────────────────────────

describe("appendCampaignEvent — validation", () => {
  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCampaignEvent(client, {
        eventType: "proposal_started",
        merchantId: "nope",
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: {},
      }),
    ).rejects.toThrow(/merchantId/);
  });

  it("rejects a non-UUID proposalId", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCampaignEvent(client, {
        eventType: "proposal_started",
        merchantId: MERCHANT_ID,
        proposalId: "nope",
        occurredAt: NOW,
        payload: {},
      }),
    ).rejects.toThrow(/proposalId/);
  });

  it("rejects a non-ISO occurredAt", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCampaignEvent(client, {
        eventType: "proposal_started",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: "yesterday",
        payload: {},
      }),
    ).rejects.toThrow(/occurredAt/);
  });

  it("rejects a campaign_proposed payload missing variant_count", async () => {
    const { client } = makeMockClient();
    await expect(
      appendRaw(client, {
        eventType: "campaign_proposed",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: { model_version: "x", tokens_input: 1, tokens_output: 1, retries: 0 },
      }),
    ).rejects.toThrow();
  });

  it("rejects a proposal_edited payload with a non-UUID new_proposal_id", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCampaignEvent(client, {
        eventType: "proposal_edited",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: { user_id: "u1", new_proposal_id: "not-a-uuid", fields_changed: [] },
      }),
    ).rejects.toThrow();
  });

  it("rejects a proposal_failed payload with an unknown phase", async () => {
    const { client } = makeMockClient();
    await expect(
      appendRaw(client, {
        eventType: "proposal_failed",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: { phase: "made_up_phase", reason: "x" },
      }),
    ).rejects.toThrow();
  });

  it(".strict() rejects an extra field on campaign_approved (no PII rides along)", async () => {
    const { client } = makeMockClient();
    await expect(
      appendRaw(client, {
        eventType: "campaign_approved",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: { user_id: "user_1", customer_phone: "+15551234567" },
      }),
    ).rejects.toThrow();
  });

  it(".strict() rejects an extra field on proposal_started's empty payload", async () => {
    const { client } = makeMockClient();
    await expect(
      appendRaw(client, {
        eventType: "proposal_started",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: { customer_email: "x@y.com" },
      }),
    ).rejects.toThrow();
  });

  it(".strict() rejects an extra field on campaign_rejected", async () => {
    const { client } = makeMockClient();
    await expect(
      appendRaw(client, {
        eventType: "campaign_rejected",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: { user_id: "u1", reason: "x", customer_name: "Jane Doe" },
      }),
    ).rejects.toThrow();
  });

  it(".strict() rejects an extra field on campaign_proposed", async () => {
    const { client } = makeMockClient();
    await expect(
      appendRaw(client, {
        eventType: "campaign_proposed",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: {
          variant_count: 3,
          model_version: "m",
          tokens_input: 1,
          tokens_output: 1,
          retries: 0,
          message_draft: "leaked SMS copy",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects a campaign_rejected reason longer than 500 chars", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCampaignEvent(client, {
        eventType: "campaign_rejected",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: { user_id: "u1", reason: "x".repeat(501) },
      }),
    ).rejects.toThrow();
  });

  it("propagates a Postgres write error", async () => {
    const { client } = makeMockClient({ upsertError: { message: "insert failed" } });
    await expect(
      appendCampaignEvent(client, {
        eventType: "proposal_started",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        payload: {},
      }),
    ).rejects.toThrow(/insert failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// materializeCampaign — status derivation
// ─────────────────────────────────────────────────────────────────────────────

describe("materializeCampaign — status derivation", () => {
  it("derives 'approved' when the latest event is campaign_approved", async () => {
    const { client, updates } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { payload: { user_id: "user_9" } }),
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z"),
      ],
      proposalRow: { version_number: 2 },
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("approved");
    expect(state.versionNumber).toBe(2);
    expect(state.approvedAt).toBe("2026-05-16T12:00:00.000Z");
    expect(state.approvedByUserId).toBe("user_9");
    expect(state.rejectedAt).toBeNull();
    expect(state.latestEventType).toBe("campaign_approved");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.table).toBe("campaign_proposals");
    expect(updates[0]!.row).toMatchObject({
      status: "approved",
      approved_at: "2026-05-16T12:00:00.000Z",
      approved_by_user_id: "user_9",
      rejected_at: null,
      rejection_reason: null,
    });
  });

  it("derives 'rejected' when the latest event is campaign_rejected", async () => {
    const { client, updates } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_rejected", "2026-05-16T13:00:00.000Z", {
          payload: { user_id: "user_9", reason: "wrong group" },
        }),
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z"),
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("rejected");
    expect(state.rejectedAt).toBe("2026-05-16T13:00:00.000Z");
    expect(state.rejectionReason).toBe("wrong group");
    expect(state.approvedAt).toBeNull();
    expect(updates[0]!.row).toMatchObject({ status: "rejected", rejection_reason: "wrong group" });
  });

  it("derives 'edited' when the latest event is proposal_edited", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("proposal_edited", "2026-05-16T14:00:00.000Z", {
          payload: { user_id: "user_9", new_proposal_id: PROPOSAL_ID_2, fields_changed: ["message_draft"] },
        }),
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("edited");
  });

  it("stays 'proposed' when the latest event is campaign_proposed", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("campaign_proposed", NOW)],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("proposed");
  });

  it("stays 'proposed' when the latest event is proposal_failed (no 'failed' status)", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("proposal_failed", "2026-05-16T11:05:00.000Z", {
          payload: { phase: "cap_check", reason: "daily_cap_exhausted" },
        }),
        eventRow("proposal_started", "2026-05-16T11:00:00.000Z"),
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("proposed");
  });

  it("returns the default proposed state when there are no events", async () => {
    const { client, updates } = makeMockClient({ campaignEventsRows: [] });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state).toEqual({
      proposalId: PROPOSAL_ID,
      status: "proposed",
      versionNumber: 1,
      approvedAt: null,
      approvedByUserId: null,
      rejectedAt: null,
      rejectionReason: null,
      latestEventType: null,
    });
    expect(updates).toHaveLength(1);
  });

  it("picks the latest event by occurred_at even when rows are supplied unsorted", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z"),
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { payload: { user_id: "u" } }),
        eventRow("proposal_started", "2026-05-16T10:00:00.000Z"),
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("approved");
  });

  it("tie-breaks two same-occurred_at events by ingested_at (descending)", async () => {
    // Both events share occurred_at; the rejection was ingested later, so it
    // is the latest event and must win.
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", {
          id: "evt-a",
          ingestedAt: "2026-05-16T12:00:00.100Z",
          payload: { user_id: "u" },
        }),
        eventRow("campaign_rejected", "2026-05-16T12:00:00.000Z", {
          id: "evt-b",
          ingestedAt: "2026-05-16T12:00:00.900Z",
          payload: { user_id: "u", reason: "later" },
        }),
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("rejected");
  });

  it("tie-breaks events sharing occurred_at AND ingested_at by id (descending)", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", {
          id: "evt-00000000-aaaa",
          ingestedAt: "2026-05-16T12:00:00.000Z",
          payload: { user_id: "u" },
        }),
        eventRow("campaign_rejected", "2026-05-16T12:00:00.000Z", {
          id: "evt-zzzzzzzz-bbbb",
          ingestedAt: "2026-05-16T12:00:00.000Z",
          payload: { user_id: "u", reason: "highest id wins" },
        }),
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("rejected");
  });

  it("scopes the event read to the merchant — another merchant's events are ignored", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        // belongs to a different merchant — must be filtered out
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", {
          merchantId: MERCHANT_ID_2,
          payload: { user_id: "intruder" },
        }),
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z"),
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    // Only the own-merchant campaign_proposed event is visible → proposed.
    expect(state.status).toBe("proposed");
  });

  it("throws when the proposal does not exist for the merchant", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("campaign_proposed", NOW)],
      proposalRow: null,
    });
    await expect(materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID)).rejects.toThrow(
      /not found for merchant/,
    );
  });

  it("falls back to latestEventType null for an event_type outside the enum", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("gremlin_event", NOW)],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.latestEventType).toBeNull();
    expect(state.status).toBe("proposed");
  });

  it("yields a null approvedByUserId when the campaign_approved payload lacks user_id", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", NOW, { payload: {} }),
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.status).toBe("approved");
    expect(state.approvedByUserId).toBeNull();
  });

  it("yields a null approvedByUserId when the payload is malformed (array)", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        { ...eventRow("campaign_approved", NOW), payload: ["not", "an", "object"] },
      ],
    });
    const state = await materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID);
    expect(state.approvedByUserId).toBeNull();
  });

  it("is idempotent — two runs over the same events yield the same state", async () => {
    const rows = [
      eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { payload: { user_id: "user_9" } }),
    ];
    const a = await materializeCampaign(
      makeMockClient({ campaignEventsRows: rows }).client,
      MERCHANT_ID,
      PROPOSAL_ID,
    );
    const b = await materializeCampaign(
      makeMockClient({ campaignEventsRows: rows }).client,
      MERCHANT_ID,
      PROPOSAL_ID,
    );
    expect(a).toEqual(b);
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeMockClient();
    await expect(materializeCampaign(client, "nope", PROPOSAL_ID)).rejects.toThrow(/merchantId/);
  });

  it("rejects a non-UUID proposalId", async () => {
    const { client } = makeMockClient();
    await expect(materializeCampaign(client, MERCHANT_ID, "nope")).rejects.toThrow(/proposalId/);
  });

  it("propagates a select error", async () => {
    const { client } = makeMockClient({ eventsSelectError: { message: "read failed" } });
    await expect(materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID)).rejects.toThrow(/read failed/);
  });

  it("propagates an update error", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("campaign_proposed", NOW)],
      updateError: { message: "cache write failed" },
    });
    await expect(materializeCampaign(client, MERCHANT_ID, PROPOSAL_ID)).rejects.toThrow(
      /cache write failed/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getReadyCampaigns
// ─────────────────────────────────────────────────────────────────────────────

describe("getReadyCampaigns", () => {
  it("returns proposals whose latest event is campaign_approved", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { payload: { user_id: "u1" } }),
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z"),
      ],
      campaignProposalsRows: [proposalRow(PROPOSAL_ID)],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.proposalId).toBe(PROPOSAL_ID);
    expect(ready[0]!.groupSlug).toBe("lapsed_vips");
    // approvedAt / approvedByUserId are sourced from the event, not the cache.
    expect(ready[0]!.approvedAt).toBe("2026-05-16T12:00:00.000Z");
    expect(ready[0]!.approvedByUserId).toBe("u1");
  });

  it("excludes a proposal whose latest event is campaign_rejected, even with an earlier approval", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { payload: { user_id: "u1" } }),
        eventRow("campaign_rejected", "2026-05-16T13:00:00.000Z", {
          payload: { user_id: "u1", reason: "x" },
        }),
      ],
      campaignProposalsRows: [proposalRow(PROPOSAL_ID)],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toEqual([]);
  });

  it("excludes a proposal whose latest event is proposal_edited", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { payload: { user_id: "u1" } }),
        eventRow("proposal_edited", "2026-05-16T14:00:00.000Z", {
          payload: { user_id: "u1", new_proposal_id: PROPOSAL_ID_2, fields_changed: [] },
        }),
      ],
      campaignProposalsRows: [proposalRow(PROPOSAL_ID)],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toEqual([]);
  });

  it("resolves the latest event correctly from unsorted event rows", async () => {
    // Rows deliberately out of order; the rejection at 13:00 is the latest.
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_rejected", "2026-05-16T13:00:00.000Z", {
          payload: { user_id: "u1", reason: "x" },
        }),
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z"),
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { payload: { user_id: "u1" } }),
      ],
      campaignProposalsRows: [proposalRow(PROPOSAL_ID)],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toEqual([]);
  });

  it("returns only the approved proposal when one of two is approved", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", {
          proposalId: PROPOSAL_ID,
          payload: { user_id: "u1" },
        }),
        eventRow("campaign_proposed", "2026-05-16T11:30:00.000Z", { proposalId: PROPOSAL_ID_2 }),
      ],
      campaignProposalsRows: [proposalRow(PROPOSAL_ID)],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready.map((r) => r.proposalId)).toEqual([PROPOSAL_ID]);
  });

  it("scopes to the merchant — another merchant's approved proposal is excluded", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", {
          merchantId: MERCHANT_ID_2,
          proposalId: PROPOSAL_ID_2,
          payload: { user_id: "intruder" },
        }),
      ],
      campaignProposalsRows: [],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toEqual([]);
  });

  it("returns an empty array when no proposal is approved", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("campaign_proposed", NOW)],
    });
    expect(await getReadyCampaigns(client, MERCHANT_ID)).toEqual([]);
  });

  it("returns an empty array when there are no events at all", async () => {
    const { client } = makeMockClient({ campaignEventsRows: [] });
    expect(await getReadyCampaigns(client, MERCHANT_ID)).toEqual([]);
  });

  it("logs a structured warning when an approved proposal has no campaign_proposals row", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", NOW, { payload: { user_id: "u1" } }),
      ],
      campaignProposalsRows: [], // FK row missing
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("get_ready_campaigns_missing_proposal_rows");
    warnSpy.mockRestore();
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeMockClient();
    await expect(getReadyCampaigns(client, "nope")).rejects.toThrow(/merchantId/);
  });

  it("propagates an event select error", async () => {
    const { client } = makeMockClient({ eventsSelectError: { message: "events read failed" } });
    await expect(getReadyCampaigns(client, MERCHANT_ID)).rejects.toThrow(/events read failed/);
  });

  it("propagates a proposals select error", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("campaign_approved", NOW, { payload: { user_id: "u1" } })],
      proposalsSelectError: { message: "proposals read failed" },
    });
    await expect(getReadyCampaigns(client, MERCHANT_ID)).rejects.toThrow(/proposals read failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CampaignEventType enum
// ─────────────────────────────────────────────────────────────────────────────

describe("CampaignEventType", () => {
  it("enumerates exactly the seven campaign lifecycle events", () => {
    expect(CampaignEventType.options).toEqual([
      "proposal_started",
      "campaign_proposed",
      "arms_initialized",
      "campaign_approved",
      "campaign_rejected",
      "proposal_edited",
      "proposal_failed",
    ]);
  });
});
