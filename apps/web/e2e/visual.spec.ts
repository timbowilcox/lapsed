import { test, expect, seedTestMerchant, removeTestMerchant } from "./fixtures";

/**
 * Visual regression baselines for the four primary merchant screens.
 * Run `playwright test e2e/visual.spec.ts --update-snapshots` once after
 * any intentional visual change to commit new baselines.
 */

test.beforeAll(async () => {
  await seedTestMerchant();
});

test.afterAll(async () => {
  await removeTestMerchant();
});

const screens = [
  { name: "dashboard", path: "/app" },
  { name: "billing", path: "/app/billing" },
  { name: "attribution", path: "/app/attribution" },
  { name: "conversations", path: "/app/conversations" },
];

for (const screen of screens) {
  test(`visual: ${screen.name}`, async ({ merchantPage: page }) => {
    await page.goto(screen.path, { waitUntil: "networkidle" });
    // Allow chart animations to settle
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`${screen.name}.png`, {
      fullPage: true,
      maxDiffPixelRatio: 0.01,
    });
  });
}
