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
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const PROPOSAL_ID_2 = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-05-16T10:30:00.000Z";

// ─────────────────────────────────────────────────────────────────────────────
// Mock client
// ─────────────────────────────────────────────────────────────────────────────

interface MockConfig {
  campaignEventsRows?: Array<Record<string, unknown>>;
  campaignProposalsRows?: Array<Record<string, unknown>>;
  upsertError?: { message: string };
  updateError?: { message: string };
  selectError?: { message: string };
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

function makeMockClient(config: MockConfig = {}) {
  const upserts: UpsertCall[] = [];
  const updates: UpdateCall[] = [];

  function resultFor(table: string, op: "select" | "update") {
    if (op === "select") {
      if (config.selectError) return { data: null, error: config.selectError };
      if (table === "campaign_events") {
        return { data: config.campaignEventsRows ?? [], error: null };
      }
      if (table === "campaign_proposals") {
        return { data: config.campaignProposalsRows ?? [], error: null };
      }
      return { data: [], error: null };
    }
    return { data: null, error: config.updateError ?? null };
  }

  function chainable(table: string, op: "select" | "update") {
    const c: Record<string, unknown> = {};
    const self = (): typeof c => c;
    c.eq = self;
    c.in = self;
    c.order = self;
    c.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resultFor(table, op)).then(resolve);
    return c;
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
        return chainable(table, "update");
      }),
      select: vi.fn(() => chainable(table, "select")),
    })),
  } as unknown as LapsedSupabaseClient;

  return { client, upserts, updates };
}

