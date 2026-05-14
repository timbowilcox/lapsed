import { test, expect, seedTestMerchant, removeTestMerchant } from "./fixtures";

test.beforeAll(async () => {
  await seedTestMerchant();
});

test.afterAll(async () => {
  await removeTestMerchant();
});

test("? button opens docs.lapsed.ai in a new tab", async ({ merchantPage: page }) => {
  await page.goto("/app", { waitUntil: "networkidle" });

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("link", { name: "Help" }).click(),
  ]);

  expect(popup.url()).toContain("docs.lapsed.ai");
});

test("bell button opens notifications dropdown with empty state", async ({
  merchantPage: page,
}) => {
  await page.goto("/app", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Notifications" }).click();

  await expect(page.getByText("No notifications yet")).toBeVisible();
  await expect(
    page.getByText("We'll let you know when campaigns finish or customers reply."),
  ).toBeVisible();
});

test("bell dropdown closes on second click", async ({ merchantPage: page }) => {
  await page.goto("/app", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Notifications" }).click();
  await expect(page.getByText("No notifications yet")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByText("No notifications yet")).not.toBeVisible();
});

test("avatar button opens account dropdown with all three items", async ({
  merchantPage: page,
}) => {
  await page.goto("/app", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Account menu" }).click();

  await expect(page.getByRole("menuitem", { name: /Account settings/i })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Switch shop/i })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Sign out/i })).toBeVisible();
});

test("Switch shop menu item is disabled", async ({ merchantPage: page }) => {
  await page.goto("/app", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Account menu" }).click();

  const switchShop = page.getByRole("menuitem", { name: /Switch shop/i });
  await expect(switchShop).toHaveAttribute("data-disabled");
});

test("Account settings navigates to /app/settings", async ({ merchantPage: page }) => {
  await page.goto("/app", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /Account settings/i }).click();

  await expect(page).toHaveURL(/\/app\/settings/);
});

test("sign out clears session and redirects to install page", async ({
  merchantPage: page,
}) => {
  await page.goto("/app", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /Sign out/i }).click();

  await page.waitForURL(/\/app\/auth\/install/, { timeout: 5000 });
  await expect(page).toHaveURL(/\/app\/auth\/install/);
});
