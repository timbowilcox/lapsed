import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { approveProposal, rejectProposal, editProposal } from "../src/campaign-approval";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_MERCHANT = "660e8400-e29b-41d4-a716-446655440000";
const USER_ID = "user_42";

function proposalRow(id: string, overrides: FakeRow = {}): FakeRow {
  return {
    id,
    merchant_id: MERCHANT_ID,
    group_slug: "lapsed_vips",
    version_number: 1,
    status: "proposed",
    model_version: "claude-sonnet-4-6",
    generated_at: "2026-05-16T10:00:00.000Z",
    created_at: "2026-05-16T10:00:00.000Z",
    approved_at: null,
    approved_by_user_id: null,
    rejected_at: null,
    rejection_reason: null,
    supersedes_proposal_id: null,
    ...overrides,
  };
}

function armRow(proposalId: string, variantIndex: number, overrides: FakeRow = {}): FakeRow {
  return {
    id: randomUUID(),
    proposal_id: proposalId,
    merchant_id: MERCHANT_ID,
    bandit_arm_id: randomUUID(),
    variant_index: variantIndex,
    offer_type: "percent_discount",
    offer_value: "10%",
    message_draft: `variant ${variantIndex} draft`,
    send_time_window: "evening",
    tone: "warm",
    expected_impact: { estimated_response_rate: 0.1, estimated_recovered_revenue: 500 },
    created_at: "2026-05-16T10:00:00.000Z",
    ...overrides,
  };
}

function eventRow(proposalId: string, eventType: string, occurredAt: string): FakeRow {
  return {
    id: randomUUID(),
    merchant_id: MERCHANT_ID,
    proposal_id: proposalId,
    event_type: eventType,
    payload: {},
    occurred_at: occurredAt,
    ingested_at: occurredAt,
  };
}

/** A fully-seeded pending proposal: row + 3 arms + the generation events. */
function seedPendingProposal(proposalId: string) {
  return {
    campaign_proposals: [proposalRow(proposalId)],
    campaign_arms: [
      armRow(proposalId, 0),
      armRow(proposalId, 1, { offer_type: "free_shipping", tone: "direct" }),
      armRow(proposalId, 2, { offer_type: "bundle", tone: "playful" }),
    ],
    // Generation events are dated in the past so that the campaign_approved /
    // campaign_rejected / proposal_edited events the functions append (with
    // the real wall-clock time) are unambiguously the latest event.
    campaign_events: [
      eventRow(proposalId, "proposal_started", "2020-01-01T10:00:00.000Z"),
      eventRow(proposalId, "campaign_proposed", "2020-01-01T10:00:01.000Z"),
      eventRow(proposalId, "arms_initialized", "2020-01-01T10:00:02.000Z"),
    ],
    campaign_group_snapshots: [
      { proposal_id: proposalId, merchant_id: MERCHANT_ID, customer_id: "gid://c/1", included_in_holdout: false },
      { proposal_id: proposalId, merchant_id: MERCHANT_ID, customer_id: "gid://c/2", included_in_holdout: true },
      { proposal_id: proposalId, merchant_id: MERCHANT_ID, customer_id: "gid://c/3", included_in_holdout: false },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// approveProposal
// ─────────────────────────────────────────────────────────────────────────────

describe("approveProposal", () => {
  it("records a campaign_approved event and flips status to approved", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await approveProposal(client, MERCHANT_ID, pid, USER_ID);

    expect(result.status).toBe("approved");
    expect(result.alreadyApproved).toBe(false);
    const approvedEvents = tables.campaign_events!.filter(
      (e) => e.event_type === "campaign_approved",
    );
    expect(approvedEvents).toHaveLength(1);
    expect((approvedEvents[0]!.payload as FakeRow).user_id).toBe(USER_ID);
    expect(tables.campaign_proposals![0]!.status).toBe("approved");
    expect(tables.campaign_proposals![0]!.approved_by_user_id).toBe(USER_ID);
  });

  it("initializes a Beta(1,1) bandit_state row for each of the three arms", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await approveProposal(client, MERCHANT_ID, pid, USER_ID);

    expect(result.initializedArmIds).toHaveLength(3);
    expect(tables.bandit_state).toHaveLength(3);
    for (const row of tables.bandit_state!) {
      expect(row.sentiment_alpha).toBe(1);
      expect(row.sentiment_beta).toBe(1);
      expect(row.observation_count).toBe(0);
      expect(row.proposal_id).toBe(pid);
    }
  });

  it("is idempotent — a second approve is a no-op with no second event", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    await approveProposal(client, MERCHANT_ID, pid, USER_ID);
    const second = await approveProposal(client, MERCHANT_ID, pid, USER_ID);

    expect(second.alreadyApproved).toBe(true);
    expect(second.status).toBe("approved");
    expect(tables.campaign_events!.filter((e) => e.event_type === "campaign_approved")).toHaveLength(1);
    expect(tables.bandit_state).toHaveLength(3);
  });

  it("throws when the proposal has already been rejected", async () => {
    const pid = randomUUID();
    const seed = seedPendingProposal(pid);
    seed.campaign_events.push(eventRow(pid, "campaign_rejected", "2026-05-16T11:00:00.000Z"));
    const { client } = makeFakeSupabase(seed);
    await expect(approveProposal(client, MERCHANT_ID, pid, USER_ID)).rejects.toThrow(
      /rejected and cannot be approved/,
    );
  });

  it("throws when the proposal belongs to a different merchant", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid));
    await expect(approveProposal(client, OTHER_MERCHANT, pid, USER_ID)).rejects.toThrow(
      /not found for merchant/,
    );
  });

  it("rejects a non-UUID proposalId", async () => {
    const { client } = makeFakeSupabase();
    await expect(approveProposal(client, MERCHANT_ID, "nope", USER_ID)).rejects.toThrow(
      /proposalId/,
    );
  });

  it("rejects an empty userId", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid));
    await expect(approveProposal(client, MERCHANT_ID, pid, "")).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rejectProposal
