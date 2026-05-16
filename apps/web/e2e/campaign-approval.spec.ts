// E2E for the Sprint 06 campaign approval flow (chunk 12).
//
// Exercises the genuinely browser-reachable Sprint 06 surfaces end to end
// against a real database: the approval surface, the campaign list tabs, and
// the bandit-state inspector. Proposals are seeded directly into Postgres —
// they stand in for the AI Campaign Designer's output, since proposal
// GENERATION (proposeCampaign) is a server-side orchestrator with no HTTP or
// UI trigger in Sprint 06. See HANDOFF.md "Deliberate deviations" for why the
// SPRINT.md "trigger campaign proposal" / "cap exhaustion → 429" items are
// covered by packages/core unit tests rather than this browser test.
//
// Flow: seed proposals → approval surface shows 3 variants → approve →
// proposal appears in the list's "Approved" tab → bandit inspector shows the
// 3 initialized arms → getReadyCampaigns returns the approved proposal.
// Plus: reject-with-reason, and the 409 invalid-state failure path.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client as PgClient } from "pg";
import { createMerchantClient, mintMerchantJwt } from "@lapsed/db";
import { getReadyCampaigns } from "@lapsed/core";
import {
  test,
  expect,
  seedTestMerchant,
  removeTestMerchant,
  TEST_MERCHANT_SHOP,
} from "./fixtures";

// ─────────────────────────────────────────────────────────────────────────────
// Env
// ─────────────────────────────────────────────────────────────────────────────

interface SupabaseEnv {
  url: string;
  publishableKey: string;
  jwtSecret: string;
  dbUrl: string;
}

