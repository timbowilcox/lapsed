// Sprint 07 chunk 12 — conversation engine route-security E2E.
//
// The full launch → inbound → reply → posterior → opt-out flow is exercised
// end-to-end as an integration test in
// packages/core/__tests__/conversation-engine.flow.test.ts — that layer has
// the seams to inject fake Twilio + mock Anthropic. The API routes construct
// those clients from env with no injection seam, so a browser-level run of
// the full flow with mocked external APIs is not feasible without route
// changes (v2). This Playwright spec covers what only the real routes can
// demonstrate: the security boundaries — every one needs NO external mock and
// NO secrets, so it runs deterministically in CI.

import { test, expect } from "./fixtures";

const FORM = { From: "+15551234567", To: "+18888800461", Body: "hello", MessageSid: "SM_e2e_1" };

test.describe("conversation engine — route security boundaries", () => {
  test("inbound webhook returns 403 when the Twilio signature header is absent", async ({
    request,
  }) => {
    const res = await request.post("/api/sms/inbound", { form: FORM });
    // No X-Twilio-Signature → validation fails → 403 before any DB write.
    expect(res.status()).toBe(403);
  });

  test("inbound webhook returns 403 for a forged Twilio signature", async ({ request }) => {
    const res = await request.post("/api/sms/inbound", {
      form: FORM,
      headers: { "X-Twilio-Signature": "Zm9yZ2VkLXNpZ25hdHVyZQ==" },
    });
    expect(res.status()).toBe(403);
  });

  test("launch-campaigns cron returns 401 without the cron secret", async ({ request }) => {
    const res = await request.get("/api/cron/launch-campaigns");
    expect(res.status()).toBe(401);
  });

  test("launch-campaigns cron returns 401 with a wrong bearer token", async ({ request }) => {
    const res = await request.get("/api/cron/launch-campaigns", {
      headers: { Authorization: "Bearer not-the-cron-secret" },
    });
    expect(res.status()).toBe(401);
  });

  test("sweep-no-reply cron returns 401 without the cron secret", async ({ request }) => {
    const res = await request.get("/api/cron/sweep-no-reply");
    expect(res.status()).toBe(401);
  });
});
