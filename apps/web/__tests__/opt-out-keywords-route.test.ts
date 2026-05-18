// Unit tests for GET + PATCH /api/settings/opt-out-keywords.
//
// Covers: auth gate, GET merges Twilio-reserved keywords, PATCH add keyword,
// PATCH remove non-reserved keyword, PATCH remove STOP (Twilio-reserved → 422),
// PATCH remove STOPALL (Twilio-reserved → 422). DB functions are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMerchant } from "../app/lib/session";

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn().mockReturnValue({}),
  getMerchantOptOutConfig: vi.fn(),
  mutateMerchantKeyword: vi.fn(),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { getMerchantOptOutConfig, mutateMerchantKeyword } from "@lapsed/db";
import { GET, PATCH } from "../app/api/settings/opt-out-keywords/route";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT: SessionMerchant = {
  id: "550e8400-e29b-41d4-a716-446655440001",
  shopDomain: "test-shop.myshopify.com",
  shopName: "Test Shop",
  shopInitials: "TS",
  plan: "starter",
  planLabel: "Starter · 5k msgs",
  installedAt: "2026-05-16T09:00:00.000Z",
};

const BASE_CONFIG = {
  optOutKeywords: ["QUIT"],
  agentDraftDefaults: ["STOP", "UNSUBSCRIBE"],
};

function makePatchRequest(body: object): Request {
  return new Request("http://localhost/api/settings/opt-out-keywords", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
  vi.mocked(getMerchantOptOutConfig).mockResolvedValue(BASE_CONFIG);
  vi.mocked(mutateMerchantKeyword).mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET — auth gate
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/settings/opt-out-keywords — auth", () => {
  it("returns 401 when there is no session", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET — response shape
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/settings/opt-out-keywords — response", () => {
  it("merges STOP and STOPALL into the opt-out keyword list", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.optOutKeywords).toContain("STOP");
    expect(body.optOutKeywords).toContain("STOPALL");
    expect(body.optOutKeywords).toContain("QUIT");
  });

  it("returns agentDraftDefaults from the DB config", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.agentDraftDefaults).toEqual(["STOP", "UNSUBSCRIBE"]);
  });

  it("deduplicates when merchant has STOP in their extras column", async () => {
    vi.mocked(getMerchantOptOutConfig).mockResolvedValue({
      optOutKeywords: ["STOP", "QUIT"],
      agentDraftDefaults: [],
    });
    const res = await GET();
    const body = await res.json();
    const stopCount = (body.optOutKeywords as string[]).filter((k) => k === "STOP").length;
    expect(stopCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — auth gate
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/settings/opt-out-keywords — auth", () => {
  it("returns 401 when there is no session", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const req = makePatchRequest({ list: "opt_out_keywords", action: "add", keyword: "QUIT" });
    const res = await PATCH(req);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — add keyword (happy path)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/settings/opt-out-keywords — add keyword", () => {
  it("calls mutateMerchantKeyword with normalised keyword and returns 200", async () => {
    vi.mocked(getMerchantOptOutConfig).mockResolvedValue({
      optOutKeywords: ["QUIT", "CANCEL"],
      agentDraftDefaults: ["STOP"],
    });
    const req = makePatchRequest({ list: "opt_out_keywords", action: "add", keyword: "end" });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(mutateMerchantKeyword)).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT.id,
      "opt_out_keywords",
      "add",
      "END",
    );
    const body = await res.json();
    expect(body.optOutKeywords).toContain("STOP");
    expect(body.optOutKeywords).toContain("STOPALL");
  });

  it("adds to agent_draft_defaults list", async () => {
    const req = makePatchRequest({
      list: "agent_draft_defaults",
      action: "add",
      keyword: "CANCEL",
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(mutateMerchantKeyword)).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT.id,
      "agent_draft_defaults",
      "add",
      "CANCEL",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — remove non-reserved keyword (happy path)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/settings/opt-out-keywords — remove non-reserved", () => {
  it("removes QUIT from opt_out_keywords and returns 200", async () => {
    vi.mocked(getMerchantOptOutConfig).mockResolvedValue({
      optOutKeywords: [],
      agentDraftDefaults: ["STOP"],
    });
    const req = makePatchRequest({ list: "opt_out_keywords", action: "remove", keyword: "QUIT" });
    const res = await PATCH(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(mutateMerchantKeyword)).toHaveBeenCalledWith(
      expect.anything(),
      MERCHANT.id,
      "opt_out_keywords",
      "remove",
      "QUIT",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — remove Twilio-reserved keyword (must fail)
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/settings/opt-out-keywords — remove reserved keyword", () => {
  it("returns 422 when attempting to remove STOP", async () => {
    const req = makePatchRequest({ list: "opt_out_keywords", action: "remove", keyword: "STOP" });
    const res = await PATCH(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Twilio-reserved/);
  });

  it("returns 422 when attempting to remove STOPALL", async () => {
    const req = makePatchRequest({
      list: "opt_out_keywords",
      action: "remove",
      keyword: "STOPALL",
    });
    const res = await PATCH(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/Twilio-reserved/);
  });

  it("returns 422 when attempting to remove STOP case-insensitively", async () => {
    const req = makePatchRequest({ list: "opt_out_keywords", action: "remove", keyword: "stop" });
    const res = await PATCH(req);
    expect(res.status).toBe(422);
  });

  it("does not call mutateMerchantKeyword when reserved keyword removal is blocked", async () => {
    const req = makePatchRequest({ list: "opt_out_keywords", action: "remove", keyword: "STOP" });
    await PATCH(req);
    expect(vi.mocked(mutateMerchantKeyword)).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH — validation errors
// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /api/settings/opt-out-keywords — validation", () => {
  it("returns 400 for an unknown list", async () => {
    const req = makePatchRequest({ list: "unknown_list", action: "add", keyword: "QUIT" });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown keyword list/);
  });

  it("returns 400 for an unknown action", async () => {
    const req = makePatchRequest({ list: "opt_out_keywords", action: "upsert", keyword: "QUIT" });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown action/);
  });

  it("returns 400 when keyword is missing", async () => {
    const req = makePatchRequest({ list: "opt_out_keywords", action: "add", keyword: "" });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it("returns 422 when keyword fails format validation (special chars)", async () => {
    const req = makePatchRequest({ list: "opt_out_keywords", action: "add", keyword: "STOP!" });
    const res = await PATCH(req);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/letters or numbers/);
  });
});
