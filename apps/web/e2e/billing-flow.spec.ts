// Billing flow E2E — Sprint 09 chunk 12.
//
// Covers the navigable subscription surfaces: the three-tier subscribe page
// and the billing settings page. The full Stripe-Checkout round-trip (entering
// a test card on Stripe's hosted page and returning via the webhook) requires
// test-mode Stripe keys provisioned on the environment and automating Stripe's
// own hosted UI — that is a post-provisioning manual verification, documented
// in HANDOFF.md. These tests exercise everything up to the redirect boundary.

import {
  test,
  expect,
  seedTestMerchant,
  seedTestSubscription,
  removeTestMerchant,
} from "./fixtures";

test.beforeAll(async () => {
  await seedTestMerchant();
});

test.afterAll(async () => {
  await removeTestMerchant();
});

test("subscribe page shows three tier cards with their prices", async ({
  merchantPage: page,
}) => {
  await page.goto("/app/billing/subscribe", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Choose a plan" })).toBeVisible();
  // Each tier card carries its name, monthly price, and a Select button.
  for (const { name, price } of [
    { name: "Starter", price: "$299" },
    { name: "Growth", price: "$799" },
    { name: "Scale", price: "$1,499" },
  ]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByText(price, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: `Select ${name}` })).toBeVisible();
  }
});

test("selecting a tier posts to the checkout API", async ({ merchantPage: page }) => {
  await page.goto("/app/billing/subscribe", { waitUntil: "networkidle" });

  // Clicking Select must POST /api/billing/checkout. The response either
  // carries a Stripe-hosted URL (test-mode keys present) or fails gracefully
  // with an inline alert — either way the request is made.
  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.url().includes("/api/billing/checkout") && r.method() === "POST",
    ),
    page.getByRole("button", { name: "Select Growth" }).click(),
  ]);
  expect(JSON.parse(request.postData() ?? "{}")).toEqual({ tier: "growth" });
});

test("billing settings shows the no-plan state for a fresh merchant", async ({
  merchantPage: page,
}) => {
  await page.goto("/app/settings/billing", { waitUntil: "networkidle" });

  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
  // A merchant with no subscription is offered the subscribe path, not a portal.
  await expect(page.getByRole("heading", { name: "No active plan" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Choose a plan" })).toBeVisible();
});

// E2E flow 2 — Settings → portal. A subscribed merchant sees "Manage billing";
// clicking it opens the Stripe Customer Portal. The Stripe-hosted portal page
// and the webhook-on-return state sync are covered server-side by
// billing-scenarios.test.ts (Scenarios 2-5); this asserts the navigable path
// up to the portal-session request.
test.describe("subscribed merchant — portal", () => {
  test.beforeAll(async () => {
    await seedTestSubscription();
  });

  test("billing settings shows the current plan and opens the portal", async ({
    merchantPage: page,
  }) => {
    await page.goto("/app/settings/billing", { waitUntil: "networkidle" });

    // The active Growth plan is shown — not the no-plan state.
    await expect(page.getByRole("heading", { name: "Growth plan" })).toBeVisible();

    // "Manage billing" POSTs the portal-session API.
    const [request] = await Promise.all([
      page.waitForRequest(
        (r) => r.url().includes("/api/billing/portal") && r.method() === "POST",
      ),
      page.getByRole("button", { name: "Manage billing" }).click(),
    ]);
    expect(request.method()).toBe("POST");
  });
});
