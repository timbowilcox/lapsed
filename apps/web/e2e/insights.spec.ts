import {
  test,
  expect,
  seedTestMerchant,
  removeTestMerchant,
  seedCohortInsight,
  clearInsights,
} from "./fixtures";

// AI recommendations E2E (Sprint 11, chunk 13).
//
// Seeds a cohort-category insight row directly into the insights table, then
// verifies the deterministic engine→API→UI path: the seeded signal surfaces
// on /app/campaigns as a "suggested campaign" card, and the "Spin up" CTA
// routes into the campaign wizard pre-filled with the cohort.

const INSIGHT_KEY = "cohort:lapsed_vip_dormancy";
const GROUP_SLUG = "lapsed_vips";
const MERCHANT_COPY = "E2E TEST — 42 dormant VIP customers ready for a win-back.";
const SIGNAL_VALUE = 42;

test.beforeAll(async () => {
  await seedTestMerchant();
});

test.beforeEach(async () => {
  await seedCohortInsight({
    insightKey: INSIGHT_KEY,
    groupSlug: GROUP_SLUG,
    merchantCopy: MERCHANT_COPY,
    signalValue: SIGNAL_VALUE,
  });
});

test.afterEach(async () => {
  await clearInsights();
});

test.afterAll(async () => {
  await removeTestMerchant();
});

test("seeded cohort insight renders as a suggested campaign card", async ({
  merchantPage: page,
}) => {
  await page.goto("/app/campaigns", { waitUntil: "networkidle" });

  // The suggested-campaigns section consumes the insights engine output.
  await expect(page.getByRole("heading", { name: "Suggested for you" })).toBeVisible();

  // The card derives its customer count from the seeded signal_value.
  await expect(
    page.getByText(`${SIGNAL_VALUE} customers ready to re-engage`),
  ).toBeVisible();

  // The seeded merchant-facing copy is carried in the "Why suggested" tooltip.
  await expect(page.getByRole("tooltip")).toContainText(MERCHANT_COPY);
});

test("Spin up routes to the campaign wizard pre-filled with the cohort", async ({
  merchantPage: page,
}) => {
  await page.goto("/app/campaigns", { waitUntil: "networkidle" });

  await page.getByRole("button", { name: "Spin up this campaign" }).click();

  // Navigates into the manual wizard carrying the cohort as a query param.
  await expect(page).toHaveURL(/\/app\/campaigns\/new\?groupSlug=lapsed_vips/);
});
