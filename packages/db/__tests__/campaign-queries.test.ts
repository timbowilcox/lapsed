/**
 * Unit tests for the Sprint 06 campaign proposal read helpers
 * (getCampaignStatus, getPendingProposals, getProposalById).
 *
 * Uses a filter-aware in-memory mock Supabase client — no network or real DB.
 */

import { describe, expect, it } from "vitest";
import type { LapsedSupabaseClient } from "../src/index";
import {
  getCampaignStatus,
  getPendingProposals,
  getProposalById,
  getProposalsByStatus,
} from "../src/queries";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_MERCHANT = "660e8400-e29b-41d4-a716-446655440000";

type Row = Record<string, unknown>;

interface Tables {
  campaign_events?: Row[];
  campaign_proposals?: Row[];
  campaign_arms?: Row[];
  bandit_state?: Row[];
  campaign_group_snapshots?: Row[];
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function makeClient(tables: Tables): LapsedSupabaseClient {
  function builder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    const orders: Array<[string, boolean]> = [];
    let limitN: number | null = null;
    let single = false;

    function run() {
      let rows = ((tables as Record<string, Row[]>)[table] ?? []).slice();
      for (const [c, v] of eqs) rows = rows.filter((r) => r[c] === v);
      for (const [c, vs] of ins) rows = rows.filter((r) => vs.includes(r[c]));
      for (let i = orders.length - 1; i >= 0; i--) {
        const [c, asc] = orders[i]!;
        rows.sort((a, b) => cmp(a[c], b[c]) * (asc ? 1 : -1));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    const qb: Record<string, unknown> = {};
    qb.select = () => qb;
    qb.eq = (c: string, v: unknown) => {
      eqs.push([c, v]);
      return qb;
    };
    qb.in = (c: string, vs: unknown[]) => {
      ins.push([c, vs]);
      return qb;
    };
    qb.order = (c: string, o?: { ascending?: boolean }) => {
      orders.push([c, o?.ascending ?? true]);
      return qb;
    };
    qb.limit = (n: number) => {
      limitN = n;
      return qb;
    };
    qb.maybeSingle = () => {
      single = true;
      return qb;
    };
    qb.single = () => {
      single = true;
      return qb;
    };
    qb.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(run()));
    return qb;
  }
  return { from: (t: string) => builder(t) } as unknown as LapsedSupabaseClient;
}

function ev(
  proposalId: string,
  eventType: string,
  occurredAt: string,
  merchantId = MERCHANT_ID,
  payload: Row = {},
): Row {
  return {
    id: `evt-${eventType}-${occurredAt}`,
    merchant_id: merchantId,
    proposal_id: proposalId,
    event_type: eventType,
    occurred_at: occurredAt,
    ingested_at: occurredAt,
    payload,
  };
}

function proposal(id: string, overrides: Row = {}): Row {
  return {
    id,
    merchant_id: MERCHANT_ID,
    group_slug: "lapsed_vips",
    version_number: 1,
    status: "proposed",
    model_version: "claude-sonnet-4-6",
    generated_at: "2026-05-16T10:00:00.000Z",
    approved_at: null,
    approved_by_user_id: null,
    rejected_at: null,
    rejection_reason: null,
    supersedes_proposal_id: null,
    ...overrides,
  };
}

function arm(proposalId: string, variantIndex: number): Row {
  return {
    id: `arm-${proposalId}-${variantIndex}`,
    bandit_arm_id: `bandit-${proposalId}-${variantIndex}`,
    proposal_id: proposalId,
    merchant_id: MERCHANT_ID,
    variant_index: variantIndex,
    offer_type: "percent_discount",
    offer_value: "10%",
    message_draft: "draft",
    send_time_window: "evening",
    tone: "warm",
    expected_impact: { estimated_response_rate: 0.1, estimated_recovered_revenue: 500 },
  };
}

function snap(proposalId: string, customerId: string, holdout: boolean): Row {
  return {
    proposal_id: proposalId,
    merchant_id: MERCHANT_ID,
    customer_id: customerId,
    included_in_holdout: holdout,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// getCampaignStatus
// ─────────────────────────────────────────────────────────────────────────────

describe("getCampaignStatus", () => {
  it("returns proposed when there are no events", async () => {
    const client = makeClient({ campaign_events: [] });
    expect(await getCampaignStatus(client, MERCHANT_ID, "p1")).toBe("proposed");
  });

  it("returns proposed when the latest event is arms_initialized", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "arms_initialized", "2026-05-16T10:00:02.000Z"),
      ],
    });
    expect(await getCampaignStatus(client, MERCHANT_ID, "p1")).toBe("proposed");
  });

  it("returns approved when the latest event is campaign_approved", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "campaign_approved", "2026-05-16T12:00:00.000Z"),
      ],
    });
    expect(await getCampaignStatus(client, MERCHANT_ID, "p1")).toBe("approved");
  });

  it("returns rejected when the latest event is campaign_rejected", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "campaign_rejected", "2026-05-16T13:00:00.000Z"),
      ],
    });
    expect(await getCampaignStatus(client, MERCHANT_ID, "p1")).toBe("rejected");
  });

  it("returns edited when the latest event is proposal_edited", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "proposal_edited", "2026-05-16T14:00:00.000Z"),
      ],
    });
    expect(await getCampaignStatus(client, MERCHANT_ID, "p1")).toBe("edited");
  });

  it("tie-breaks two same-occurred_at events by ingested_at then id", async () => {
    // Both events share occurred_at; the rejection was ingested later, so it
    // is the latest event and wins.
    const approved = {
      ...ev("p1", "campaign_approved", "2026-05-16T12:00:00.000Z"),
      id: "evt-aaaa",
      ingested_at: "2026-05-16T12:00:00.100Z",
    };
    const rejected = {
      ...ev("p1", "campaign_rejected", "2026-05-16T12:00:00.000Z"),
      id: "evt-bbbb",
      ingested_at: "2026-05-16T12:00:00.900Z",
    };
    const client = makeClient({ campaign_events: [approved, rejected] });
    expect(await getCampaignStatus(client, MERCHANT_ID, "p1")).toBe("rejected");
  });

  it("ignores another merchant's events (returns proposed when none are own)", async () => {
    const client = makeClient({
      campaign_events: [ev("p1", "campaign_approved", "2026-05-16T12:00:00.000Z", OTHER_MERCHANT)],
    });
    expect(await getCampaignStatus(client, MERCHANT_ID, "p1")).toBe("proposed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getPendingProposals
// ─────────────────────────────────────────────────────────────────────────────

describe("getPendingProposals", () => {
  it("returns a fully-generated proposal whose latest event is arms_initialized", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "proposal_started", "2026-05-16T10:00:00.000Z"),
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "arms_initialized", "2026-05-16T10:00:02.000Z"),
      ],
      campaign_proposals: [proposal("p1")],
      campaign_arms: [arm("p1", 0), arm("p1", 1), arm("p1", 2)],
      campaign_group_snapshots: [
        snap("p1", "c1", false),
        snap("p1", "c2", true),
        snap("p1", "c3", false),
      ],
    });
    const pending = await getPendingProposals(client, MERCHANT_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.proposalId).toBe("p1");
    expect(pending[0]!.customerCount).toBe(3);
    expect(pending[0]!.holdoutCount).toBe(1);
    expect(pending[0]!.variants).toHaveLength(3);
  });

  it("excludes an approved proposal", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "campaign_approved", "2026-05-16T12:00:00.000Z"),
      ],
      campaign_proposals: [proposal("p1", { status: "approved" })],
    });
    expect(await getPendingProposals(client, MERCHANT_ID)).toEqual([]);
  });

  it("excludes a rejected proposal", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "campaign_rejected", "2026-05-16T13:00:00.000Z"),
      ],
      campaign_proposals: [proposal("p1", { status: "rejected" })],
    });
    expect(await getPendingProposals(client, MERCHANT_ID)).toEqual([]);
  });

  it("excludes an edited (superseded) proposal but includes its new version", async () => {
    const client = makeClient({
      campaign_events: [
        // p1 was edited away
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "proposal_edited", "2026-05-16T14:00:00.000Z"),
        // p2 is the new version
        ev("p2", "campaign_proposed", "2026-05-16T14:00:00.000Z"),
        ev("p2", "arms_initialized", "2026-05-16T14:00:01.000Z"),
      ],
      campaign_proposals: [
        proposal("p1", { status: "edited" }),
        proposal("p2", { version_number: 2, supersedes_proposal_id: "p1" }),
      ],
      campaign_arms: [arm("p2", 0), arm("p2", 1), arm("p2", 2)],
    });
    const pending = await getPendingProposals(client, MERCHANT_ID);
    expect(pending.map((p) => p.proposalId)).toEqual(["p2"]);
  });

  it("excludes a cap-exhausted zombie with no campaign_proposed event", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "proposal_started", "2026-05-16T10:00:00.000Z"),
        ev("p1", "proposal_failed", "2026-05-16T10:00:01.000Z"),
      ],
      campaign_proposals: [proposal("p1")],
    });
    expect(await getPendingProposals(client, MERCHANT_ID)).toEqual([]);
  });

  it("returns an empty array when the merchant has no proposals", async () => {
    const client = makeClient({ campaign_events: [] });
    expect(await getPendingProposals(client, MERCHANT_ID)).toEqual([]);
  });

  it("excludes another merchant's pending proposals", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z", OTHER_MERCHANT),
        ev("p1", "arms_initialized", "2026-05-16T10:00:02.000Z", OTHER_MERCHANT),
      ],
      campaign_proposals: [proposal("p1", { merchant_id: OTHER_MERCHANT })],
    });
    expect(await getPendingProposals(client, MERCHANT_ID)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getProposalById
// ─────────────────────────────────────────────────────────────────────────────

describe("getProposalById", () => {
  it("returns the full proposal detail with variants and counts", async () => {
    const client = makeClient({
      campaign_proposals: [proposal("p1")],
      campaign_arms: [arm("p1", 0), arm("p1", 1), arm("p1", 2)],
      campaign_group_snapshots: [
        snap("p1", "c1", false),
        snap("p1", "c2", true),
        snap("p1", "c3", false),
        snap("p1", "c4", true),
      ],
      bandit_state: [],
    });
    const detail = await getProposalById(client, MERCHANT_ID, "p1");
    expect(detail).not.toBeNull();
    expect(detail!.proposalId).toBe("p1");
    expect(detail!.variants).toHaveLength(3);
    expect(detail!.customerCount).toBe(4);
    expect(detail!.holdoutCount).toBe(2);
    expect(detail!.banditState).toEqual([]);
  });

  it("includes bandit state once the proposal is approved", async () => {
    const client = makeClient({
      campaign_proposals: [proposal("p1", { status: "approved" })],
      campaign_arms: [arm("p1", 0)],
      bandit_state: [
        {
          arm_id: "bandit-p1-0",
          proposal_id: "p1",
          merchant_id: MERCHANT_ID,
          alpha: 1,
          beta: 1,
          observation_count: 0,
          last_updated_at: "2026-05-16T12:00:00.000Z",
        },
      ],
    });
    const detail = await getProposalById(client, MERCHANT_ID, "p1");
    expect(detail!.banditState).toHaveLength(1);
    expect(detail!.banditState[0]!.alpha).toBe(1);
    expect(detail!.banditState[0]!.beta).toBe(1);
  });

  it("returns null for a proposal that does not exist", async () => {
    const client = makeClient({ campaign_proposals: [] });
    expect(await getProposalById(client, MERCHANT_ID, "missing")).toBeNull();
  });

  it("returns null for a proposal that belongs to another merchant (no existence leak)", async () => {
    const client = makeClient({ campaign_proposals: [proposal("p1")] });
    expect(await getProposalById(client, OTHER_MERCHANT, "p1")).toBeNull();
  });

  it("surfaces the rejection metadata on a rejected proposal", async () => {
    const client = makeClient({
      campaign_proposals: [
        proposal("p1", {
          status: "rejected",
          rejected_at: "2026-05-16T13:00:00.000Z",
          rejection_reason: "offer too aggressive",
        }),
      ],
      campaign_arms: [arm("p1", 0)],
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "campaign_rejected", "2026-05-16T13:00:00.000Z", MERCHANT_ID, {
          user_id: "user_9",
          reason: "offer too aggressive",
        }),
      ],
    });
    const detail = await getProposalById(client, MERCHANT_ID, "p1");
    expect(detail!.status).toBe("rejected");
    expect(detail!.rejectedAt).toBe("2026-05-16T13:00:00.000Z");
    expect(detail!.rejectionReason).toBe("offer too aggressive");
  });

  it("surfaces the approval metadata on an approved proposal", async () => {
    const client = makeClient({
      campaign_proposals: [
        proposal("p1", {
          status: "approved",
          approved_at: "2026-05-16T12:00:00.000Z",
          approved_by_user_id: "user_9",
        }),
      ],
      campaign_arms: [arm("p1", 0)],
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "campaign_approved", "2026-05-16T12:00:00.000Z", MERCHANT_ID, {
          user_id: "user_9",
        }),
      ],
    });
    const detail = await getProposalById(client, MERCHANT_ID, "p1");
    expect(detail!.status).toBe("approved");
    expect(detail!.approvedByUserId).toBe("user_9");
    expect(detail!.approvedAt).toBe("2026-05-16T12:00:00.000Z");
  });

  it("derives status from the event log, not the stale campaign_proposals.status cache", async () => {
    // The cache row still says 'proposed' but a campaign_approved event exists —
    // getProposalById must report the event-derived 'approved'.
    const client = makeClient({
      campaign_proposals: [proposal("p1", { status: "proposed" })],
      campaign_arms: [arm("p1", 0)],
      campaign_events: [
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "campaign_approved", "2026-05-16T12:00:00.000Z"),
      ],
    });
    const detail = await getProposalById(client, MERCHANT_ID, "p1");
    expect(detail!.status).toBe("approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getProposalsByStatus
// ─────────────────────────────────────────────────────────────────────────────

describe("getProposalsByStatus", () => {
  function seed() {
    return {
      campaign_events: [
        // p1 — pending (proposed)
        ev("p1", "campaign_proposed", "2026-05-16T10:00:01.000Z"),
        ev("p1", "arms_initialized", "2026-05-16T10:00:02.000Z"),
        // p2 — approved
        ev("p2", "campaign_proposed", "2026-05-15T10:00:01.000Z"),
        ev("p2", "campaign_approved", "2026-05-15T12:00:00.000Z", MERCHANT_ID, { user_id: "u" }),
        // p3 — rejected
        ev("p3", "campaign_proposed", "2026-05-14T10:00:01.000Z"),
        ev("p3", "campaign_rejected", "2026-05-14T13:00:00.000Z", MERCHANT_ID, {
          user_id: "u",
          reason: "offer too aggressive",
        }),
        // p4 — cap-failed zombie: no campaign_proposed event
        ev("p4", "proposal_started", "2026-05-13T10:00:00.000Z"),
        ev("p4", "proposal_failed", "2026-05-13T10:00:01.000Z"),
      ],
      campaign_proposals: [
        proposal("p1", { generated_at: "2026-05-16T10:00:00.000Z" }),
        proposal("p2", { generated_at: "2026-05-15T10:00:00.000Z", status: "approved" }),
        proposal("p3", { generated_at: "2026-05-14T10:00:00.000Z", status: "rejected" }),
        proposal("p4", { generated_at: "2026-05-13T10:00:00.000Z" }),
      ],
      campaign_arms: [
        arm("p1", 0),
        arm("p1", 1),
        arm("p1", 2),
        arm("p2", 0),
        arm("p3", 0),
      ],
    };
  }

  it("returns only pending proposals for the pending filter", async () => {
    const items = await getProposalsByStatus(makeClient(seed()), MERCHANT_ID, "pending");
    expect(items.map((i) => i.proposalId)).toEqual(["p1"]);
    expect(items[0]!.status).toBe("proposed");
    expect(items[0]!.variantCount).toBe(3);
  });

  it("returns only approved proposals for the approved filter, with the approval date", async () => {
    const items = await getProposalsByStatus(makeClient(seed()), MERCHANT_ID, "approved");
    expect(items.map((i) => i.proposalId)).toEqual(["p2"]);
    expect(items[0]!.approvedAt).toBe("2026-05-15T12:00:00.000Z");
  });

  it("returns only rejected proposals for the rejected filter, with the reason", async () => {
    const items = await getProposalsByStatus(makeClient(seed()), MERCHANT_ID, "rejected");
    expect(items.map((i) => i.proposalId)).toEqual(["p3"]);
    expect(items[0]!.rejectionReason).toBe("offer too aggressive");
  });

  it("returns every generated proposal for the all filter, newest-first", async () => {
    const items = await getProposalsByStatus(makeClient(seed()), MERCHANT_ID, "all");
    expect(items.map((i) => i.proposalId)).toEqual(["p1", "p2", "p3"]);
  });

  it("excludes a cap-failed zombie with no campaign_proposed event", async () => {
    const items = await getProposalsByStatus(makeClient(seed()), MERCHANT_ID, "all");
    expect(items.map((i) => i.proposalId)).not.toContain("p4");
  });

  it("returns an empty array when the merchant has no proposals", async () => {
    expect(await getProposalsByStatus(makeClient({ campaign_events: [] }), MERCHANT_ID, "all")).toEqual(
      [],
    );
  });

  it("excludes another merchant's proposals", async () => {
    const client = makeClient({
      campaign_events: [
        ev("p9", "campaign_proposed", "2026-05-16T10:00:01.000Z", OTHER_MERCHANT),
      ],
      campaign_proposals: [proposal("p9", { merchant_id: OTHER_MERCHANT })],
    });
    expect(await getProposalsByStatus(client, MERCHANT_ID, "all")).toEqual([]);
  });
});