// ─────────────────────────────────────────────────────────────────────────────

describe("rejectProposal", () => {
  it("records a campaign_rejected event with the reason and flips status to rejected", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await rejectProposal(client, MERCHANT_ID, pid, USER_ID, "offer too aggressive");

    expect(result.status).toBe("rejected");
    expect(result.alreadyRejected).toBe(false);
    const rejected = tables.campaign_events!.filter((e) => e.event_type === "campaign_rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.payload as FakeRow).reason).toBe("offer too aggressive");
    expect(tables.campaign_proposals![0]!.status).toBe("rejected");
    expect(tables.campaign_proposals![0]!.rejection_reason).toBe("offer too aggressive");
  });

  it("does not initialize any bandit_state", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    await rejectProposal(client, MERCHANT_ID, pid, USER_ID, "wrong group");
    expect(tables.bandit_state ?? []).toHaveLength(0);
  });

  it("is idempotent — a second reject is a no-op", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    await rejectProposal(client, MERCHANT_ID, pid, USER_ID, "wrong group");
    const second = await rejectProposal(client, MERCHANT_ID, pid, USER_ID, "wrong group");
    expect(second.alreadyRejected).toBe(true);
    expect(tables.campaign_events!.filter((e) => e.event_type === "campaign_rejected")).toHaveLength(1);
  });

  it("throws when the proposal is already approved", async () => {
    const pid = randomUUID();
    const seed = seedPendingProposal(pid);
    seed.campaign_events.push(eventRow(pid, "campaign_approved", "2026-05-16T11:00:00.000Z"));
    const { client } = makeFakeSupabase(seed);
    await expect(
      rejectProposal(client, MERCHANT_ID, pid, USER_ID, "too late"),
    ).rejects.toThrow(/approved and cannot be rejected/);
  });

  it("requires a non-empty rejection reason", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid));
    await expect(rejectProposal(client, MERCHANT_ID, pid, USER_ID, "")).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// editProposal
// ─────────────────────────────────────────────────────────────────────────────

