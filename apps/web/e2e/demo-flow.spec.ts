import { test, expect } from "./fixtures";

// Demo mode flow (Sprint 11, chunk 13).
//
// /preview is public — no auth, no session cookie. This spec walks every demo
// route, asserts distinctive per-route content rendered, then exercises the
// "Install on Shopify" CTA in the demo banner and asserts it targets the
// install page. It does NOT install — it asserts the navigation target only.

interface PreviewRoute {
  name: string;
  path: string;
  /** When true, assert the page <h1>; otherwise assert distinctive body text. */
  heading: boolean;
  content: string;
}

// Mirrors the previewRoutes set covered by axe scans in a11y.spec.ts:26-34.
const previewRoutes: PreviewRoute[] = [
  { name: "dashboard", path: "/preview", heading: false, content: "Restored revenue" },
  { name: "lapsed", path: "/preview/lapsed", heading: true, content: "Lapsed customers" },
  { name: "campaigns", path: "/preview/campaigns", heading: true, content: "Campaigns" },
  { name: "conversations", path: "/preview/conversations", heading: true, content: "Conversations" },
  { name: "attribution", path: "/preview/attribution", heading: true, content: "Revenue restored" },
  { name: "billing", path: "/preview/billing", heading: true, content: "Billing" },
  { name: "settings", path: "/preview/settings", heading: true, content: "Settings" },
];

for (const route of previewRoutes) {
  test(`demo ${route.name}: ${route.path} renders publicly`, async ({ page }) => {
    await page.goto(route.path, { waitUntil: "networkidle" });

    if (route.heading) {
      await expect(page.getByRole("heading", { name: route.content })).toBeVisible();
    } else {
      await expect(page.getByText(route.content, { exact: false }).first()).toBeVisible();
    }

    // The "This is a demo." banner is present on every demo page.
    await expect(page.getByText("This is a demo.", { exact: false })).toBeVisible();
  });
}

test("demo banner Install CTA navigates to the install page", async ({ page }) => {
  await page.goto("/preview", { waitUntil: "networkidle" });

  const installCta = page.getByRole("link", { name: /Install on Shopify/i });
  await expect(installCta).toBeVisible();

  await installCta.click();
  await expect(page).toHaveURL(/\/app\/auth\/install/);
});
