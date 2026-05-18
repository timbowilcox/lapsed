// Unit tests for GET /api/voice/versions.
//
// Covers: auth gate, the mapped VoiceVersionView list, and the
// malformed-profile fallback (a version whose stored jsonb fails
// validation surfaces with profile: null rather than failing the list).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionMerchant } from "../app/lib/session";
import type { VoiceVersionSummary } from "@lapsed/db";
import type { VoiceProfile } from "@lapsed/core";

vi.mock("@/app/lib/session", () => ({
  getMerchantFromSession: vi.fn(),
}));

vi.mock("@lapsed/db", () => ({
  createServiceClient: vi.fn().mockReturnValue({}),
  listVoiceVersions: vi.fn(),
}));

vi.mock("@lapsed/core", () => ({
  parseVoiceProfile: vi.fn(),
}));

import { getMerchantFromSession } from "@/app/lib/session";
import { listVoiceVersions } from "@lapsed/db";
import { parseVoiceProfile } from "@lapsed/core";
import { GET } from "../app/api/voice/versions/route";

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
  tone_descriptors: ["warm", "playful", "direct"],
  sentence_length: "medium",
  register: "conversational",
  emoji_policy: "rare",
  forbidden_phrases: [],
  signature_phrases: ["small batch"],
  sample_sentences: ["s1", "s2", "s3", "s4", "s5"],
};

const VERSIONS: VoiceVersionSummary[] = [
  {
    id: "v2",
    versionNumber: 2,
    modelVersion: "claude-sonnet-4-6-latest",
    extractedAt: "2026-05-16T11:00:00.000Z",
    profile: { ok: true },
  },
  {
    id: "v1",
    versionNumber: 1,
    modelVersion: "claude-sonnet-4-6-latest",
    extractedAt: "2026-05-15T11:00:00.000Z",
    profile: { ok: false },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMerchantFromSession).mockResolvedValue(MERCHANT);
  vi.mocked(listVoiceVersions).mockResolvedValue(VERSIONS);
  vi.mocked(parseVoiceProfile).mockReturnValue(PROFILE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/voice/versions", () => {
  it("returns 401 when there is no session merchant", async () => {
    vi.mocked(getMerchantFromSession).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listVoiceVersions).not.toHaveBeenCalled();
  });

  it("returns the version list with validated profiles", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; profile: VoiceProfile | null }>;
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("v2");
    expect(body[0].profile).toEqual(PROFILE);
  });

  it("queries versions for the session merchant id", async () => {
    await GET();
    expect(listVoiceVersions).toHaveBeenCalledWith(expect.anything(), MERCHANT.id);
  });

  it("surfaces a malformed version with profile: null rather than failing the list", async () => {
    // First version validates; second throws.
    vi.mocked(parseVoiceProfile)
      .mockReturnValueOnce(PROFILE)
      .mockImplementationOnce(() => {
        throw new Error("malformed profile");
      });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; profile: VoiceProfile | null }>;
    expect(body).toHaveLength(2);
    expect(body[0].profile).toEqual(PROFILE);
    expect(body[1].profile).toBeNull();
  });
});
