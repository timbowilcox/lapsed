// Unit tests for POST /api/voice/reextract.
//
// Covers: auth gate, the pre-flight daily-cap check (429 at/over cap),
// the cap-count DB error path (500), and the under-cap trigger (202).
// The background extract-route fetch runs inside `after()`, which is
// stubbed here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMerchant } from "../app/lib/session";
import type { LapsedSupabaseClient } from "@lapsed/db";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn() };
});

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn(),
}));

import { after } from "next/server";
import { getMerchantFromSession } from "@/app/lib/session";
import { createServiceClient } from "@lapsed/db";
import { POST } from "../app/api/voice/reextract/route";

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
  onboardingState: "completed" as const,
  installedAt: "2026-05-16T09:00:00.000Z",
};

// serverEnv() supplies voiceExtractionDailyCapDefault = 10 by default.
const DEFAULT_CAP = 10;

function makeServiceClient(opts: {
  count?: number | null;
  countError?: { code?: string; message: string } | null;
}): LapsedSupabaseClient {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    gte: () =>
      Promise.resolve(
        opts.countError
          ? { count: null, error: opts.countError }
          : { count: opts.count ?? 0, error: null },
      ),
  };
  return { from: vi.fn(() => chain) } as unknown as LapsedSupabaseClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
  vi.mocked(createServiceClient).mockReturnValue(makeServiceClient({ count: 0 }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/voice/reextract — auth", () => {
  it("returns 401 when there is no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("does not trigger an extraction on auth failure", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    await POST();
    expect(after).not.toHaveBeenCalled();
  });
});

describe("POST /api/voice/reextract — daily cap", () => {
  it("returns 202 and triggers an extraction when under the cap", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeServiceClient({ count: 3 }));
    const res = await POST();
    expect(res.status).toBe(202);
    expect(after).toHaveBeenCalledOnce();
  });

  it("returns 429 when the daily cap is already reached", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeServiceClient({ count: DEFAULT_CAP }));
    const res = await POST();
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("daily_cap_exhausted");
  });

  it("does not trigger an extraction when the cap is exhausted", async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeServiceClient({ count: DEFAULT_CAP + 5 }));
    await POST();
    expect(after).not.toHaveBeenCalled();
  });

  it("returns 500 when the cap-count query errors", async () => {
    vi.mocked(createServiceClient).mockReturnValue(
      makeServiceClient({ countError: { message: "count failed" } }),
    );
    const res = await POST();
    expect(res.status).toBe(500);
    expect(after).not.toHaveBeenCalled();
  });
});
