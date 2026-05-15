import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { test, expect, seedTestMerchant, removeTestMerchant, TEST_MERCHANT_SHOP } from "./fixtures";

// Use large numeric IDs that won't collide with real Shopify GIDs in test
const SCORED_NUMERIC_ID = "9876543210001";
const SCORED_GID = `gid://shopify/Customer/${SCORED_NUMERIC_ID}`;
const UNSCORED_NUMERIC_ID = "9876543210002";
const UNSCORED_GID = `gid://shopify/Customer/${UNSCORED_NUMERIC_ID}`;

function loadDbUrl(): string {
  const path = join(process.cwd(), "..", "..", ".env.local");
  const txt = readFileSync(path, "utf8");
  const m = txt.match(/^SUPABASE_DB_URL=(.+)$/m);
  if (!m) throw new Error("SUPABASE_DB_URL missing in .env.local");
  return m[1]!.trim();
}

let merchantId: string;

test.beforeAll(async () => {
  await seedTestMerchant();

  const pg = new PgClient({ connectionString: loadDbUrl() });
  await pg.connect();
  try {
    const { rows } = await pg.query<{ id: string }>(
      `select id from public.merchants where shopify_shop_domain = $1`,
      [TEST_MERCHANT_SHOP],
    );
    merchantId = rows[0]!.id;

    // Scored customer: has a customer_inferred_state row with full scoring data.
    await pg.query(
      `insert into public.customers
         (merchant_id, shopify_customer_gid, first_name, last_name, email,
          total_order_count, total_ltv_cents, lapsed_at, lapsed_score)
       values ($1, $2, 'Taylor', 'Scored', 'taylor.scored@example.com',
               5, 42000, now() - interval '90 days', 0.75)
       on conflict (merchant_id, shopify_customer_gid) do nothing`,
      [merchantId, SCORED_GID],
    );

    await pg.query(
      `insert into public.customer_inferred_state
         (merchant_id, shopify_customer_gid, lifecycle_stage,
          propensity_30d, propensity_60d, propensity_90d,
          predicted_residual_ltv_cents, top_signal,
          group_memberships, last_scored_at)
       values ($1, $2, 'lapsed',
               0.31, 0.52, 0.62,
               18500, 'High order frequency but extended inactivity',
               ARRAY['high_value', 'repeat_buyer'],
               now() - interval '2 hours')
       on conflict (merchant_id, shopify_customer_gid) do update set
         lifecycle_stage = excluded.lifecycle_stage,
         propensity_30d = excluded.propensity_30d,
         propensity_60d = excluded.propensity_60d,
         propensity_90d = excluded.propensity_90d,
         predicted_residual_ltv_cents = excluded.predicted_residual_ltv_cents,
         top_signal = excluded.top_signal,
         group_memberships = excluded.group_memberships,
         last_scored_at = excluded.last_scored_at`,
      [merchantId, SCORED_GID],
    );

    // Unscored customer: no customer_inferred_state row.
    await pg.query(
      `insert into public.customers
         (merchant_id, shopify_customer_gid, first_name, last_name, email,
          total_order_count, total_ltv_cents, lapsed_at)
       values ($1, $2, 'Alex', 'Unscored', 'alex.unscored@example.com',
               2, 15000, now() - interval '60 days')
       on conflict (merchant_id, shopify_customer_gid) do nothing`,
      [merchantId, UNSCORED_GID],
    );
  } finally {
    await pg.end();
  }
});

test.afterAll(async () => {
  const pg = new PgClient({ connectionString: loadDbUrl() });
  await pg.connect();
  try {
    await pg.query(
      `delete from public.customers
       where merchant_id = $1 and shopify_customer_gid = any($2)`,
      [merchantId, [SCORED_GID, UNSCORED_GID]],
    );
  } finally {
    await pg.end();
  }
  await removeTestMerchant();
});

test("Signals panel: shows full scoring data for a scored customer", async ({
  merchantPage: page,
}) => {
  await page.goto(`/app/lapsed/${SCORED_NUMERIC_ID}`, { waitUntil: "networkidle" });

  // Correct customer loaded
  await expect(page.getByTestId("customer-name")).toContainText("Taylor Scored");

  // Signals panel header present
  await expect(page.getByText("Signals", { exact: true })).toBeVisible();

  // Lifecycle badge shows correct stage
  await expect(page.getByText("Lapsed", { exact: true })).toBeVisible();

  // top_signal reasoning row surfaces the scoring rationale
  await expect(
    page.getByText("High order frequency but extended inactivity"),
  ).toBeVisible();

  // Return probability section with progress bars
  await expect(page.getByText("Return probability")).toBeVisible();
  const bars = page.getByRole("progressbar");
  await expect(bars).toHaveCount(3);

  // Propensity percentages rendered (31%, 52%, 62%)
  await expect(page.getByText("~31%")).toBeVisible();
  await expect(page.getByText("~52%")).toBeVisible();
  await expect(page.getByText("~62%")).toBeVisible();

  // Est. residual value section — $185.00 from 18500 cents
  await expect(page.getByText("Est. residual value")).toBeVisible();
  await expect(page.getByText("$185.00")).toBeVisible();

  // Group membership chips
  await expect(page.getByText("high_value")).toBeVisible();
  await expect(page.getByText("repeat_buyer")).toBeVisible();

  // Last scored timestamp present
  await expect(page.getByText(/Scored/)).toBeVisible();

  // Unscored empty state NOT shown
  await expect(page.getByText("Not scored yet")).not.toBeVisible();
});

test("Signals panel: shows unscored empty state when no inferred state exists", async ({
  merchantPage: page,
}) => {
  await page.goto(`/app/lapsed/${UNSCORED_NUMERIC_ID}`, { waitUntil: "networkidle" });

  // Correct customer loaded
  await expect(page.getByTestId("customer-name")).toContainText("Alex Unscored");

  // Signals panel header still present
  await expect(page.getByText("Signals", { exact: true })).toBeVisible();

  // Unscored empty state shown
  await expect(
    page.getByText("Not scored yet — check back after tomorrow's run."),
  ).toBeVisible();

  // No propensity bars rendered
  await expect(page.getByRole("progressbar")).toHaveCount(0);

  // No residual value section
  await expect(page.getByText("Est. residual value")).not.toBeVisible();
});
