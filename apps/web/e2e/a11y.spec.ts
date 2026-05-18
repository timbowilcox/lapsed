import AxeBuilder from "@axe-core/playwright";
import { test, expect, seedTestMerchant, removeTestMerchant } from "./fixtures";

test.beforeAll(async () => {
  await seedTestMerchant();
});

test.afterAll(async () => {
  await removeTestMerchant();
});

const routes = [
  { name: "dashboard", path: "/app" },
  { name: "campaigns", path: "/app/campaigns" },
  { name: "conversations", path: "/app/conversations" },
  { name: "attribution", path: "/app/attribution" },
  { name: "billing-settings", path: "/app/settings/billing" },
  { name: "billing-subscribe", path: "/app/billing/subscribe" },
  { name: "billing-success", path: "/app/billing/success" },
  { name: "settings", path: "/app/settings" },
];

const previewRoutes = [
  { name: "preview-dashboard", path: "/preview" },
  { name: "preview-lapsed", path: "/preview/lapsed" },
  { name: "preview-campaigns", path: "/preview/campaigns" },
  { name: "preview-conversations", path: "/preview/conversations" },
  { name: "preview-attribution", path: "/preview/attribution" },
  { name: "preview-billing", path: "/preview/billing" },
  { name: "preview-settings", path: "/preview/settings" },
];

for (const route of routes) {
  test(`a11y: ${route.name} has no critical/serious violations`, async ({
    merchantPage: page,
  }) => {
    await page.goto(route.path, { waitUntil: "networkidle" });

    const results = await new AxeBuilder({ page })
      .disableRules(["color-contrast"]) // verified manually against Vellum tokens (4.5:1+)
      .analyze();

    const critical = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );

    if (critical.length > 0) {
      const summary = critical
        .map((v) => `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} node(s))`)
        .join("\n");
      expect.soft(critical, `Critical/serious a11y violations on ${route.path}:\n${summary}`).toHaveLength(0);
    }

    expect(critical).toHaveLength(0);
  });
}

for (const route of previewRoutes) {
  test(`a11y: ${route.name} has no critical/serious violations`, async ({ page }) => {
    await page.goto(route.path, { waitUntil: "networkidle" });

    const results = await new AxeBuilder({ page })
      .disableRules(["color-contrast"])
      .analyze();

    const critical = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );

    if (critical.length > 0) {
      const summary = critical
        .map((v) => `[${v.impact}] ${v.id}: ${v.description} (${v.nodes.length} node(s))`)
        .join("\n");
      expect.soft(critical, `Critical/serious a11y violations on ${route.path}:\n${summary}`).toHaveLength(0);
    }

    expect(critical).toHaveLength(0);
  });
}
