import { afterEach, describe, expect, it, vi } from "vitest";

// All required() env vars that serverEnv() will throw on if absent.
const BASE_ENV: Record<string, string> = {
  SHOPIFY_API_KEY: "test-key",
  SHOPIFY_API_SECRET: "test-secret",
  SHOPIFY_SCOPES: "read_orders",
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "test-supabase-secret",
  SUPABASE_JWT_SECRET: "test-jwt-secret",
  TOKEN_ENCRYPTION_KEY: "test-encryption-key",
  CRON_SECRET: "test-cron-secret",
  ANTHROPIC_API_KEY: "test-anthropic-key",
};

// Each test resets modules and stubs env inside the it() body so the
// module-level `cached` in env.ts starts null on every import.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("serverEnv — scoringTokenCapDefault", () => {
  it("parses a valid numeric SCORING_TOKEN_CAP_DEFAULT", async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
    vi.stubEnv("SCORING_TOKEN_CAP_DEFAULT", "5000000");
    const { serverEnv } = await import("../app/lib/env");
    expect(serverEnv().scoringTokenCapDefault).toBe(5_000_000);
  });

  it("defaults to 10_000_000 when SCORING_TOKEN_CAP_DEFAULT is absent", async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
    const { serverEnv } = await import("../app/lib/env");
    expect(serverEnv().scoringTokenCapDefault).toBe(10_000_000);
  });

  it("falls back to 10_000_000 when SCORING_TOKEN_CAP_DEFAULT is a non-numeric string (NaN guard)", async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
    vi.stubEnv("SCORING_TOKEN_CAP_DEFAULT", "not-a-number");
    const { serverEnv } = await import("../app/lib/env");
    expect(serverEnv().scoringTokenCapDefault).toBe(10_000_000);
  });
});
