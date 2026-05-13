import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const screenshotDir = join(process.cwd(), "..", "..", "_evidence", "sprint-01", "screenshots");

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true });
});

interface RouteCheck {
  name: string;
  path: string;
  expect: string;
}

const routes: RouteCheck[] = [
  { name: "01-root-redirect", path: "/", expect: "Recovered revenue · last 30 days" },
  { name: "02-install", path: "/app/auth/install", expect: "Install lapsed on your Shopify store" },
  { name: "03-dashboard", path: "/app", expect: "Recovered revenue · last 30 days" },
  { name: "04-lapsed-list", path: "/app/lapsed", expect: "Lapsed customers" },
  { name: "05-lapsed-detail", path: "/app/lapsed/lap_001", expect: "Jess Reilly" },
  { name: "06-campaigns", path: "/app/campaigns", expect: "Manage your active, draft and paused" },
  { name: "07-campaign-new", path: "/app/campaigns/new", expect: "Audience" },
  { name: "08-campaign-detail", path: "/app/campaigns/cam_001", expect: "Summer dormant" },
  { name: "09-conversations", path: "/app/conversations", expect: "Two-way threads from active campaigns" },
  { name: "10-conversation-detail", path: "/app/conversations/conv_001", expect: "Jess Reilly" },
  { name: "11-attribution", path: "/app/attribution", expect: "Recovered revenue" },
  { name: "12-billing", path: "/app/billing", expect: "Manage your subscription" },
  { name: "13-settings", path: "/app/settings", expect: "Brand voice" },
  { name: "14-onboarding", path: "/app/onboarding", expect: "Welcome to lapsed." },
];

for (const route of routes) {
  test(`tour ${route.name}: ${route.path}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto(route.path, { waitUntil: "networkidle" });
    await expect(page.getByText(route.expect, { exact: false }).first()).toBeVisible();

    await page.screenshot({
      path: join(screenshotDir, `${route.name}.png`),
      fullPage: true,
    });

    expect(consoleErrors, `console errors on ${route.path}`).toEqual([]);
  });
}