function eventRow(
  eventType: string,
  occurredAt: string,
  payload: Record<string, unknown> = {},
  proposalId = PROPOSAL_ID,
) {
  return {
    proposal_id: proposalId,
    event_type: eventType,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    payload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// appendCampaignEvent
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
      appendCampaignEvent(client, {
        eventType: "campaign_proposed",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        // @ts-expect-error — intentionally invalid payload
        payload: { model_version: "x", tokens_input: 1, tokens_output: 1, retries: 0 },
      }),
    ).rejects.toThrow();
  });

  it("rejects an extra field on a .strict() payload (no PII can ride along)", async () => {
    const { client } = makeMockClient();
    await expect(
      appendCampaignEvent(client, {
        eventType: "campaign_approved",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
        occurredAt: NOW,
        // @ts-expect-error — extra field must be rejected by .strict()
        payload: { user_id: "user_1", customer_phone: "+15551234567" },
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
// materializeCampaign
// ─────────────────────────────────────────────────────────────────────────────

describe("materializeCampaign — status derivation", () => {
  it("derives 'approved' when the latest event is campaign_approved", async () => {
    const { client, updates } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { user_id: "user_9" }),
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z"),
      ],
    });
    const state = await materializeCampaign(client, PROPOSAL_ID);
    expect(state.status).toBe("approved");
    expect(state.approvedAt).toBe("2026-05-16T12:00:00.000Z");
    expect(state.approvedByUserId).toBe("user_9");
    expect(state.rejectedAt).toBeNull();
    expect(state.latestEventType).toBe("campaign_approved");
    // Projection written back to the materialized cache.
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
          user_id: "user_9",
          reason: "wrong group",
        }),
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z"),
      ],
    });
    const state = await materializeCampaign(client, PROPOSAL_ID);
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
          user_id: "user_9",
          new_proposal_id: PROPOSAL_ID_2,
          fields_changed: ["message_draft"],
        }),
      ],
    });
    const state = await materializeCampaign(client, PROPOSAL_ID);
    expect(state.status).toBe("edited");
  });

  it("stays 'proposed' when the latest event is campaign_proposed", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("campaign_proposed", NOW)],
    });
    const state = await materializeCampaign(client, PROPOSAL_ID);
    expect(state.status).toBe("proposed");
  });

  it("stays 'proposed' when the latest event is proposal_failed (no 'failed' status)", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("proposal_failed", "2026-05-16T11:05:00.000Z", {
          phase: "cap_check",
          reason: "daily_cap_exhausted",
        }),
        eventRow("proposal_started", "2026-05-16T11:00:00.000Z"),
      ],
    });
    const state = await materializeCampaign(client, PROPOSAL_ID);
    expect(state.status).toBe("proposed");
  });

  it("returns the default proposed state when there are no events", async () => {
    const { client, updates } = makeMockClient({ campaignEventsRows: [] });
    const state = await materializeCampaign(client, PROPOSAL_ID);
    expect(state).toEqual({
      proposalId: PROPOSAL_ID,
      status: "proposed",
      approvedAt: null,
      approvedByUserId: null,
      rejectedAt: null,
      rejectionReason: null,
      latestEventType: null,
    });
    // Still writes the projection so the cache is consistent.
    expect(updates).toHaveLength(1);
  });

  it("is idempotent — two runs over the same events yield the same state", async () => {
    const rows = [
      eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { user_id: "user_9" }),
    ];
    const a = await materializeCampaign(makeMockClient({ campaignEventsRows: rows }).client, PROPOSAL_ID);
    const b = await materializeCampaign(makeMockClient({ campaignEventsRows: rows }).client, PROPOSAL_ID);
    expect(a).toEqual(b);
  });

  it("rejects a non-UUID proposalId", async () => {
    const { client } = makeMockClient();
    await expect(materializeCampaign(client, "nope")).rejects.toThrow(/proposalId/);
  });

  it("propagates a select error", async () => {
    const { client } = makeMockClient({ selectError: { message: "read failed" } });
    await expect(materializeCampaign(client, PROPOSAL_ID)).rejects.toThrow(/read failed/);
  });

  it("propagates an update error", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("campaign_proposed", NOW)],
      updateError: { message: "cache write failed" },
    });
    await expect(materializeCampaign(client, PROPOSAL_ID)).rejects.toThrow(/cache write failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getReadyCampaigns
// ─────────────────────────────────────────────────────────────────────────────

describe("getReadyCampaigns", () => {
  it("returns proposals whose latest event is campaign_approved", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { user_id: "u1" }, PROPOSAL_ID),
        eventRow("campaign_proposed", "2026-05-16T11:00:00.000Z", {}, PROPOSAL_ID),
      ],
      campaignProposalsRows: [
        {
          id: PROPOSAL_ID,
          group_slug: "lapsed_vips",
          version_number: 1,
          model_version: "claude-sonnet-4-6",
          approved_at: "2026-05-16T12:00:00.000Z",
          approved_by_user_id: "u1",
        },
      ],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.proposalId).toBe(PROPOSAL_ID);
    expect(ready[0]!.groupSlug).toBe("lapsed_vips");
  });

  it("excludes a proposal whose latest event is campaign_rejected, even with an earlier approval", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        // newest-first: rejection is the latest event for PROPOSAL_ID
        eventRow("campaign_rejected", "2026-05-16T13:00:00.000Z", { user_id: "u1", reason: "x" }),
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { user_id: "u1" }),
      ],
      campaignProposalsRows: [],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toEqual([]);
  });

  it("excludes a proposal whose latest event is proposal_edited", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("proposal_edited", "2026-05-16T14:00:00.000Z", {
          user_id: "u1",
          new_proposal_id: PROPOSAL_ID_2,
          fields_changed: [],
        }),
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { user_id: "u1" }),
      ],
      campaignProposalsRows: [],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toEqual([]);
  });

  it("returns only the approved proposal when one of two is approved", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [
        eventRow("campaign_approved", "2026-05-16T12:00:00.000Z", { user_id: "u1" }, PROPOSAL_ID),
        eventRow("campaign_proposed", "2026-05-16T11:30:00.000Z", {}, PROPOSAL_ID_2),
      ],
      campaignProposalsRows: [
        {
          id: PROPOSAL_ID,
          group_slug: "lapsed_vips",
          version_number: 1,
          model_version: "m",
          approved_at: "2026-05-16T12:00:00.000Z",
          approved_by_user_id: "u1",
        },
      ],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready.map((r) => r.proposalId)).toEqual([PROPOSAL_ID]);
  });

  it("returns an empty array when no proposal is approved", async () => {
    const { client } = makeMockClient({
      campaignEventsRows: [eventRow("campaign_proposed", NOW)],
    });
    const ready = await getReadyCampaigns(client, MERCHANT_ID);
    expect(ready).toEqual([]);
  });

  it("returns an empty array when there are no events at all", async () => {
    const { client } = makeMockClient({ campaignEventsRows: [] });
    expect(await getReadyCampaigns(client, MERCHANT_ID)).toEqual([]);
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeMockClient();
    await expect(getReadyCampaigns(client, "nope")).rejects.toThrow(/merchantId/);
  });

  it("propagates a select error", async () => {
    const { client } = makeMockClient({ selectError: { message: "read failed" } });
    await expect(getReadyCampaigns(client, MERCHANT_ID)).rejects.toThrow(/read failed/);
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
