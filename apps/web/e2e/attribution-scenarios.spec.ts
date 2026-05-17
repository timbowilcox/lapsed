// Sprint 08 chunk 12 — attribution route-security E2E.
//
// The five constructed attribution scenarios (high-lift / zero-lift /
// negative-lift / insufficient-evidence / multi-campaign-overlap) and the
// Welch-CI Monte-Carlo coverage check are exercised as the math-defensibility
// gate in packages/core/__tests__/attribution-scenarios.test.ts — that layer
// seeds synthetic data and runs computeIncrementalRevenue / computeLtvRestoration
// directly, with no live DB and no external mocks.
//
// The attribution-batch cron route builds its Supabase service client from env
// with no injection seam, so a browser-level run of the full batch is not
// feasible in CI without route changes (v2). This Playwright spec covers what
// only the real route can demonstrate: the CRON_SECRET security boundary — no
// secrets, no DB, deterministic in CI. Mirrors the Sprint 07 precedent
// (conversation-engine.spec.ts).

import { test, expect } from "./fixtures";

test.describe("attribution batch cron — route security boundary", () => {
  test("returns 401 without the cron secret", async ({ request }) => {
    const res = await request.get("/api/cron/attribution-batch");
    expect(res.status()).toBe(401);
  });

  test("returns 401 with a wrong bearer token", async ({ request }) => {
    const res = await request.get("/api/cron/attribution-batch", {
      headers: { Authorization: "Bearer not-the-cron-secret" },
    });
    expect(res.status()).toBe(401);
  });

  test("rejects a non-GET method", async ({ request }) => {
    // The cron route only exports GET — POST has no handler → 405.
    const res = await request.post("/api/cron/attribution-batch");
    expect(res.status()).toBe(405);
  });
});

test.describe("per-campaign attribution page — id validation", () => {
  test("a malformed campaign id 404s", async ({ merchantPage: page }) => {
    const res = await page.goto("/app/campaigns/not-a-uuid/attribution", {
      waitUntil: "domcontentloaded",
    });
    expect(res?.status()).toBe(404);
  });

  test("a well-formed but unknown campaign id 404s without leaking existence", async ({
    merchantPage: page,
  }) => {
    const res = await page.goto(
      "/app/campaigns/00000000-0000-4000-8000-000000000000/attribution",
      { waitUntil: "domcontentloaded" },
    );
    expect(res?.status()).toBe(404);
  });
});