function loadSupabaseEnv(): SupabaseEnv {
  const path = join(process.cwd(), "..", "..", ".env.local");
  const txt = readFileSync(path, "utf8");
  function pick(name: string): string {
    const m = txt.match(new RegExp(`^${name}=(.+)$`, "m"));
    if (!m) throw new Error(`${name} missing in .env.local`);
    return m[1]!.trim();
  }
  return {
    url: pick("NEXT_PUBLIC_SUPABASE_URL"),
    publishableKey: pick("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    jwtSecret: pick("SUPABASE_JWT_SECRET"),
    dbUrl: pick("SUPABASE_DB_URL"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeding
// ─────────────────────────────────────────────────────────────────────────────

// Three proposals, one per scenario. group_slug doubles as the human label the
// UI renders (via groupLabel), so each is independently locatable on screen.
const GROUP_APPROVE = "lapsed_vips"; // → "Lapsed VIPs"
const GROUP_REJECT = "at_risk_regulars"; // → "At-risk regulars"
const GROUP_CONFLICT = "single_purchase_converters"; // → "Single-purchase converters"

const env = loadSupabaseEnv();

let merchantId: string;
let approveProposalId: string;
let conflictProposalId: string;

/** Seeds one `proposed` proposal with 3 arms, a group snapshot, and a
 *  campaign_proposed event — the shape proposeCampaign would have written. */
async function seedProposal(
  pg: PgClient,
  groupSlug: string,
  generatedAt: string,
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into public.campaign_proposals
       (merchant_id, group_slug, model_version, generated_at)
     values ($1, $2, 'claude-sonnet-4-6-e2e', $3)
     returning id`,
    [merchantId, groupSlug, generatedAt],
  );
  const proposalId = rows[0]!.id;

  await pg.query(
    `insert into public.campaign_arms
       (proposal_id, merchant_id, variant_index, offer_type, offer_value,
        message_draft, send_time_window, tone)
     values
       ($1, $2, 0, 'percent_discount', '15% off',
        'Your favourites are waiting — 15% off this week.', 'evening', 'warm'),
       ($1, $2, 1, 'free_shipping', 'Free shipping',
        'Come back to free shipping on your next order.', 'morning', 'direct'),
       ($1, $2, 2, 'free_gift', 'Free sample',
        'A free sample is yours on your next order.', 'midday', 'playful')`,
    [proposalId, merchantId],
  );

  for (let i = 0; i < 5; i++) {
    await pg.query(
      `insert into public.campaign_group_snapshots
         (proposal_id, merchant_id, customer_id, included_in_holdout)
       values ($1, $2, $3, $4)`,
      [proposalId, merchantId, `gid://shopify/Customer/e2e-${proposalId}-${i}`, i === 0],
    );
  }

  await pg.query(
    `insert into public.campaign_events
       (merchant_id, proposal_id, event_type, payload, occurred_at)
     values ($1, $2, 'campaign_proposed', $3::jsonb, $4)`,
    [
      merchantId,
      proposalId,
      JSON.stringify({ variant_count: 3, model_version: "claude-sonnet-4-6-e2e" }),
      generatedAt,
    ],
  );

  return proposalId;
}

/** Removes every campaign row for the test merchant. session_replication_role
 *  = replica disables the append-only trigger on campaign_events. */
async function purgeCampaignData(pg: PgClient): Promise<void> {
  await pg.query(`set session_replication_role = 'replica'`);
  await pg.query(`delete from public.bandit_state where merchant_id = $1`, [merchantId]);
  await pg.query(`delete from public.campaign_arms where merchant_id = $1`, [merchantId]);
  await pg.query(`delete from public.campaign_group_snapshots where merchant_id = $1`, [
    merchantId,
  ]);
  await pg.query(`delete from public.campaign_events where merchant_id = $1`, [merchantId]);
  // Superseding versions before their roots — supersedes_proposal_id is ON DELETE RESTRICT.
  await pg.query(
    `delete from public.campaign_proposals
     where merchant_id = $1 and supersedes_proposal_id is not null`,
    [merchantId],
  );
  await pg.query(`delete from public.campaign_proposals where merchant_id = $1`, [merchantId]);
  await pg.query(`set session_replication_role = 'origin'`);
}

test.beforeAll(async () => {
  await seedTestMerchant();
  const pg = new PgClient({ connectionString: env.dbUrl });
  await pg.connect();
  try {
    const { rows } = await pg.query<{ id: string }>(
      `select id from public.merchants where shopify_shop_domain = $1`,
      [TEST_MERCHANT_SHOP],
    );
    merchantId = rows[0]!.id;

    // Idempotent: clear anything a prior aborted run left behind.
    await purgeCampaignData(pg);

    approveProposalId = await seedProposal(pg, GROUP_APPROVE, "2026-05-14T10:00:00.000Z");
    // The reject test locates its proposal by group name on screen, not by id.
    await seedProposal(pg, GROUP_REJECT, "2026-05-13T10:00:00.000Z");
    conflictProposalId = await seedProposal(pg, GROUP_CONFLICT, "2026-05-12T10:00:00.000Z");
  } finally {
    await pg.end();
  }
});

test.afterAll(async () => {
  const pg = new PgClient({ connectionString: env.dbUrl });
  await pg.connect();
  try {
    await purgeCampaignData(pg);
  } finally {
    await pg.end();
  }
  await removeTestMerchant();
});

// ─────────────────────────────────────────────────────────────────────────────
// Approval flow: approve → Approved tab → bandit inspector → getReadyCampaigns
// ─────────────────────────────────────────────────────────────────────────────

test("approving a proposal moves it to the Approved tab and initializes bandit arms", async ({
  merchantPage: page,
}) => {
  await page.goto("/app/campaigns", { waitUntil: "domcontentloaded" });

  // The pending proposal is listed; opening it shows all three variants.
  const card = page.getByRole("button", { name: /Lapsed VIPs/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Variant 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Variant 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Variant 3", { exact: true })).toBeVisible();

  // Approve — the dialog closes and the proposal leaves the pending list.
  await page.getByRole("button", { name: "Approve campaign" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Lapsed VIPs/ })).toHaveCount(0);

  // It now shows under the campaign list's "Approved" tab.
  await page.goto("/app/campaigns/list", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Approved" }).click();
  const approvedLink = page.getByRole("link", { name: /Lapsed VIPs/ });
  await expect(approvedLink).toBeVisible({ timeout: 10_000 });

  // The approved card links through to the bandit-state inspector.
  await approvedLink.click();
  await expect(page).toHaveURL(new RegExp(`/app/campaigns/${approveProposalId}/bandit`));
  await expect(
    page.getByRole("heading", { name: /Lapsed VIPs — bandit state/ }),
  ).toBeVisible();

  // Three arms were initialized at approval, each a neutral Beta(1,1) prior.
  await expect(page.getByText("Mean response rate")).toBeVisible();
  const armRows = page.locator("tbody tr");
  await expect(armRows).toHaveCount(3);
  // Beta(1,1) mean is 50.0%; observation counts are 0 (no campaign has run).
  await expect(page.getByText("50.0%").first()).toBeVisible();

  // getReadyCampaigns — the surface Sprint 07's conversation engine consumes —
  // now returns the approved proposal (decision 13: ready only after approval).
  const jwt = await mintMerchantJwt({
    shopDomain: TEST_MERCHANT_SHOP,
    jwtSecret: env.jwtSecret,
  });
  const client = createMerchantClient({
    url: env.url,
    publishableKey: env.publishableKey,
    merchantJwt: jwt,
  });
  const ready = await getReadyCampaigns(client, merchantId);
  expect(ready.some((r) => r.proposalId === approveProposalId)).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Reject flow
// ─────────────────────────────────────────────────────────────────────────────

test("rejecting a proposal records the reason and moves it to the Rejected tab", async ({
  merchantPage: page,
}) => {
  await page.goto("/app/campaigns", { waitUntil: "domcontentloaded" });

  const card = page.getByRole("button", { name: /At-risk regulars/ });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Reject" }).click();

  // A reason is required before the reject confirms.
  const reason = "Offer is too aggressive for this group.";
  await page.getByLabel("Why are you rejecting this campaign?").fill(reason);
  await page.getByRole("button", { name: "Reject campaign" }).click();

  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: /At-risk regulars/ })).toHaveCount(0);

  // The Rejected tab surfaces it, with the recorded reason.
  await page.goto("/app/campaigns/list", { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Rejected" }).click();
  await expect(page.getByText("At-risk regulars")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`Reason: ${reason}`)).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure path: a state transition on an already-decided proposal returns 409
// ─────────────────────────────────────────────────────────────────────────────

test("approving an already-rejected proposal returns a 409 conflict", async ({
  merchantPage: page,
}) => {
  // Establish a browser session so the API requests carry the merchant cookie.
  await page.goto("/app/campaigns", { waitUntil: "domcontentloaded" });

  // Reject the proposal through the API.
  const rejectRes = await page.request.post(
    `/api/campaigns/${conflictProposalId}/reject`,
    { data: { userId: merchantId, reason: "Rejecting to set up the conflict case." } },
  );
  expect(rejectRes.ok()).toBe(true);

  // Approving the now-rejected proposal is an invalid transition → 409, not a
  // silent success and not a 500.
  const approveRes = await page.request.post(
    `/api/campaigns/${conflictProposalId}/approve`,
    { data: { userId: merchantId } },
  );
  expect(approveRes.status()).toBe(409);
});
