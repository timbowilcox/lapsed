/**
 * Cross-tenant RLS isolation test.
 *
 * Setup/teardown via direct pg (bypasses RLS as the postgres superuser).
 * The actual isolation checks use the publishable-key Supabase JS
 * client + a per-merchant JWT — exercising the same path the merchant
 * dashboard uses in production. Tampered / wrong / missing JWT claims
 * must return zero rows.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
 * SUPABASE_JWT_SECRET, SUPABASE_DB_URL in .env.local.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";
import { randomBytes } from "node:crypto";
import { createMerchantClient, mintMerchantJwt, encryptToken } from "../src";

interface Env {
  url: string;
  publishableKey: string;
  jwtSecret: string;
  dbUrl: string;
}

/**
 * Resolve Supabase credentials. Prefers process.env (CI path), falls
 * back to .env.local (developer machine). Returns null when no
 * credentials are available — tests `it.skipIf` on that.
 */
function loadEnv(): Env | null {
  function pick(k: string, txt: string | null): string | undefined {
    if (process.env[k]) return process.env[k]!;
    if (!txt) return undefined;
    const m = txt.match(new RegExp(`^${k}=(.+)$`, "m"));
    return m ? m[1]!.trim() : undefined;
  }
  const envPath = join(__dirname, "..", "..", "..", ".env.local");
  const txt = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  const url = pick("NEXT_PUBLIC_SUPABASE_URL", txt);
  const publishableKey = pick("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", txt);
  const jwtSecret = pick("SUPABASE_JWT_SECRET", txt);
  const dbUrl = pick("SUPABASE_DB_URL", txt);
  if (!url || !publishableKey || !jwtSecret || !dbUrl) return null;
  return { url, publishableKey, jwtSecret, dbUrl };
}

const SUPABASE_AVAILABLE = loadEnv() !== null;

/**
 * Set to false in beforeAll when SUPABASE_AVAILABLE is true but the dev DB
 * schema is incomplete (e.g., Sprint 04 tables not yet migrated). Every test
 * in this file calls ctx.skip() via the global beforeEach when schemaReady is
 * false, so the file exits 0 with all tests cleanly skipped rather than erroring.
 */
let schemaReady = true;

// Skip any live-DB test at runtime when the schema is incomplete.
beforeEach((ctx) => {
  if (!schemaReady) ctx.skip();
});

const SHOP_A = `rls-test-a-${Date.now()}.myshopify.com`;
const SHOP_B = `rls-test-b-${Date.now()}.myshopify.com`;
const ENCRYPTION_KEY = randomBytes(32);

let env!: Env;
let merchantIdA: string;
let merchantIdB: string;

const GID_A = "gid://shopify/Customer/111";
const GID_B = "gid://shopify/Customer/222";
const ORDER_GID_A = "gid://shopify/Order/1001";
const ORDER_GID_B = "gid://shopify/Order/2002";
const PRODUCT_GID_A = "gid://shopify/Product/3001";
const PRODUCT_GID_B = "gid://shopify/Product/4002";

