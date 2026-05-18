// Unit tests for the /api/campaigns/* approval routes.
//
// Covers: auth gate, merchant-id-from-session (never from the request),
// cross-merchant 404 (never 403), body validation, and the approval-error
// → HTTP status mapping. The @lapsed/core approval functions and @lapsed/db
// query helpers are mocked — their own unit tests live in those packages.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMerchant } from "../app/lib/session";

vi.mock("@/app/lib/session", () => ({ getMerchantFromSession: vi.fn() }));
vi.mock("@/app/lib/env", () => ({
  serverEnv: vi.fn().mockReturnValue({ supabaseUrl: "https://x", supabaseSecretKey: "k" }),
}));
vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn().mockReturnValue({}),
  getPendingProposals: vi.fn(),
  getProposalById: vi.fn(),
}));
vi.mock("@lapsed/core", () => ({
  approveProposal: vi.fn(),
  rejectProposal: vi.fn(),
  editProposal: vi.fn(),
  checkCampaignApprovalAllowed: vi.fn(),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { getPendingProposals, getProposalById } from "@lapsed/db";
import {
  approveProposal,
  rejectProposal,
  editProposal,
  checkCampaignApprovalAllowed,
} from "@lapsed/core";
import { campaignErrorResponse, isUuid } from "../app/api/campaigns/_shared";
import { GET as getPending } from "../app/api/campaigns/pending/route";
import { GET as getById } from "../app/api/campaigns/[id]/route";
import { POST as postApprove } from "../app/api/campaigns/[id]/approve/route";
import { POST as postReject } from "../app/api/campaigns/[id]/reject/route";
import { POST as postEdit } from "../app/api/campaigns/[id]/edit/route";

const MERCHANT: SessionMerchant = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  shopDomain: "test-shop.myshopify.com",
  shopName: "Test Shop",
  shopInitials: "TS",
  plan: "starter",
  planLabel: "Starter · 5k msgs",
  onboardingState: "completed" as const,
  installedAt: "2026-05-16T09:00:00.000Z",
};

const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/campaigns/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/campaigns/pending
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/campaigns/pending", () => {
  it("returns 401 with no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await getPending();
    expect(res.status).toBe(401);
    expect(getPendingProposals).not.toHaveBeenCalled();
  });

  it("returns the pending proposals for the session merchant", async () => {
    vi.mocked(getPendingProposals).mockResolvedValue([
      // minimal shape — the helper's own tests cover the full structure
      { proposalId: PROPOSAL_ID } as never,
    ]);
    const res = await getPending();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposals: [{ proposalId: PROPOSAL_ID }] });
  });

  it("queries with the session merchant id, never a request value", async () => {
    vi.mocked(getPendingProposals).mockResolvedValue([]);
    await getPending();
    expect(getPendingProposals).toHaveBeenCalledWith(expect.anything(), MERCHANT.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/campaigns/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/campaigns/[id]", () => {
  it("returns 401 with no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await getById(new Request("http://x"), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(401);
  });

  it("returns 404 for a malformed (non-UUID) id without querying", async () => {
    const res = await getById(new Request("http://x"), paramsFor("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(getProposalById).not.toHaveBeenCalled();
  });

  it("returns 404 (not 403) when the proposal is not found / cross-merchant", async () => {
    vi.mocked(getProposalById).mockResolvedValue(null);
    const res = await getById(new Request("http://x"), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("returns the proposal detail when found", async () => {
    vi.mocked(getProposalById).mockResolvedValue({ proposalId: PROPOSAL_ID } as never);
    const res = await getById(new Request("http://x"), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proposalId: PROPOSAL_ID });
  });

  it("queries with the session merchant id", async () => {
    vi.mocked(getProposalById).mockResolvedValue({ proposalId: PROPOSAL_ID } as never);
    await getById(new Request("http://x"), paramsFor(PROPOSAL_ID));
    expect(getProposalById).toHaveBeenCalledWith(expect.anything(), MERCHANT.id, PROPOSAL_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/campaigns/[id]/approve
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/campaigns/[id]/approve", () => {
  beforeEach(() => {
    // Default: the billing gate allows the approval. Individual tests override.
    vi.mocked(checkCampaignApprovalAllowed).mockResolvedValue({ allowed: true } as never);
  });

  it("returns 403 when the billing gate denies (suspended)", async () => {
    vi.mocked(checkCampaignApprovalAllowed).mockResolvedValue({
      allowed: false,
      reason: "suspended",
    } as never);
    const res = await postApprove(postRequest({ userId: "u1" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("suspended");
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it("returns 403 with reason monthly_limit_reached when the tier allowance is used up", async () => {
    vi.mocked(checkCampaignApprovalAllowed).mockResolvedValue({
      allowed: false,
      reason: "monthly_limit_reached",
    } as never);
    const res = await postApprove(postRequest({ userId: "u1" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("monthly_limit_reached");
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it("validates the id BEFORE the billing gate — a bad id is 404, not 403", async () => {
    vi.mocked(checkCampaignApprovalAllowed).mockResolvedValue({
      allowed: false,
      reason: "suspended",
    } as never);
    const res = await postApprove(postRequest({ userId: "u1" }), paramsFor("not-a-uuid"));
    expect(res.status).toBe(404);
    expect(checkCampaignApprovalAllowed).not.toHaveBeenCalled();
  });

  it("returns 401 with no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await postApprove(postRequest({ userId: "u1" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(401);
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed id", async () => {
    const res = await postApprove(postRequest({ userId: "u1" }), paramsFor("nope"));
    expect(res.status).toBe(404);
  });

  it("returns 400 when userId is missing", async () => {
    const res = await postApprove(postRequest({}), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
    expect(approveProposal).not.toHaveBeenCalled();
  });

  it("returns 400 on an unparseable body", async () => {
    const bad = new Request("http://x", { method: "POST", body: "{not json" });
    const res = await postApprove(bad, paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
  });

  it("approves and returns the result", async () => {
    vi.mocked(approveProposal).mockResolvedValue({
      proposalId: PROPOSAL_ID,
      status: "approved",
      alreadyApproved: false,
      initializedArmIds: ["a", "b", "c"],
    });
    const res = await postApprove(postRequest({ userId: "u1" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("approved");
    expect(approveProposal).toHaveBeenCalledWith(expect.anything(), MERCHANT.id, PROPOSAL_ID, "u1");
  });

  it("maps a not-found error to 404", async () => {
    vi.mocked(approveProposal).mockRejectedValue(
      new Error(`materializeCampaign: proposal ${PROPOSAL_ID} not found for merchant x`),
    );
    const res = await postApprove(postRequest({ userId: "u1" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(404);
  });

  it("maps an invalid-state error to 409", async () => {
    vi.mocked(approveProposal).mockRejectedValue(
      new Error(`approveProposal: proposal ${PROPOSAL_ID} is rejected and cannot be approved`),
    );
    const res = await postApprove(postRequest({ userId: "u1" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/campaigns/[id]/reject
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/campaigns/[id]/reject", () => {
  it("returns 401 with no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await postReject(postRequest({ userId: "u1", reason: "x" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(401);
  });

  it("returns 400 when the reason is missing", async () => {
    const res = await postReject(postRequest({ userId: "u1" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
    expect(rejectProposal).not.toHaveBeenCalled();
  });

  it("returns 400 on an unparseable body", async () => {
    const bad = new Request("http://x", { method: "POST", body: "{not json" });
    const res = await postReject(bad, paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
  });

  it("returns 404 for a malformed id", async () => {
    const res = await postReject(postRequest({ userId: "u1", reason: "x" }), paramsFor("nope"));
    expect(res.status).toBe(404);
  });

  it("maps a cross-merchant not-found error to 404, never 403", async () => {
    vi.mocked(rejectProposal).mockRejectedValue(
      new Error(`materializeCampaign: proposal ${PROPOSAL_ID} not found for merchant x`),
    );
    const res = await postReject(postRequest({ userId: "u1", reason: "x" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("returns 400 when the reason is blank whitespace", async () => {
    const res = await postReject(postRequest({ userId: "u1", reason: "   " }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
  });

  it("rejects and returns the result", async () => {
    vi.mocked(rejectProposal).mockResolvedValue({
      proposalId: PROPOSAL_ID,
      status: "rejected",
      alreadyRejected: false,
    });
    const res = await postReject(
      postRequest({ userId: "u1", reason: "offer too aggressive" }),
      paramsFor(PROPOSAL_ID),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("rejected");
    expect(rejectProposal).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT.id,
      PROPOSAL_ID,
      "u1",
      "offer too aggressive",
    );
  });

  it("maps an invalid-state error to 409", async () => {
    vi.mocked(rejectProposal).mockRejectedValue(
      new Error(`rejectProposal: proposal ${PROPOSAL_ID} is approved and cannot be rejected`),
    );
    const res = await postReject(postRequest({ userId: "u1", reason: "x" }), paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/campaigns/[id]/edit
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/campaigns/[id]/edit", () => {
  it("returns 401 with no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await postEdit(
      postRequest({ userId: "u1", edits: [] }),
      paramsFor(PROPOSAL_ID),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when edits is not an array", async () => {
    const res = await postEdit(
      postRequest({ userId: "u1", edits: "nope" }),
      paramsFor(PROPOSAL_ID),
    );
    expect(res.status).toBe(400);
    expect(editProposal).not.toHaveBeenCalled();
  });

  it("edits and returns the new version", async () => {
    vi.mocked(editProposal).mockResolvedValue({
      editedProposalId: PROPOSAL_ID,
      newProposalId: "22222222-2222-4222-8222-222222222222",
      newVersionNumber: 2,
      fieldsChanged: ["variant_0.message_draft"],
    });
    const res = await postEdit(
      postRequest({ userId: "u1", edits: [{ variantIndex: 0, messageDraft: "x" }] }),
      paramsFor(PROPOSAL_ID),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).newVersionNumber).toBe(2);
  });

  it("maps a concurrent-edit error to 409", async () => {
    vi.mocked(editProposal).mockRejectedValue(
      new Error(`editProposal: proposal ${PROPOSAL_ID} was concurrently edited; reload and retry`),
    );
    const res = await postEdit(
      postRequest({ userId: "u1", edits: [{ variantIndex: 0, messageDraft: "x" }] }),
      paramsFor(PROPOSAL_ID),
    );
    expect(res.status).toBe(409);
  });

  it("maps an only-pending-can-be-edited error to 409", async () => {
    vi.mocked(editProposal).mockRejectedValue(
      new Error(
        `editProposal: proposal ${PROPOSAL_ID} is approved; only a pending proposal can be edited`,
      ),
    );
    const res = await postEdit(
      postRequest({ userId: "u1", edits: [{ variantIndex: 0, messageDraft: "x" }] }),
      paramsFor(PROPOSAL_ID),
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 on an unparseable body", async () => {
    const bad = new Request("http://x", { method: "POST", body: "{not json" });
    const res = await postEdit(bad, paramsFor(PROPOSAL_ID));
    expect(res.status).toBe(400);
  });

  it("maps a cross-merchant not-found error to 404, never 403", async () => {
    vi.mocked(editProposal).mockRejectedValue(
      new Error(`materializeCampaign: proposal ${PROPOSAL_ID} not found for merchant x`),
    );
    const res = await postEdit(
      postRequest({ userId: "u1", edits: [{ variantIndex: 0, messageDraft: "x" }] }),
      paramsFor(PROPOSAL_ID),
    );
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _shared.ts — isUuid + campaignErrorResponse (direct unit tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("isUuid", () => {
  it("accepts a canonical lowercase UUID", () => {
    expect(isUuid(PROPOSAL_ID)).toBe(true);
  });
  it("accepts an uppercase UUID", () => {
    expect(isUuid(PROPOSAL_ID.toUpperCase())).toBe(true);
  });
  it("rejects an empty string, a plain word, and a near-miss", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("11111111-1111-4111-8111-11111111")).toBe(false); // last segment too short
  });
  it("rejects a UUID with surrounding whitespace", () => {
    expect(isUuid(` ${PROPOSAL_ID} `)).toBe(false);
  });
});

describe("campaignErrorResponse", () => {
  it("maps a not-found-for-merchant error to 404 — never 403", () => {
    const res = campaignErrorResponse(new Error("materializeCampaign: proposal x not found for merchant y"));
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("maps an invalid-state error to 409", () => {
    const res = campaignErrorResponse(new Error("approveProposal: proposal x is rejected and cannot be approved"));
    expect(res.status).toBe(409);
  });

  it("maps an editProposal has-no-arms error to 409 (not 500)", () => {
    const res = campaignErrorResponse(new Error("editProposal: proposal x has no arms to edit"));
    expect(res.status).toBe(409);
  });

  it("maps a validation message to 400", async () => {
    const res = campaignErrorResponse(new Error("merchantId must be a UUID"));
    expect(res.status).toBe(400);
  });

  it("maps a ZodError (detected by name) to 400", () => {
    const zodErr = Object.assign(new Error("[{...}]"), { name: "ZodError" });
    const res = campaignErrorResponse(zodErr);
    expect(res.status).toBe(400);
  });

  it("maps an unrecognized error to 500", () => {
    const res = campaignErrorResponse(new Error("some unexpected database failure"));
    expect(res.status).toBe(500);
  });

  it("strips the internal function-name prefix from the client-facing detail", async () => {
    const res = campaignErrorResponse(
      new Error("editProposal: proposal x is approved; only a pending proposal can be edited"),
    );
    const body = (await res.json()) as { detail?: string };
    expect(body.detail).toBe("proposal x is approved; only a pending proposal can be edited");
    expect(body.detail).not.toContain("editProposal:");
  });
});
