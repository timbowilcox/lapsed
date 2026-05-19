// Unit tests for GET /api/voice/profile.
//
// Covers: auth gate (getMerchantFromSession), null-profile body, the
// validated VoiceProfileResponse happy path, and malformed-profile
// fallback to null. getActiveVoiceProfile and parseVoiceProfile are mocked
// — their own unit tests live in packages/db and packages/core.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMerchant } from "../app/lib/session";
import type { ActiveVoiceProfile } from "@lapsed/db";
import type { VoiceProfile } from "@lapsed/core";

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn().mockReturnValue({}),
  getActiveVoiceProfile: vi.fn(),
}));

vi.mock("@lapsed/core", () => ({
  parseVoiceProfile: vi.fn(),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { getActiveVoiceProfile } from "@lapsed/db";
import { parseVoiceProfile } from "@lapsed/core";
import { GET } from "../app/api/voice/profile/route";

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

const PROFILE: VoiceProfile = {
  tone_descriptors: ["warm", "playful", "down_to_earth"],
  sentence_length: "medium",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: [],
  signature_phrases: ["small batch"],
  sample_sentences: ["s1", "s2", "s3", "s4", "s5"],
};

const ACTIVE: ActiveVoiceProfile = {
  versionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  versionNumber: 2,
  profile: PROFILE as unknown as ActiveVoiceProfile["profile"],
  modelVersion: "claude-sonnet-4-6-latest",
  extractedAt: "2026-05-16T10:00:11.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
  vi.mocked(getActiveVoiceProfile).mockResolvedValue(ACTIVE);
  vi.mocked(parseVoiceProfile).mockReturnValue(PROFILE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth gate
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/voice/profile — auth", () => {
  it("returns 401 when there is no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("does not query the voice profile on auth failure", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    await GET();
    expect(getActiveVoiceProfile).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response body
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/voice/profile — body", () => {
  it("returns null when no active voice profile exists", async () => {
    vi.mocked(getActiveVoiceProfile).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("returns the validated VoiceProfileResponse when a profile exists", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      versionId: string;
      versionNumber: number;
      profile: VoiceProfile;
    };
    expect(body.versionId).toBe(ACTIVE.versionId);
    expect(body.versionNumber).toBe(2);
    expect(body.profile).toEqual(PROFILE);
  });

  it("queries the profile with the session merchant id, not a request value", async () => {
    await GET();
    expect(getActiveVoiceProfile).toHaveBeenCalledWith(expect.anything(), MERCHANT.id);
  });

  it("returns null when the stored profile fails validation", async () => {
    vi.mocked(parseVoiceProfile).mockImplementation(() => {
      throw new Error("malformed profile");
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });
});