describe("editProposal", () => {
  it("creates a new proposal version that supersedes the original", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await editProposal(client, MERCHANT_ID, pid, USER_ID, [
      { variantIndex: 0, messageDraft: "a fresher draft" },
    ]);

    expect(result.editedProposalId).toBe(pid);
    expect(result.newVersionNumber).toBe(2);
    const newRow = tables.campaign_proposals!.find((p) => p.id === result.newProposalId)!;
    expect(newRow.version_number).toBe(2);
    expect(newRow.supersedes_proposal_id).toBe(pid);
    expect(newRow.status).toBe("proposed");
  });

  it("marks the original proposal edited and records the diff on it", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await editProposal(client, MERCHANT_ID, pid, USER_ID, [
      { variantIndex: 0, messageDraft: "a fresher draft", offerValue: "15%" },
    ]);

    const original = tables.campaign_proposals!.find((p) => p.id === pid)!;
    expect(original.status).toBe("edited");
    const editedEvents = tables.campaign_events!.filter((e) => e.event_type === "proposal_edited");
    expect(editedEvents).toHaveLength(1);
    expect(editedEvents[0]!.proposal_id).toBe(pid);
    const payload = editedEvents[0]!.payload as FakeRow;
    expect(payload.new_proposal_id).toBe(result.newProposalId);
    expect(payload.fields_changed).toEqual([
      "variant_0.message_draft",
      "variant_0.offer_value",
    ]);
    expect(result.fieldsChanged).toEqual(["variant_0.message_draft", "variant_0.offer_value"]);
  });

  it("creates new arms with the edits applied and fresh bandit_arm_ids", async () => {
    const pid = randomUUID();
    const seed = seedPendingProposal(pid);
    const originalBanditIds = seed.campaign_arms.map((a) => a.bandit_arm_id);
    const { client, tables } = makeFakeSupabase(seed);
    const result = await editProposal(client, MERCHANT_ID, pid, USER_ID, [
      { variantIndex: 1, messageDraft: "edited variant one" },
    ]);

    const newArms = tables.campaign_arms!.filter((a) => a.proposal_id === result.newProposalId);
    expect(newArms).toHaveLength(3);
    const editedArm = newArms.find((a) => a.variant_index === 1)!;
    expect(editedArm.message_draft).toBe("edited variant one");
    // Decision 14: new arms get new bandit_arm_id values.
    for (const arm of newArms) {
      expect(originalBanditIds).not.toContain(arm.bandit_arm_id);
    }
  });

  it("carries offer_type and tone over unchanged (structural, not editable)", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await editProposal(client, MERCHANT_ID, pid, USER_ID, [
      { variantIndex: 1, messageDraft: "x" },
    ]);
    const newArm = tables.campaign_arms!.find(
      (a) => a.proposal_id === result.newProposalId && a.variant_index === 1,
    )!;
    expect(newArm.offer_type).toBe("free_shipping");
    expect(newArm.tone).toBe("direct");
  });

  it("inherits the original proposal's frozen group snapshot verbatim (decision 15)", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await editProposal(client, MERCHANT_ID, pid, USER_ID, [
      { variantIndex: 0, messageDraft: "x" },
    ]);
    const newSnapshot = tables.campaign_group_snapshots!.filter(
      (s) => s.proposal_id === result.newProposalId,
    );
    expect(newSnapshot).toHaveLength(3);
    const heldOut = newSnapshot.filter((s) => s.included_in_holdout);
    expect(heldOut).toHaveLength(1);
    expect(heldOut[0]!.customer_id).toBe("gid://c/2");
  });

  it("the original arms and snapshot are retained (not deleted)", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    await editProposal(client, MERCHANT_ID, pid, USER_ID, [{ variantIndex: 0, messageDraft: "x" }]);
    expect(tables.campaign_arms!.filter((a) => a.proposal_id === pid)).toHaveLength(3);
    expect(tables.campaign_group_snapshots!.filter((s) => s.proposal_id === pid)).toHaveLength(3);
  });

  it("records no field change when an edit matches the existing value", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await editProposal(client, MERCHANT_ID, pid, USER_ID, [
      { variantIndex: 0, messageDraft: "variant 0 draft" }, // identical to seed
    ]);
    expect(result.fieldsChanged).toEqual([]);
  });

  it("throws when editing an already-approved proposal", async () => {
    const pid = randomUUID();
    const seed = seedPendingProposal(pid);
    seed.campaign_events.push(eventRow(pid, "campaign_approved", "2026-05-16T11:00:00.000Z"));
    const { client } = makeFakeSupabase(seed);
    await expect(
      editProposal(client, MERCHANT_ID, pid, USER_ID, [{ variantIndex: 0, messageDraft: "x" }]),
    ).rejects.toThrow(/only a pending proposal can be edited/);
  });

  it("throws when the proposal belongs to a different merchant", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid));
    await expect(
      editProposal(client, OTHER_MERCHANT, pid, USER_ID, [{ variantIndex: 0, messageDraft: "x" }]),
    ).rejects.toThrow(/not found for merchant/);
  });

  it("requires at least one variant edit", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid));
    await expect(editProposal(client, MERCHANT_ID, pid, USER_ID, [])).rejects.toThrow();
  });

  it("the new version becomes the pending proposal and the old one drops out", async () => {
    const pid = randomUUID();
    const { client, tables } = makeFakeSupabase(seedPendingProposal(pid));
    const result = await editProposal(client, MERCHANT_ID, pid, USER_ID, [
      { variantIndex: 0, messageDraft: "x" },
    ]);
    // The new version has a campaign_proposed event so getPendingProposals picks it up.
    const newProposed = tables.campaign_events!.filter(
      (e) => e.proposal_id === result.newProposalId && e.event_type === "campaign_proposed",
    );
    expect(newProposed).toHaveLength(1);
    expect((newProposed[0]!.payload as FakeRow).tokens_input).toBe(0);
  });

  it("throws when an edit targets a variant index that does not exist", async () => {
    const pid = randomUUID();
    const seed = seedPendingProposal(pid);
    seed.campaign_arms = [armRow(pid, 0)]; // only variant 0 exists
    const { client } = makeFakeSupabase(seed);
    await expect(
      editProposal(client, MERCHANT_ID, pid, USER_ID, [{ variantIndex: 2, messageDraft: "x" }]),
    ).rejects.toThrow(/variant 2, which does not exist/);
  });

  it("throws when editing a rejected proposal", async () => {
    const pid = randomUUID();
    const seed = seedPendingProposal(pid);
    seed.campaign_events.push(eventRow(pid, "campaign_rejected", "2026-05-16T11:00:00.000Z"));
    const { client } = makeFakeSupabase(seed);
    await expect(
      editProposal(client, MERCHANT_ID, pid, USER_ID, [{ variantIndex: 0, messageDraft: "x" }]),
    ).rejects.toThrow(/only a pending proposal can be edited/);
  });

  it("copies no snapshot rows when the original proposal has none", async () => {
    const pid = randomUUID();
    const seed = seedPendingProposal(pid);
    seed.campaign_group_snapshots = [];
    const { client, tables } = makeFakeSupabase(seed);
    const result = await editProposal(client, MERCHANT_ID, pid, USER_ID, [
      { variantIndex: 0, messageDraft: "x" },
    ]);
    expect(
      tables.campaign_group_snapshots!.filter((s) => s.proposal_id === result.newProposalId),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State-machine guards + DB-error propagation
// ─────────────────────────────────────────────────────────────────────────────

describe("approval state-machine guards", () => {
  function seedEdited(pid: string) {
    const seed = seedPendingProposal(pid);
    seed.campaign_events.push(eventRow(pid, "proposal_edited", "2026-05-16T11:00:00.000Z"));
    return seed;
  }

  it("approveProposal throws on an edited (superseded) proposal", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedEdited(pid));
    await expect(approveProposal(client, MERCHANT_ID, pid, USER_ID)).rejects.toThrow(
      /edited and cannot be approved/,
    );
  });

  it("rejectProposal throws on an edited (superseded) proposal", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedEdited(pid));
    await expect(rejectProposal(client, MERCHANT_ID, pid, USER_ID, "x")).rejects.toThrow(
      /edited and cannot be rejected/,
    );
  });

  it("rejectProposal throws when the proposal belongs to a different merchant", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid));
    await expect(rejectProposal(client, OTHER_MERCHANT, pid, USER_ID, "x")).rejects.toThrow(
      /not found for merchant/,
    );
  });

  it("approveProposal propagates a campaign_events write error", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid), {
      failOn: [{ table: "campaign_events", op: "upsert" }],
    });
    await expect(approveProposal(client, MERCHANT_ID, pid, USER_ID)).rejects.toThrow(/fake error/);
  });

  it("rejectProposal propagates a campaign_events write error", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid), {
      failOn: [{ table: "campaign_events", op: "upsert" }],
    });
    await expect(
      rejectProposal(client, MERCHANT_ID, pid, USER_ID, "x"),
    ).rejects.toThrow(/fake error/);
  });

  it("editProposal propagates a new-proposal insert error", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid), {
      failOn: [{ table: "campaign_proposals", op: "insert" }],
    });
    await expect(
      editProposal(client, MERCHANT_ID, pid, USER_ID, [{ variantIndex: 0, messageDraft: "x" }]),
    ).rejects.toThrow(/fake error/);
  });

  it("editProposal translates a 23505 unique violation into a concurrent-edit error", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid), {
      failOn: [{ table: "campaign_proposals", op: "insert", code: "23505" }],
    });
    await expect(
      editProposal(client, MERCHANT_ID, pid, USER_ID, [{ variantIndex: 0, messageDraft: "x" }]),
    ).rejects.toThrow(/concurrently edited; reload and retry/);
  });

  it("approveProposal propagates a materialize cache-update error", async () => {
    const pid = randomUUID();
    const { client } = makeFakeSupabase(seedPendingProposal(pid), {
      failOn: [{ table: "campaign_proposals", op: "update" }],
    });
    await expect(approveProposal(client, MERCHANT_ID, pid, USER_ID)).rejects.toThrow(/fake error/);
  });

  it("approveProposal reconciles missing bandit_state on a re-approve (idempotent init)", async () => {
    // Simulate a partial prior approval: the campaign_approved event exists but
    // no bandit_state rows were written. A re-approve must initialize them.
    const pid = randomUUID();
    const seed = seedPendingProposal(pid);
    seed.campaign_events.push(eventRow(pid, "campaign_approved", "2026-05-16T11:00:00.000Z"));
    const { client, tables } = makeFakeSupabase(seed);
    expect(tables.bandit_state ?? []).toHaveLength(0);
    const result = await approveProposal(client, MERCHANT_ID, pid, USER_ID);
    expect(result.alreadyApproved).toBe(true);
    expect(tables.bandit_state).toHaveLength(3);
  });
});
