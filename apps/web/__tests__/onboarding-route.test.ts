// Unit tests for POST /api/onboarding.
//
// Covers: auth gate, input validation (invalid state, not_started blocked),
// backward-transition guard (completed/skipped → in_progress rejected),
// happy path for each valid terminal state, merchant-ID scoping, DB error path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { SessionMerchant } from "../app/lib/session";

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn(),
}));

vi.mock("@/app/lib/env", () => ({
  serverEnv: vi.fn().mockReturnValue({
    supabaseUrl: "https://example.supabase.co",
    supabaseSecretKey: "service-key",
  }),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { createServiceClient } from "@lapsed/db";
import { POST } from "../app/api/onboarding/route";

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
  onboardingState: "not_started" as const,
  installedAt: "2026-05-16T09:00:00.000Z",
};

const MERCHANT_B: SessionMerchant = {
  id: "660e8400-e29b-41d4-a716-446655440002",
  shopDomain: "shop-b.myshopify.com",
  shopName: "Shop B",
  shopInitials: "SB",
  plan: "growth",
  planLabel: "Growth · 25k msgs",
  onboardingState: "not_started" as const,
  installedAt: "2026-05-16T09:00:00.000Z",
};

// ─────────────────────────────────────────────────────────────────────────────
// Client mock factory
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a mock Supabase service client that simulates the onboarding route's
 *  two query patterns:
 *    1. select("onboarding_state").eq(id).single()   → backward-transition guard
 *    2. update({ onboarding_state }).eq(id)           → state write
 */
function makeClient(opts: {
  currentState?: string;
  selectError?: object | null;
  updateError?: object | null;
} = {}) {
  const { currentState = "not_started", selectError = null, updateError = null } = opts;

  const singleFn = vi.fn().mockResolvedValue({
    data: selectError ? null : { onboarding_state: currentState },
    error: selectError,
  });
  const selectEqFn = vi.fn().mockReturnValue({ single: singleFn });
  const selectFn = vi.fn().mockReturnValue({ eq: selectEqFn });

  const updateEqFn = vi.fn().mockResolvedValue({ error: updateError });
  const updateFn = vi.fn().mockReturnValue({ eq: updateEqFn });

  const fromFn = vi.fn().mockReturnValue({ select: selectFn, update: updateFn });

  vi.mocked(createServiceClient).mockReturnValue(
    { from: fromFn } as unknown as ReturnType<typeof createServiceClient>,
  );

  return { fromFn, selectFn, selectEqFn, singleFn, updateFn, updateEqFn };
}

function makeRequest(body: object): NextRequest {
  return new NextRequest("http://localhost/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
  makeClient(); // default: currentState = "not_started", no errors
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/onboarding — auth", () => {
  it("returns 401 when not authenticated", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await POST(makeRequest({ state: "in_progress" }));
    expect(res.status).toBe(401);
  });

  it("does not write to DB when unauthenticated", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const { fromFn } = makeClient();
    await POST(makeRequest({ state: "in_progress" }));
    expect(fromFn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/onboarding — input validation", () => {
  it("returns 400 for invalid state value", async () => {
    const res = await POST(makeRequest({ state: "blast" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; valid: string[] };
    expect(body.error).toBe("invalid_state");
    expect(Array.isArray(body.valid)).toBe(true);
  });

  it("returns 400 for state: not_started (cannot self-reset)", async () => {
    // not_started is excluded from VALID_STATES — clients cannot regress to initial state
    const res = await POST(makeRequest({ state: "not_started" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing state", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed JSON body", async () => {
    const req = new NextRequest("http://localhost/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json {{{",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward-transition guard
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/onboarding — backward-transition guard", () => {
  it("returns 200 without DB write when state is already completed (in_progress blocked)", async () => {
    const { updateFn } = makeClient({ currentState: "completed" });
    const res = await POST(makeRequest({ state: "in_progress" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("completed"); // returns the current (terminal) state
    expect(updateFn).not.toHaveBeenCalled(); // no write to DB
  });

  it("returns 200 without DB write when state is already skipped (in_progress blocked)", async () => {
    const { updateFn } = makeClient({ currentState: "skipped" });
    const res = await POST(makeRequest({ state: "in_progress" }));
    expect(res.status).toBe(200);
    expect(updateFn).not.toHaveBeenCalled();
  });

  it("allows completed even if current state is in_progress (forward transition)", async () => {
    const { updateEqFn } = makeClient({ currentState: "in_progress" });
    const res = await POST(makeRequest({ state: "completed" }));
    expect(res.status).toBe(200);
    // completed does not trigger the read-guard path; goes straight to update
    expect(updateEqFn).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/onboarding — happy path", () => {
  it("returns 200 with ok:true for in_progress (from not_started)", async () => {
    const res = await POST(makeRequest({ state: "in_progress" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("in_progress");
  });

  it("returns 200 with ok:true for completed", async () => {
    const res = await POST(makeRequest({ state: "completed" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("completed");
  });

  it("returns 200 with ok:true for skipped", async () => {
    const res = await POST(makeRequest({ state: "skipped" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; state: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("skipped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-merchant isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/onboarding — cross-merchant isolation", () => {
  it("scopes the DB update to the session merchant id, not any request param", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT_B);
    const { updateEqFn } = makeClient();
    await POST(makeRequest({ state: "completed" }));
    // The .eq() call must use MERCHANT_B.id, never MERCHANT.id
    expect(updateEqFn).toHaveBeenCalledWith("id", MERCHANT_B.id);
    const calls = vi.mocked(updateEqFn).mock.calls;
    expect(calls.every((c) => c[1] !== MERCHANT.id)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/onboarding — errors", () => {
  it("returns 500 when DB update fails", async () => {
    makeClient({ updateError: { message: "db exploded" } });
    const res = await POST(makeRequest({ state: "completed" }));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("db_error");
  });
});