beforeAll(async () => {
  if (!SUPABASE_AVAILABLE) return;
  env = loadEnv()!;
  const pg = new PgClient({ connectionString: env.dbUrl });
  await pg.connect();
  try {
    // Verify the required tables exist before attempting any inserts.
    // Sprint 04 tables (customer_events, scoring_runs, etc.) may be absent on
    // a fresh dev machine that hasn't run the migration yet. When any table is
    // missing, mark schemaReady=false so all tests skip cleanly via beforeEach.
    const { rows } = await pg.query<{ count: number }>(
      `select count(*)::int as count from information_schema.tables
       where table_schema = 'public'
         and table_name in (
           'customer_events','order_events',
           'customers','scoring_runs',
           'storefront_snapshots','voice_events','voice_versions','agent_profiles',
           'conversations','messages','message_events','customer_opt_outs',
           'merchant_attribution_config','attribution_results',
           'attribution_decisions','ltv_snapshots',
           'merchant_subscriptions','subscription_events'
         )`,
    );
    if ((rows[0]?.count ?? 0) < 18) {
      schemaReady = false;
      console.warn("[rls.test] Required tables missing — skipping all RLS tests");
      return;
    }

    const tokenA = encryptToken("shpat_token_A", ENCRYPTION_KEY);
    const tokenB = encryptToken("shpat_token_B", ENCRYPTION_KEY);
    const res = await pg.query<{ id: string; shopify_shop_domain: string }>(
      `insert into public.merchants
         (shopify_shop_domain, shopify_access_token, shopify_scope)
       values ($1, $2, 'read_orders'), ($3, $4, 'read_orders')
       returning id, shopify_shop_domain`,
      [SHOP_A, tokenA, SHOP_B, tokenB],
    );
    for (const row of res.rows) {
      if (row.shopify_shop_domain === SHOP_A) merchantIdA = row.id;
      else merchantIdB = row.id;
    }

    // Seed Sprint 03 table fixtures for both merchants
    const NOW = new Date().toISOString();

    // customer_events
    await pg.query(
      `insert into public.customer_events
         (merchant_id, shopify_customer_gid, event_type, source, occurred_at)
       values ($1, $2, 'customer_created', 'shopify', $5),
              ($3, $4, 'customer_created', 'shopify', $5)`,
      [merchantIdA, GID_A, merchantIdB, GID_B, NOW],
    );

    // customers
    await pg.query(
      `insert into public.customers
         (merchant_id, shopify_customer_gid)
       values ($1, $2), ($3, $4)`,
      [merchantIdA, GID_A, merchantIdB, GID_B],
    );

    // order_events
    await pg.query(
      `insert into public.order_events
         (merchant_id, shopify_customer_gid, shopify_order_gid, event_type, source, occurred_at)
       values ($1, $2, $3, 'orders_paid', 'shopify', $7),
              ($4, $5, $6, 'orders_paid', 'shopify', $7)`,
      [merchantIdA, GID_A, ORDER_GID_A, merchantIdB, GID_B, ORDER_GID_B, NOW],
    );

    // orders
    await pg.query(
      `insert into public.orders
         (merchant_id, shopify_order_gid, shopify_customer_gid, total_price_cents, financial_status, shopify_created_at)
       values ($1, $2, $3, 9999, 'paid', $7),
              ($4, $5, $6, 4999, 'paid', $7)`,
      [merchantIdA, ORDER_GID_A, GID_A, merchantIdB, ORDER_GID_B, GID_B, NOW],
    );

    // products
    await pg.query(
      `insert into public.products
         (merchant_id, shopify_product_gid, title, handle)
       values ($1, $2, 'Product A', 'product-a'),
              ($3, $4, 'Product B', 'product-b')`,
      [merchantIdA, PRODUCT_GID_A, merchantIdB, PRODUCT_GID_B],
    );

    // Sprint 07: conversations (per-customer — decision 16), one message,
    // one message_event, and one opt-out per merchant.
    const convRes = await pg.query<{ id: string; merchant_id: string }>(
      `insert into public.conversations
         (merchant_id, customer_id)
       values ($1, $2), ($3, $4)
       returning id, merchant_id`,
      [merchantIdA, GID_A, merchantIdB, GID_B],
    );
    for (const conv of convRes.rows) {
      const customerId = conv.merchant_id === merchantIdA ? GID_A : GID_B;
      const msgRes = await pg.query<{ id: string }>(
        `insert into public.messages
           (merchant_id, conversation_id, direction, body, pii_redacted_body, status)
         values ($1, $2, 'outbound', 'hello', 'hello', 'sent')
         returning id`,
        [conv.merchant_id, conv.id],
      );
      const messageId = msgRes.rows[0]!.id;
      await pg.query(
        `insert into public.message_events
           (merchant_id, conversation_id, message_id, event_type, payload, occurred_at)
         values ($1, $2, $3, 'message_outbound_sent', '{}'::jsonb, now())`,
        [conv.merchant_id, conv.id, messageId],
      );
      await pg.query(
        `insert into public.customer_opt_outs
           (merchant_id, customer_id, phone_number, source, inbound_message_id)
         values ($1, $2, '+15550000000', 'merchant_manual', null)`,
        [conv.merchant_id, customerId],
      );
    }

    // webhook_deliveries (merchant A only)
    await pg.query(
      `insert into public.webhook_deliveries
         (merchant_id, topic, shopify_webhook_id, payload)
       values ($1, 'orders/paid', 'whid_test_rls', '{}')`,
      [merchantIdA],
    );

    // Sprint 04: customer_rfm
    await pg.query(
      `insert into public.customer_rfm
         (merchant_id, shopify_customer_gid, frequency, monetary_cents, lifecycle_stage)
       values ($1, $2, 3, 29997, 'lapsed'),
              ($3, $4, 1, 4999,  'new')`,
      [merchantIdA, GID_A, merchantIdB, GID_B],
    );

    // Sprint 04: scoring_runs
    await pg.query(
      `insert into public.scoring_runs
         (merchant_id, model_version, status)
       values ($1, 'claude-haiku-4-5-20251001', 'succeeded'),
              ($2, 'claude-haiku-4-5-20251001', 'succeeded')`,
      [merchantIdA, merchantIdB],
    );

    // Sprint 04: merchant_scoring_caps
    await pg.query(
      `insert into public.merchant_scoring_caps
         (merchant_id, daily_token_cap)
       values ($1, 10000000),
              ($2, 10000000)
       on conflict (merchant_id) do nothing`,
      [merchantIdA, merchantIdB],
    );

    // Sprint 04: customer_inferred_state
    await pg.query(
      `insert into public.customer_inferred_state
         (merchant_id, shopify_customer_gid, lifecycle_stage, group_memberships)
       values ($1, $2, 'lapsed', ARRAY['lapsed_vips']),
              ($3, $4, 'new',    ARRAY[]::text[])`,
      [merchantIdA, GID_A, merchantIdB, GID_B],
    );

    // Sprint 05: storefront_snapshots — A and B, distinct source_hash per row
    const snapshotRes = await pg.query<{ id: string; merchant_id: string }>(
      `insert into public.storefront_snapshots
         (merchant_id, raw_content, redacted_content, pii_match_summary, source_hash)
       values ($1, '{"about":"about-A"}'::jsonb, '{"about":"about-A"}'::jsonb, '{}'::jsonb, 'hash_A_rls'),
              ($2, '{"about":"about-B"}'::jsonb, '{"about":"about-B"}'::jsonb, '{}'::jsonb, 'hash_B_rls')
       returning id, merchant_id`,
      [merchantIdA, merchantIdB],
    );
    const snapshotIdByMerchant = new Map<string, string>();
    for (const row of snapshotRes.rows) snapshotIdByMerchant.set(row.merchant_id, row.id);

    // Sprint 05: voice_events — append-only, one per merchant
    await pg.query(
      `insert into public.voice_events
         (merchant_id, event_type, source, payload, occurred_at)
       values ($1, 'voice_extracted', 'install_orchestrator', '{"version_id":"00000000-0000-0000-0000-000000000001"}'::jsonb, now()),
              ($2, 'voice_extracted', 'install_orchestrator', '{"version_id":"00000000-0000-0000-0000-000000000002"}'::jsonb, now())`,
      [merchantIdA, merchantIdB],
    );

    // Sprint 05: voice_versions — one row per merchant, bound to the snapshot
    const versionRes = await pg.query<{ id: string; merchant_id: string }>(
      `insert into public.voice_versions
         (merchant_id, version_number, source_snapshot_id, profile, model_version, prompt_version)
       values ($1, 1, $3, '{"tone_descriptors":["warm"]}'::jsonb, 'claude-sonnet-4-6-test', 'v1'),
              ($2, 1, $4, '{"tone_descriptors":["direct"]}'::jsonb, 'claude-sonnet-4-6-test', 'v1')
       returning id, merchant_id`,
      [
        merchantIdA, merchantIdB,
        snapshotIdByMerchant.get(merchantIdA),
        snapshotIdByMerchant.get(merchantIdB),
      ],
    );
    const versionIdByMerchant = new Map<string, string>();
    for (const row of versionRes.rows) versionIdByMerchant.set(row.merchant_id, row.id);

    // Sprint 05: agent_profiles — one row per merchant
    await pg.query(
      `insert into public.agent_profiles
         (merchant_id, active_voice_version_id, role_descriptor)
       values ($1, $2, 'win_back_specialist'),
              ($3, $4, 'win_back_specialist')`,
      [
        merchantIdA, versionIdByMerchant.get(merchantIdA),
        merchantIdB, versionIdByMerchant.get(merchantIdB),
      ],
    );

    // Sprint 08: campaign_proposals — one per merchant, parent of the
    // attribution tables seeded below.
    const proposalRes = await pg.query<{ id: string; merchant_id: string }>(
      `insert into public.campaign_proposals
         (merchant_id, group_slug, model_version)
       values ($1, 'lapsed_vips', 'claude-sonnet-4-6-test'),
              ($2, 'lapsed_vips', 'claude-sonnet-4-6-test')
       returning id, merchant_id`,
      [merchantIdA, merchantIdB],
    );
    const proposalIdByMerchant = new Map<string, string>();
    for (const row of proposalRes.rows) proposalIdByMerchant.set(row.merchant_id, row.id);

    // Sprint 08: merchant_attribution_config — one per merchant
    await pg.query(
      `insert into public.merchant_attribution_config (merchant_id)
       values ($1), ($2)`,
      [merchantIdA, merchantIdB],
    );

    // Sprint 08: attribution_results — one per merchant
    await pg.query(
      `insert into public.attribution_results
         (merchant_id, campaign_id, window_close_date, treatment_cohort_size,
          holdout_cohort_size, treatment_revenue_cents, holdout_revenue_cents,
          incremental_revenue_cents, ltv_restored_cents)
       values ($1, $2, current_date, 40, 10, 200000, 30000, 170000, 150000),
              ($3, $4, current_date, 40, 10, 200000, 30000, 170000, 150000)`,
      [
        merchantIdA, proposalIdByMerchant.get(merchantIdA),
        merchantIdB, proposalIdByMerchant.get(merchantIdB),
      ],
    );

    // Sprint 08: attribution_decisions — one 'no_order' decision per merchant
    await pg.query(
      `insert into public.attribution_decisions
         (merchant_id, customer_id, decision_type, attributed_campaign_id,
          attribution_window_days)
       values ($1, $2, 'no_order', $3, 14),
              ($4, $5, 'no_order', $6, 14)`,
      [
        merchantIdA, GID_A, proposalIdByMerchant.get(merchantIdA),
        merchantIdB, GID_B, proposalIdByMerchant.get(merchantIdB),
      ],
    );

    // Sprint 08: ltv_snapshots — one per merchant
    await pg.query(
      `insert into public.ltv_snapshots
         (merchant_id, campaign_id, customer_id, pre_30d_revenue_cents,
          post_30d_revenue_cents, delta_cents)
       values ($1, $2, $3, 10000, 25000, 15000),
              ($4, $5, $6, 10000, 25000, 15000)`,
      [
        merchantIdA, proposalIdByMerchant.get(merchantIdA), GID_A,
        merchantIdB, proposalIdByMerchant.get(merchantIdB), GID_B,
      ],
    );

    // Sprint 09: merchant_subscriptions — one per merchant
    await pg.query(
      `insert into public.merchant_subscriptions
         (merchant_id, stripe_subscription_id, tier, status,
          current_period_start, current_period_end)
       values ($1, $2, 'growth', 'active', now(), now() + interval '30 days'),
              ($3, $4, 'starter', 'active', now(), now() + interval '30 days')`,
      [
        merchantIdA, `sub_rls_a_${Date.now()}`,
        merchantIdB, `sub_rls_b_${Date.now()}`,
      ],
    );

    // Sprint 09: subscription_events — one per merchant
    await pg.query(
      `insert into public.subscription_events
         (merchant_id, stripe_event_id, event_type, data)
       values ($1, $2, 'customer.subscription.created', '{}'::jsonb),
              ($3, $4, 'customer.subscription.created', '{}'::jsonb)`,
      [
        merchantIdA, `evt_rls_a_${Date.now()}`,
        merchantIdB, `evt_rls_b_${Date.now()}`,
      ],
    );
  } finally {
    await pg.end();
  }
});

