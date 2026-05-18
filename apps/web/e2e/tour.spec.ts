import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  test,
  expect,
  seedTestMerchant,
  removeTestMerchant,
} from "./fixtures";

const screenshotDir = join(process.cwd(), "..", "..", "_evidence", "sprint-02", "screenshots");

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true });
  await seedTestMerchant();
});

test.afterAll(async () => {
  await removeTestMerchant();
});

interface RouteCheck {
  name: string;
  path: string;
  expect: string;
}

const routes: RouteCheck[] = [
  { name: "01-root-redirect", path: "/", expect: "Restored revenue · last 30 days" },
  { name: "02-install", path: "/app/auth/install", expect: "Install lapsed on your Shopify store" },
  { name: "03-dashboard", path: "/app", expect: "Restored revenue · last 30 days" },
  { name: "04-lapsed-list", path: "/app/lapsed", expect: "Lapsed customers" },
  { name: "05-lapsed-detail", path: "/app/lapsed/lap_001", expect: "Jess Reilly" },
  { name: "06-campaigns", path: "/app/campaigns", expect: "Manage your active, draft and paused" },
  { name: "07-campaign-new", path: "/app/campaigns/new", expect: "Audience" },
  { name: "08-campaign-detail", path: "/app/campaigns/cam_001", expect: "Summer dormant" },
  {
    name: "09-conversations",
    path: "/app/conversations",
    expect: "Two-way threads from active campaigns",
  },
  { name: "10-conversation-detail", path: "/app/conversations/conv_001", expect: "Jess Reilly" },
  { name: "11-attribution", path: "/app/attribution", expect: "Restored revenue" },
  { name: "12-billing", path: "/app/billing", expect: "Manage your subscription" },
  { name: "13-settings", path: "/app/settings", expect: "Brand voice" },
  { name: "14-onboarding", path: "/app/onboarding", expect: "Your store is connected" },
];

for (const route of routes) {
  test(`tour ${route.name}: ${route.path}`, async ({ merchantPage: page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // App Bridge logs a console warning when loaded with the
      // automatic `async` attribute that React 19 / Next.js inject.
      // The bridge still initialises correctly inside Shopify Admin
      // and the warning is purely informational. Filter it from the
      // strict console-error gate.
      if (text.includes("App Bridge has `async`")) return;
      consoleErrors.push(text);
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

test("dashboard renders the real shop domain from the session", async ({ merchantPage: page }) => {
  await page.goto("/app", { waitUntil: "networkidle" });
  // The sidebar's ShopSwitcher should show the prettified name, not "Bondi Goods".
  await expect(page.getByText("Lapsed Test", { exact: false })).toBeVisible();
  await expect(page.getByText("Bondi Goods")).toHaveCount(0);
});