afterAll(async () => {
  if (!SUPABASE_AVAILABLE || !schemaReady) return;
  const pg = new PgClient({ connectionString: env.dbUrl });
  await pg.connect();
  try {
    // session_replication_role = 'replica' disables non-replica triggers for this
    // session so that the append-only BEFORE DELETE triggers on customer_events,
    // order_events, and voice_events don't block cleanup. Revert immediately after
    // event-table deletes.
    await pg.query(`set session_replication_role = 'replica'`);

    // Delete in FK dependency order (leaf tables before parent tables).
    // Sprint 07: customer_opt_outs + message_events FK messages; messages FK
    // conversations. customer_opt_outs + message_events are append-only — the
    // session_replication_role='replica' set above disables their triggers.
    await pg.query(
      `delete from public.customer_opt_outs where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.message_events where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.messages where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.conversations where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.customer_events where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.order_events where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    // Sprint 08: attribution_decisions is append-only — delete it here while
    // session_replication_role='replica' disables its triggers.
    await pg.query(
      `delete from public.attribution_decisions where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    // Sprint 09: subscription_events is append-only — delete here too, while
    // session_replication_role='replica' disables its triggers.
    await pg.query(
      `delete from public.subscription_events where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.orders where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.customers where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.products where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.webhook_deliveries where shopify_webhook_id = 'whid_test_rls'`,
    );

    // Sprint 04 tables (delete before merchants due to RESTRICT FK)
    await pg.query(
      `delete from public.customer_inferred_state where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.customer_rfm where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.scoring_runs where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.merchant_scoring_caps where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );

    // Sprint 05 tables — agent_profiles -> voice_versions -> voice_events -> storefront_snapshots
    await pg.query(
      `delete from public.agent_profiles where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.voice_versions where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.voice_events where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.storefront_snapshots where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );

    await pg.query(`set session_replication_role = 'origin'`);

    // Sprint 08: attribution tables (delete before campaign_proposals + merchants
    // due to RESTRICT FKs).
    // Sprint 09: merchant_subscriptions (not append-only — safe in 'origin').
    await pg.query(
      `delete from public.merchant_subscriptions where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.attribution_results where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.ltv_snapshots where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.merchant_attribution_config where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );
    await pg.query(
      `delete from public.campaign_proposals where merchant_id = any($1::uuid[])`,
      [[merchantIdA, merchantIdB]],
    );

    // Merchants last — all RESTRICT FKs are now satisfied.
    await pg.query(
      `delete from public.merchants where shopify_shop_domain = any($1)`,
      [[SHOP_A, SHOP_B]],
    );
  } finally {
    await pg.end();
  }
});

describe.skipIf(!SUPABASE_AVAILABLE)("RLS — merchants_self_read", () => {
  it("merchant A sees their own row", async () => {
    const jwt = await mintMerchantJwt({ shopDomain: SHOP_A, jwtSecret: env.jwtSecret });
    const client = createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: jwt,
    });
    const { data, error } = await client
      .from("merchants")
      .select("shopify_shop_domain");
    expect(error).toBeNull();
    expect(data).toEqual([{ shopify_shop_domain: SHOP_A }]);
  });

  it("merchant A cannot see merchant B's row", async () => {
    const jwt = await mintMerchantJwt({ shopDomain: SHOP_A, jwtSecret: env.jwtSecret });
    const client = createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: jwt,
    });
    const { data, error } = await client
      .from("merchants")
      .select("shopify_shop_domain")
      .eq("shopify_shop_domain", SHOP_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("merchant B sees only their own row", async () => {
    const jwt = await mintMerchantJwt({ shopDomain: SHOP_B, jwtSecret: env.jwtSecret });
    const client = createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: jwt,
    });
    const { data, error } = await client
      .from("merchants")
      .select("shopify_shop_domain");
    expect(error).toBeNull();
    expect(data).toEqual([{ shopify_shop_domain: SHOP_B }]);
  });

  it("a JWT signed with the wrong secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret-not-matching-supabase-jwt-config",
    });
    const client = createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    });
    const { data } = await client.from("merchants").select("shopify_shop_domain");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a Supabase client for a given shop domain
// ─────────────────────────────────────────────────────────────────────────────
async function clientFor(shop: string) {
  const jwt = await mintMerchantJwt({ shopDomain: shop, jwtSecret: env.jwtSecret });
  return createMerchantClient({
    url: env.url,
    publishableKey: env.publishableKey,
    merchantJwt: jwt,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RLS — customer_events
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — customer_events", () => {
  it("merchant A sees only their own event", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_events")
      .select("shopify_customer_gid");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.shopify_customer_gid === GID_A)).toBe(true);
  });

  it("merchant A cannot see merchant B's events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_events")
      .select("shopify_customer_gid")
      .eq("shopify_customer_gid", GID_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("customer_events")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Append-only — customer_events + order_events
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Append-only triggers — customer_events", () => {
  it("UPDATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `update public.customer_events set source = 'test'
           where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("DELETE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `delete from public.customer_events where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("TRUNCATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(`truncate public.customer_events`),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("Append-only triggers — order_events", () => {
  it("UPDATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `update public.order_events set source = 'test'
           where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("DELETE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `delete from public.order_events where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("TRUNCATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(`truncate public.order_events`),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — customers
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — customers", () => {
  it("merchant A sees only their own customer", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customers")
      .select("shopify_customer_gid");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.shopify_customer_gid === GID_A)).toBe(true);
  });

  it("merchant A cannot see merchant B's customer", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customers")
      .select("shopify_customer_gid")
      .eq("shopify_customer_gid", GID_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("customers")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — order_events
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — order_events", () => {
  it("merchant A sees only their own order event", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("order_events")
      .select("shopify_order_gid");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.shopify_order_gid === ORDER_GID_A)).toBe(true);
  });

  it("merchant A cannot see merchant B's order event", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("order_events")
      .select("shopify_order_gid")
      .eq("shopify_order_gid", ORDER_GID_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("order_events")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — orders
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — orders", () => {
  it("merchant A sees only their own order", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("orders")
      .select("shopify_order_gid");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.shopify_order_gid === ORDER_GID_A)).toBe(true);
  });

  it("merchant A cannot see merchant B's order", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("orders")
      .select("shopify_order_gid")
      .eq("shopify_order_gid", ORDER_GID_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("orders")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — products
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — products", () => {
  it("merchant A sees only their own product", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("products")
      .select("shopify_product_gid");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.shopify_product_gid === PRODUCT_GID_A)).toBe(true);
  });

  it("merchant A cannot see merchant B's product", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("products")
      .select("shopify_product_gid")
      .eq("shopify_product_gid", PRODUCT_GID_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("products")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — conversations
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — conversations (Sprint 07)", () => {
  it("merchant A sees only their own conversation", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("conversations")
      .select("customer_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.customer_id === GID_A)).toBe(true);
  });

  it("merchant A cannot see merchant B's conversation", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("conversations")
      .select("customer_id")
      .eq("customer_id", GID_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("conversations")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — messages (Sprint 07)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — messages (Sprint 07)", () => {
  it("merchant A sees only their own messages", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("messages")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's messages", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("messages")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("messages")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — message_events (Sprint 07)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — message_events (Sprint 07)", () => {
  it("merchant A sees only their own message events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("message_events")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's message events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("message_events")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("message_events")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — customer_opt_outs (Sprint 07, decision 18 — must not leak which
// customers of another merchant opted out)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — customer_opt_outs (Sprint 07)", () => {
  it("merchant A sees only their own opt-out rows", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_opt_outs")
      .select("merchant_id,customer_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
    expect(data?.every((r) => r.customer_id === GID_A)).toBe(true);
  });

  it("merchant A cannot see merchant B's opt-out rows", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_opt_outs")
      .select("customer_id")
      .eq("customer_id", GID_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("customer_opt_outs")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 07 append-only triggers — message_events + customer_opt_outs
// (decisions 12-mirror + 18 — events and opt-outs are immutable)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Append-only triggers — message_events (Sprint 07)", () => {
  it("UPDATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `update public.message_events set event_type = 'tampered'
           where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("DELETE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(`delete from public.message_events where merchant_id = $1`, [merchantIdA]),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("TRUNCATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(pg.query(`truncate public.message_events`)).rejects.toThrow(
        /append-only/i,
      );
    } finally {
      await pg.end();
    }
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("Append-only triggers — customer_opt_outs (Sprint 07)", () => {
  it("UPDATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `update public.customer_opt_outs set source = 'tampered'
           where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("DELETE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(`delete from public.customer_opt_outs where merchant_id = $1`, [merchantIdA]),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("TRUNCATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(pg.query(`truncate public.customer_opt_outs`)).rejects.toThrow(
        /append-only/i,
      );
    } finally {
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — webhook_deliveries (no merchant may read; explicit deny policy)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — webhook_deliveries (deny all authenticated)", () => {
  it("merchant A JWT cannot read webhook_deliveries", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("webhook_deliveries")
      .select("id");
    // Supabase returns an empty array (not an error) when RLS blocks all rows
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it("merchant B JWT cannot read webhook_deliveries", async () => {
    const { data, error } = await (await clientFor(SHOP_B))
      .from("webhook_deliveries")
      .select("id");
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 04 RLS — customer_rfm
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — customer_rfm (Sprint 04)", () => {
  it("merchant A sees only their own RFM row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_rfm")
      .select("merchant_id,shopify_customer_gid");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's RFM row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_rfm")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from customer_rfm", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("customer_rfm")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 04 RLS — scoring_runs
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — scoring_runs (Sprint 04)", () => {
  it("merchant A sees only their own scoring runs", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("scoring_runs")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's scoring runs", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("scoring_runs")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from scoring_runs", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("scoring_runs")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 04 RLS — merchant_scoring_caps
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — merchant_scoring_caps (Sprint 04)", () => {
  it("merchant A sees only their own cap row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("merchant_scoring_caps")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's cap row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("merchant_scoring_caps")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from merchant_scoring_caps", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("merchant_scoring_caps")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 04 RLS — customer_inferred_state
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — customer_inferred_state (Sprint 04)", () => {
  it("merchant A sees only their own inferred state", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_inferred_state")
      .select("merchant_id,shopify_customer_gid");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's inferred state", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_inferred_state")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("merchant A cannot see merchant B's inferred state filtered by GID", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("customer_inferred_state")
      .select("shopify_customer_gid")
      .eq("shopify_customer_gid", GID_B);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from customer_inferred_state", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("customer_inferred_state")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 05 RLS — storefront_snapshots (service-role only; deny authenticated)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — storefront_snapshots (Sprint 05, deny all authenticated)", () => {
  // Migration 0006 revokes ALL on storefront_snapshots from `authenticated`
  // (belt-and-braces defense in depth alongside the deny-all RLS policy). The
  // table-level REVOKE surfaces as a 42501 permission-denied error — not an
  // RLS-filtered empty result set.
  it("merchant A JWT cannot read storefront_snapshots", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("storefront_snapshots")
      .select("id");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("merchant B JWT cannot read storefront_snapshots", async () => {
    const { error } = await (await clientFor(SHOP_B))
      .from("storefront_snapshots")
      .select("id");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("merchant A JWT cannot insert into storefront_snapshots", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("storefront_snapshots")
      .insert({
        merchant_id: merchantIdA,
        raw_content: { about: "x" },
        redacted_content: { about: "x" },
        source_hash: "hash_attempted_insert",
      });
    expect(error).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 05 RLS — voice_events
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — voice_events (Sprint 05)", () => {
  it("merchant A sees only their own voice events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("voice_events")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's voice events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("voice_events")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from voice_events", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("voice_events")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 05 append-only triggers — voice_events
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Append-only triggers — voice_events (Sprint 05)", () => {
  it("UPDATE on voice_events raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `update public.voice_events set source = 'test'
           where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("DELETE on voice_events raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `delete from public.voice_events where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("TRUNCATE on voice_events raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(`truncate public.voice_events`),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 05 RLS — voice_versions
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — voice_versions (Sprint 05)", () => {
  it("merchant A sees only their own voice version", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("voice_versions")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's voice version", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("voice_versions")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from voice_versions", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("voice_versions")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 05 RLS — agent_profiles
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — agent_profiles (Sprint 05)", () => {
  it("merchant A sees only their own agent profile", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("agent_profiles")
      .select("merchant_id,role_descriptor");
    expect(error).toBeNull();
    expect(data?.length).toBe(1);
    expect(data?.[0]?.merchant_id).toBe(merchantIdA);
  });

  it("merchant A cannot see merchant B's agent profile", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("agent_profiles")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from agent_profiles", async () => {
    const wrongJwt = await mintMerchantJwt({
      shopDomain: SHOP_A,
      jwtSecret: "wrong-secret",
    });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("agent_profiles")
      .select("merchant_id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 05 — agent_profiles role_descriptor shape CHECK (decision 11)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("agent_profiles role_descriptor CHECK rejects freeform names", () => {
  it("a capitalized persona name like 'Sarah' is rejected by the CHECK", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `insert into public.agent_profiles (merchant_id, role_descriptor)
           values ($1, 'Sarah')
           on conflict (merchant_id) do update set role_descriptor = excluded.role_descriptor`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/role_descriptor_shape|check/i);
    } finally {
      await pg.end();
    }
  });

  it("a value with whitespace is rejected by the CHECK", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `insert into public.agent_profiles (merchant_id, role_descriptor)
           values ($1, 'sarah from lapsed')
           on conflict (merchant_id) do update set role_descriptor = excluded.role_descriptor`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/role_descriptor_shape|check/i);
    } finally {
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 05 — RLS write-rejection (decisions 7 + 12 — only service role may mutate)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS write-rejection — Sprint 05 tables", () => {
  it("merchant A JWT cannot insert into voice_events", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("voice_events")
      .insert({
        merchant_id: merchantIdA,
        event_type: "voice_extracted",
        source: "install_orchestrator",
        payload: { version_id: "00000000-0000-0000-0000-000000000099" },
        occurred_at: new Date().toISOString(),
      });
    expect(error).not.toBeNull();
  });

  it("merchant A JWT cannot insert into voice_versions", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("voice_versions")
      .insert({
        merchant_id: merchantIdA,
        version_number: 99,
        source_snapshot_id: "00000000-0000-0000-0000-000000000099",
        profile: { tone_descriptors: ["warm"] },
        model_version: "claude-sonnet-4-6-test",
        prompt_version: "v1",
      });
    expect(error).not.toBeNull();
  });

  it("merchant A JWT cannot upsert into agent_profiles", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("agent_profiles")
      .upsert(
        {
          merchant_id: merchantIdA,
          role_descriptor: "win_back_specialist",
        },
        { onConflict: "merchant_id" },
      );
    expect(error).not.toBeNull();
  });

  it("merchant A JWT cannot UPDATE an existing voice_versions row", async () => {
    const client = await clientFor(SHOP_A);
    // Capture the seeded profile via the merchant's read path BEFORE attempting the mutation.
    const before = await client
      .from("voice_versions")
      .select("id,profile")
      .eq("merchant_id", merchantIdA);
    expect(before.error).toBeNull();
    expect(before.data?.length ?? 0).toBeGreaterThan(0);
    const seededDescriptor = (before.data![0]!.profile as { tone_descriptors?: string[] })
      .tone_descriptors?.[0];
    expect(seededDescriptor).toBe("warm");

    // Attempt the update with `.select()` so Supabase returns the affected rows.
    // An RLS-blocked update either errors OR returns an empty `data` array.
    const update = await client
      .from("voice_versions")
      .update({ profile: { tone_descriptors: ["edgy"] } })
      .eq("merchant_id", merchantIdA)
      .select();
    expect(update.error !== null || (update.data ?? []).length === 0).toBe(true);

    // Re-read to confirm the seeded descriptor is unchanged.
    const after = await client
      .from("voice_versions")
      .select("profile")
      .eq("merchant_id", merchantIdA);
    expect(after.error).toBeNull();
    expect(after.data?.length ?? 0).toBeGreaterThan(0);
    expect(
      (after.data ?? []).every((row) => {
        const profile = row.profile as { tone_descriptors?: string[] };
        return profile.tone_descriptors?.[0] === "warm";
      }),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 05 — uniqueness / idempotency constraints
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Idempotency constraints — Sprint 05 tables", () => {
  it("voice_events_dedup_unique rejects duplicate (merchant_id, event_type, source, occurred_at)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    const occurredAt = new Date("2026-05-15T10:30:00.000Z").toISOString();
    try {
      // Insert the seed event
      await pg.query(
        `insert into public.voice_events
           (merchant_id, event_type, source, payload, occurred_at)
         values ($1, 'storefront_fetched', 'idempotency_test_source', '{}'::jsonb, $2)`,
        [merchantIdA, occurredAt],
      );
      // Inserting the identical tuple again must violate the unique constraint
      await expect(
        pg.query(
          `insert into public.voice_events
             (merchant_id, event_type, source, payload, occurred_at)
           values ($1, 'storefront_fetched', 'idempotency_test_source', '{}'::jsonb, $2)`,
          [merchantIdA, occurredAt],
        ),
      ).rejects.toThrow(/voice_events_dedup_unique|unique/i);
    } finally {
      // Cleanup via session_replication_role to bypass append-only triggers
      await pg.query(`set session_replication_role = 'replica'`);
      await pg.query(
        `delete from public.voice_events
         where merchant_id = $1 and source = 'idempotency_test_source'`,
        [merchantIdA],
      );
      await pg.query(`set session_replication_role = 'origin'`);
      await pg.end();
    }
  });

  it("voice_versions_merchant_version_unique rejects duplicate (merchant_id, version_number)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      const snap = await pg.query<{ id: string }>(
        `select id from public.storefront_snapshots where merchant_id = $1 limit 1`,
        [merchantIdA],
      );
      // version_number = 1 already exists in seed; inserting another version 1 must fail
      await expect(
        pg.query(
          `insert into public.voice_versions
             (merchant_id, version_number, source_snapshot_id, profile, model_version, prompt_version)
           values ($1, 1, $2, '{"tone_descriptors":["edgy"]}'::jsonb, 'claude-sonnet-4-6-test', 'v1')`,
          [merchantIdA, snap.rows[0]?.id],
        ),
      ).rejects.toThrow(/voice_versions_merchant_version_unique|unique/i);
    } finally {
      await pg.end();
    }
  });

  it("storefront_snapshots_merchant_hash_unique rejects duplicate (merchant_id, source_hash)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      // 'hash_A_rls' already exists in seed for merchantIdA
      await expect(
        pg.query(
          `insert into public.storefront_snapshots
             (merchant_id, raw_content, redacted_content, source_hash)
           values ($1, '{"about":"about-A-dup"}'::jsonb, '{"about":"about-A-dup"}'::jsonb, 'hash_A_rls')`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/storefront_snapshots_merchant_hash_unique|unique/i);
    } finally {
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sprint 07 — uniqueness / idempotency constraints
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Idempotency constraints — Sprint 07 tables", () => {
  it("conversations_pk rejects a second thread for the same (merchant_id, customer_id)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      // (merchantIdA, GID_A) already has a seeded conversation — decision 16
      // requires exactly one thread per customer per merchant.
      await expect(
        pg.query(
          `insert into public.conversations (merchant_id, customer_id)
           values ($1, $2)`,
          [merchantIdA, GID_A],
        ),
      ).rejects.toThrow(/conversations_pk|duplicate key|unique/i);
    } finally {
      await pg.end();
    }
  });

  it("message_events_dedup_unique rejects a duplicate (merchant_id, conversation_id, message_id, event_type, occurred_at)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    const occurredAt = new Date("2026-05-16T09:15:00.000Z").toISOString();
    try {
      const conv = await pg.query<{ id: string }>(
        `select id from public.conversations where merchant_id = $1 limit 1`,
        [merchantIdA],
      );
      const msg = await pg.query<{ id: string }>(
        `select id from public.messages where merchant_id = $1 limit 1`,
        [merchantIdA],
      );
      const convId = conv.rows[0]!.id;
      const msgId = msg.rows[0]!.id;
      await pg.query(
        `insert into public.message_events
           (merchant_id, conversation_id, message_id, event_type, payload, occurred_at)
         values ($1, $2, $3, 'reply_sent', '{}'::jsonb, $4)`,
        [merchantIdA, convId, msgId, occurredAt],
      );
      // The identical tuple again must violate the dedup unique constraint —
      // this is what makes appendMessageEvent idempotent (decision 12 mirror).
      await expect(
        pg.query(
          `insert into public.message_events
             (merchant_id, conversation_id, message_id, event_type, payload, occurred_at)
           values ($1, $2, $3, 'reply_sent', '{}'::jsonb, $4)`,
          [merchantIdA, convId, msgId, occurredAt],
        ),
      ).rejects.toThrow(/message_events_dedup_unique|unique/i);
    } finally {
      // Cleanup via session_replication_role to bypass the append-only trigger.
      await pg.query(`set session_replication_role = 'replica'`);
      await pg.query(
        `delete from public.message_events
         where merchant_id = $1 and event_type = 'reply_sent'`,
        [merchantIdA],
      );
      await pg.query(`set session_replication_role = 'origin'`);
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — merchant_attribution_config (Sprint 08)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — merchant_attribution_config", () => {
  it("merchant A sees only their own config row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("merchant_attribution_config")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBe(1);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's config", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("merchant_attribution_config")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — attribution_results (Sprint 08)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — attribution_results", () => {
  it("merchant A sees only their own attribution results", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("attribution_results")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's attribution results", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("attribution_results")
      .select("id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — attribution_decisions (Sprint 08)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — attribution_decisions", () => {
  it("merchant A sees only their own attribution decisions", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("attribution_decisions")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's attribution decisions", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("attribution_decisions")
      .select("id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — ltv_snapshots (Sprint 08)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — ltv_snapshots", () => {
  it("merchant A sees only their own ltv snapshots", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("ltv_snapshots")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's ltv snapshots", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("ltv_snapshots")
      .select("id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Append-only triggers — attribution_decisions (Sprint 08, decision 21)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Append-only triggers — attribution_decisions", () => {
  it("UPDATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `update public.attribution_decisions set attribution_window_days = 21
           where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("DELETE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `delete from public.attribution_decisions where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("TRUNCATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(pg.query(`truncate public.attribution_decisions`)).rejects.toThrow(
        /append-only/i,
      );
    } finally {
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-attribution invariant — attribution_decisions(order_id) partial UNIQUE
// (Sprint 08, decision 21)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Single-attribution — attribution_decisions(order_id)", () => {
  it("rejects a second 'attributed' decision for the same order_id", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      const { rows } = await pg.query<{ id: string }>(
        `select id from public.orders where merchant_id = $1 limit 1`,
        [merchantIdA],
      );
      const orderId = rows[0]!.id;
      // First attribution for the order — accepted.
      await pg.query(
        `insert into public.attribution_decisions
           (merchant_id, order_id, decision_type, attribution_window_days)
         values ($1, $2, 'attributed', 14)`,
        [merchantIdA, orderId],
      );
      // A second decision for the SAME order must be rejected by the partial
      // unique index — single-attribution per order (decision 21).
      await expect(
        pg.query(
          `insert into public.attribution_decisions
             (merchant_id, order_id, decision_type, attribution_window_days)
           values ($1, $2, 'attributed', 14)`,
          [merchantIdA, orderId],
        ),
      ).rejects.toThrow(/attribution_decisions_order_unique|unique/i);
    } finally {
      // Cleanup via session_replication_role to bypass the append-only trigger.
      await pg.query(`set session_replication_role = 'replica'`);
      await pg.query(
        `delete from public.attribution_decisions
         where merchant_id = $1 and decision_type = 'attributed'`,
        [merchantIdA],
      );
      await pg.query(`set session_replication_role = 'origin'`);
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — merchant_subscriptions (Sprint 09)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — merchant_subscriptions", () => {
  it("merchant A sees only their own subscription row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("merchant_subscriptions")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBe(1);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's subscription", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("merchant_subscriptions")
      .select("id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — subscription_events (Sprint 09)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — subscription_events", () => {
  it("merchant A sees only their own subscription events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("subscription_events")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's subscription events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("subscription_events")
      .select("id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Append-only triggers — subscription_events (Sprint 09, decision 32)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Append-only triggers — subscription_events", () => {
  it("UPDATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `update public.subscription_events set event_type = 'tampered'
           where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("DELETE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `delete from public.subscription_events where merchant_id = $1`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("TRUNCATE raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(`truncate public.subscription_events`),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — subscription_events.stripe_event_id partial UNIQUE (decision 32)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Idempotency — subscription_events.stripe_event_id", () => {
  it("rejects a duplicate non-null stripe_event_id (Stripe re-delivery is a no-op)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    const eventId = `evt_dup_${Date.now()}`;
    try {
      await pg.query(
        `insert into public.subscription_events
           (merchant_id, stripe_event_id, event_type)
         values ($1, $2, 'customer.subscription.updated')`,
        [merchantIdA, eventId],
      );
      // A second row with the SAME stripe_event_id must be rejected by the
      // partial unique index — this is the webhook idempotency backstop.
      await expect(
        pg.query(
          `insert into public.subscription_events
             (merchant_id, stripe_event_id, event_type)
           values ($1, $2, 'customer.subscription.updated')`,
          [merchantIdA, eventId],
        ),
      ).rejects.toThrow(/subscription_events_stripe_event_id_unique|unique/i);
    } finally {
      await pg.query(`set session_replication_role = 'replica'`);
      await pg.query(
        `delete from public.subscription_events
         where merchant_id = $1 and stripe_event_id = $2`,
        [merchantIdA, eventId],
      );
      await pg.query(`set session_replication_role = 'origin'`);
      await pg.end();
    }
  });

  it("permits multiple rows with a null stripe_event_id (internal audit events)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      // Two NULL-keyed internal audit events must both insert — the partial
      // index (WHERE stripe_event_id IS NOT NULL) does not constrain NULLs.
      await pg.query(
        `insert into public.subscription_events (merchant_id, event_type, data)
         values ($1, 'attribution_methodology_migration', '{"k":1}'::jsonb),
                ($1, 'attribution_methodology_migration', '{"k":2}'::jsonb)`,
        [merchantIdA],
      );
      const { rows } = await pg.query<{ count: number }>(
        `select count(*)::int as count from public.subscription_events
         where merchant_id = $1 and stripe_event_id is null
           and event_type = 'attribution_methodology_migration'`,
        [merchantIdA],
      );
      expect(rows[0]!.count).toBe(2);
    } finally {
      await pg.query(`set session_replication_role = 'replica'`);
      await pg.query(
        `delete from public.subscription_events
         where merchant_id = $1 and stripe_event_id is null
           and event_type = 'attribution_methodology_migration'`,
        [merchantIdA],
      );
      await pg.query(`set session_replication_role = 'origin'`);
      await pg.end();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Write-lock — no INSERT/UPDATE/DELETE policy for the authenticated role
// (Sprint 09, decision 29 — "absence of a write policy is the enforcement")
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("Write-lock — merchant_subscriptions", () => {
  it("authenticated merchant client cannot INSERT a subscription row", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("merchant_subscriptions")
      .insert({
        merchant_id: merchantIdA,
        stripe_subscription_id: `sub_block_${Date.now()}`,
        tier: "starter",
        status: "active",
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
      });
    // RLS with no INSERT policy rejects the write.
    expect(error).not.toBeNull();
  });

  it("authenticated merchant client cannot UPDATE a subscription row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("merchant_subscriptions")
      .update({ tier: "scale" })
      .eq("merchant_id", merchantIdA)
      .select();
    // No UPDATE policy — the write touches zero rows (or errors).
    expect(error === null ? data ?? [] : []).toEqual([]);
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("Write-lock — subscription_events", () => {
  it("authenticated merchant client cannot INSERT an event row", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("subscription_events")
      .insert({
        merchant_id: merchantIdA,
        event_type: "customer.subscription.created",
        data: {},
      });
    expect(error).not.toBeNull();
  });
});
