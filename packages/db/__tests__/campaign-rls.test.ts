/**
 * Sprint 06 cross-tenant RLS isolation test for the campaign tables.
 *
 * Standalone from rls.test.ts: seeds its own pair of merchants and a
 * campaign proposal per merchant, then asserts merchant-scoped isolation
 * for campaign_proposals, campaign_arms, bandit_state,
 * campaign_group_snapshots, the campaign_holdouts view, and campaign_events
 * (including append-only enforcement).
 *
 * Skips cleanly when Supabase credentials are absent or migration 0007 has
 * not been applied to the dev database.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client as PgClient } from "pg";
import { createMerchantClient, mintMerchantJwt, encryptToken } from "../src";

interface Env {
  url: string;
  publishableKey: string;
  jwtSecret: string;
  dbUrl: string;
}

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

let schemaReady = true;
beforeEach((ctx) => {
  if (!schemaReady) ctx.skip();
});

const SHOP_A = `camp-rls-a-${Date.now()}.myshopify.com`;
const SHOP_B = `camp-rls-b-${Date.now()}.myshopify.com`;
const ENCRYPTION_KEY = randomBytes(32);

let env!: Env;
let merchantIdA: string;
let merchantIdB: string;
let proposalIdA: string;
let proposalIdB: string;
let banditArmIdA: string;
let banditArmIdB: string;

const CUSTOMER_A = "gid://shopify/Customer/9001";
const CUSTOMER_B = "gid://shopify/Customer/9002";

async function clientFor(shop: string) {
  const jwt = await mintMerchantJwt({ shopDomain: shop, jwtSecret: env.jwtSecret });
  return createMerchantClient({
    url: env.url,
    publishableKey: env.publishableKey,
    merchantJwt: jwt,
  });
}

beforeAll(async () => {
  if (!SUPABASE_AVAILABLE) return;
  env = loadEnv()!;
  const pg = new PgClient({ connectionString: env.dbUrl });
  await pg.connect();
  try {
    const { rows } = await pg.query<{ count: number }>(
      `select count(*)::int as count from information_schema.tables
       where table_schema = 'public'
         and table_name in (
           'campaign_proposals','campaign_arms','bandit_state',
           'campaign_group_snapshots','campaign_events'
         )`,
    );
    const { rows: viewRows } = await pg.query<{ count: number }>(
      `select count(*)::int as count from information_schema.views
       where table_schema = 'public' and table_name = 'campaign_holdouts'`,
    );
    if ((rows[0]?.count ?? 0) < 5 || (viewRows[0]?.count ?? 0) < 1) {
      schemaReady = false;
      console.warn("[campaign-rls.test] Sprint 06 schema missing — skipping all tests");
      return;
    }

    const tokenA = encryptToken("shpat_token_A", ENCRYPTION_KEY);
    const tokenB = encryptToken("shpat_token_B", ENCRYPTION_KEY);
    const merchantRes = await pg.query<{ id: string; shopify_shop_domain: string }>(
      `insert into public.merchants
         (shopify_shop_domain, shopify_access_token, shopify_scope)
       values ($1, $2, 'read_orders'), ($3, $4, 'read_orders')
       returning id, shopify_shop_domain`,
      [SHOP_A, tokenA, SHOP_B, tokenB],
    );
    for (const row of merchantRes.rows) {
      if (row.shopify_shop_domain === SHOP_A) merchantIdA = row.id;
      else merchantIdB = row.id;
    }

    const proposalRes = await pg.query<{ id: string; merchant_id: string }>(
      `insert into public.campaign_proposals
         (merchant_id, group_slug, model_version)
       values ($1, 'lapsed_vips', 'claude-sonnet-4-6-test'),
              ($2, 'at_risk_regulars', 'claude-sonnet-4-6-test')
       returning id, merchant_id`,
      [merchantIdA, merchantIdB],
    );
    for (const row of proposalRes.rows) {
      if (row.merchant_id === merchantIdA) proposalIdA = row.id;
      else proposalIdB = row.id;
    }

    const armRes = await pg.query<{ bandit_arm_id: string; merchant_id: string }>(
      `insert into public.campaign_arms
         (proposal_id, merchant_id, variant_index, offer_type, offer_value,
          message_draft, send_time_window, tone)
       values ($1, $2, 0, 'percent_discount', '10%', 'We saved your spot.', 'evening', 'warm'),
              ($3, $4, 0, 'free_shipping', 'Free over $50', 'Come back soon.', 'morning', 'direct')
       returning bandit_arm_id, merchant_id`,
      [proposalIdA, merchantIdA, proposalIdB, merchantIdB],
    );
    for (const row of armRes.rows) {
      if (row.merchant_id === merchantIdA) banditArmIdA = row.bandit_arm_id;
      else banditArmIdB = row.bandit_arm_id;
    }

    await pg.query(
      `insert into public.bandit_state (arm_id, merchant_id, proposal_id)
       values ($1, $2, $3), ($4, $5, $6)`,
      [banditArmIdA, merchantIdA, proposalIdA, banditArmIdB, merchantIdB, proposalIdB],
    );

    await pg.query(
      `insert into public.campaign_group_snapshots
         (proposal_id, merchant_id, customer_id, included_in_holdout)
       values ($1, $2, $3, true), ($4, $5, $6, true)`,
      [proposalIdA, merchantIdA, CUSTOMER_A, proposalIdB, merchantIdB, CUSTOMER_B],
    );

    await pg.query(
      `insert into public.campaign_events
         (merchant_id, proposal_id, event_type, payload, occurred_at)
       values ($1, $2, 'campaign_proposed', '{}'::jsonb, now()),
              ($3, $4, 'campaign_proposed', '{}'::jsonb, now())`,
      [merchantIdA, proposalIdA, merchantIdB, proposalIdB],
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
    // replica role disables the append-only trigger on campaign_events for cleanup.
    await pg.query(`set session_replication_role = 'replica'`);
    const ids = [merchantIdA, merchantIdB];
    await pg.query(`delete from public.bandit_state where merchant_id = any($1::uuid[])`, [ids]);
    await pg.query(`delete from public.campaign_arms where merchant_id = any($1::uuid[])`, [ids]);
    await pg.query(
      `delete from public.campaign_group_snapshots where merchant_id = any($1::uuid[])`,
      [ids],
    );
    await pg.query(`delete from public.campaign_events where merchant_id = any($1::uuid[])`, [ids]);
    // Delete superseding proposal versions before their roots — the
    // supersedes_proposal_id self-FK is ON DELETE RESTRICT.
    await pg.query(
      `delete from public.campaign_proposals
       where merchant_id = any($1::uuid[]) and supersedes_proposal_id is not null`,
      [ids],
    );
    await pg.query(`delete from public.campaign_proposals where merchant_id = any($1::uuid[])`, [
      ids,
    ]);
    await pg.query(`set session_replication_role = 'origin'`);
    await pg.query(`delete from public.merchants where shopify_shop_domain = any($1)`, [
      [SHOP_A, SHOP_B],
    ]);
  } finally {
    await pg.end();
  }
});

describe.skipIf(!SUPABASE_AVAILABLE)("RLS — campaign_proposals (Sprint 06)", () => {
  it("merchant A sees only their own proposal", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_proposals")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's proposal", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_proposals")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from campaign_proposals", async () => {
    const wrongJwt = await mintMerchantJwt({ shopDomain: SHOP_A, jwtSecret: "wrong-secret" });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("campaign_proposals")
      .select("id");
    expect(data ?? []).toEqual([]);
  });

  it("merchant A JWT cannot insert into campaign_proposals", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("campaign_proposals")
      .insert({ merchant_id: merchantIdA, group_slug: "lapsed_vips", model_version: "x" });
    expect(error).not.toBeNull();
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("RLS — campaign_arms (Sprint 06)", () => {
  it("merchant A sees only their own arm", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_arms")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's arm", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_arms")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from campaign_arms", async () => {
    const wrongJwt = await mintMerchantJwt({ shopDomain: SHOP_A, jwtSecret: "wrong-secret" });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("campaign_arms")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("RLS — bandit_state (Sprint 06)", () => {
  it("merchant A sees only their own bandit row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("bandit_state")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's bandit row", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("bandit_state")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("wrong JWT secret returns zero rows from bandit_state", async () => {
    const wrongJwt = await mintMerchantJwt({ shopDomain: SHOP_A, jwtSecret: "wrong-secret" });
    const { data } = await createMerchantClient({
      url: env.url,
      publishableKey: env.publishableKey,
      merchantJwt: wrongJwt,
    })
      .from("bandit_state")
      .select("arm_id");
    expect(data ?? []).toEqual([]);
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("RLS — campaign_group_snapshots + campaign_holdouts (Sprint 06)", () => {
  it("merchant A sees only their own snapshot rows", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_group_snapshots")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's snapshot rows", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_group_snapshots")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("campaign_holdouts view is merchant-scoped (security_invoker)", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_holdouts")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("campaign_holdouts view hides merchant B from merchant A", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_holdouts")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("RLS + append-only — campaign_events (Sprint 06)", () => {
  it("merchant A sees only their own campaign events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_events")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's campaign events", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("campaign_events")
      .select("merchant_id")
      .eq("merchant_id", merchantIdB);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("merchant A JWT cannot insert into campaign_events", async () => {
    const { error } = await (await clientFor(SHOP_A)).from("campaign_events").insert({
      merchant_id: merchantIdA,
      proposal_id: proposalIdA,
      event_type: "campaign_approved",
      occurred_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });

  it("UPDATE on campaign_events raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(`update public.campaign_events set event_type = 'x' where merchant_id = $1`, [
          merchantIdA,
        ]),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("DELETE on campaign_events raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(`delete from public.campaign_events where merchant_id = $1`, [merchantIdA]),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });

  it("TRUNCATE on campaign_events raises append-only exception", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(pg.query(`truncate public.campaign_events`)).rejects.toThrow(/append-only/i);
    } finally {
      await pg.end();
    }
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("RLS write-rejection — Sprint 06 tables", () => {
  it("merchant A JWT cannot insert into campaign_arms", async () => {
    const { error } = await (await clientFor(SHOP_A)).from("campaign_arms").insert({
      proposal_id: proposalIdA,
      merchant_id: merchantIdA,
      variant_index: 1,
      offer_type: "percent_discount",
      offer_value: "5%",
      message_draft: "x",
      send_time_window: "morning",
      tone: "warm",
    });
    expect(error).not.toBeNull();
  });

  it("merchant A JWT cannot insert into bandit_state", async () => {
    const { error } = await (await clientFor(SHOP_A)).from("bandit_state").insert({
      arm_id: banditArmIdA,
      merchant_id: merchantIdA,
      proposal_id: proposalIdA,
    });
    expect(error).not.toBeNull();
  });

  it("merchant A JWT cannot insert into campaign_group_snapshots", async () => {
    const { error } = await (await clientFor(SHOP_A))
      .from("campaign_group_snapshots")
      .insert({ proposal_id: proposalIdA, merchant_id: merchantIdA, customer_id: "gid://x" });
    expect(error).not.toBeNull();
  });

  it("merchant A JWT cannot UPDATE an existing campaign_arms row (decision 14)", async () => {
    const client = await clientFor(SHOP_A);
    const update = await client
      .from("campaign_arms")
      .update({ message_draft: "tampered" })
      .eq("merchant_id", merchantIdA)
      .select();
    expect(update.error !== null || (update.data ?? []).length === 0).toBe(true);
    const after = await client.from("campaign_arms").select("message_draft").eq("merchant_id", merchantIdA);
    expect(after.data?.every((r) => r.message_draft !== "tampered")).toBe(true);
  });
});

describe.skipIf(!SUPABASE_AVAILABLE)("CHECK constraints — Sprint 06 tables", () => {
  it("campaign_arms rejects a message_draft longer than 160 chars", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `insert into public.campaign_arms
             (proposal_id, merchant_id, variant_index, offer_type, offer_value,
              message_draft, send_time_window, tone)
           values ($1, $2, 1, 'percent_discount', '5%', $3, 'morning', 'warm')`,
          [proposalIdA, merchantIdA, "x".repeat(161)],
        ),
      ).rejects.toThrow(/campaign_arms_message_sms_length|check/i);
    } finally {
      await pg.end();
    }
  });

  it("campaign_arms rejects a variant_index outside 0..2", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `insert into public.campaign_arms
             (proposal_id, merchant_id, variant_index, offer_type, offer_value,
              message_draft, send_time_window, tone)
           values ($1, $2, 3, 'percent_discount', '5%', 'ok', 'morning', 'warm')`,
          [proposalIdA, merchantIdA],
        ),
      ).rejects.toThrow(/campaign_arms_variant_range|check/i);
    } finally {
      await pg.end();
    }
  });

  it("bandit_state rejects a non-positive alpha", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      // A fresh arm so the PK is free; the CHECK should fire before any PK concern.
      const arm = await pg.query<{ bandit_arm_id: string }>(
        `insert into public.campaign_arms
           (proposal_id, merchant_id, variant_index, offer_type, offer_value,
            message_draft, send_time_window, tone)
         values ($1, $2, 2, 'bundle', 'x', 'ok', 'evening', 'warm')
         returning bandit_arm_id`,
        [proposalIdA, merchantIdA],
      );
      await expect(
        pg.query(
          `insert into public.bandit_state (arm_id, merchant_id, proposal_id, alpha)
           values ($1, $2, $3, 0)`,
          [arm.rows[0]!.bandit_arm_id, merchantIdA, proposalIdA],
        ),
      ).rejects.toThrow(/bandit_state_alpha_positive|check/i);
    } finally {
      await pg.end();
    }
  });

  it("bandit_state rejects a negative observation_count", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `insert into public.bandit_state (arm_id, merchant_id, proposal_id, observation_count)
           values ($1, $2, $3, -1)`,
          [banditArmIdA, merchantIdA, proposalIdA],
        ),
      ).rejects.toThrow(/bandit_state_observations_nonneg|check/i);
    } finally {
      await pg.end();
    }
  });

  it("campaign_proposals rejects version_number below 1", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      await expect(
        pg.query(
          `insert into public.campaign_proposals
             (merchant_id, group_slug, model_version, version_number)
           values ($1, 'lapsed_vips', 'm', 0)`,
          [merchantIdA],
        ),
      ).rejects.toThrow(/campaign_proposals_version_positive|check/i);
    } finally {
      await pg.end();
    }
  });

  it("campaign_group_snapshots composite PK rejects a duplicate (proposal_id, customer_id)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      // (proposalIdA, CUSTOMER_A) was seeded in beforeAll; re-inserting must fail.
      await expect(
        pg.query(
          `insert into public.campaign_group_snapshots
             (proposal_id, merchant_id, customer_id, included_in_holdout)
           values ($1, $2, $3, false)`,
          [proposalIdA, merchantIdA, CUSTOMER_A],
        ),
      ).rejects.toThrow(/campaign_group_snapshots_pk|duplicate|unique/i);
    } finally {
      await pg.end();
    }
  });

  it("campaign_proposals rejects a row that supersedes itself", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      const id = "00000000-0000-0000-0000-0000000007ce";
      await expect(
        pg.query(
          `insert into public.campaign_proposals
             (id, merchant_id, group_slug, model_version, supersedes_proposal_id)
           values ($1, $2, 'lapsed_vips', 'm', $1)`,
          [id, merchantIdA],
        ),
      ).rejects.toThrow(/campaign_proposals_no_self_supersede|check/i);
    } finally {
      await pg.end();
    }
  });

  it("campaign_events rejects a duplicate (merchant_id, proposal_id, event_type, occurred_at)", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    const occurredAt = new Date("2026-05-16T00:00:00.000Z").toISOString();
    try {
      await pg.query(
        `insert into public.campaign_events
           (merchant_id, proposal_id, event_type, occurred_at)
         values ($1, $2, 'proposal_started', $3)`,
        [merchantIdA, proposalIdA, occurredAt],
      );
      await expect(
        pg.query(
          `insert into public.campaign_events
             (merchant_id, proposal_id, event_type, occurred_at)
           values ($1, $2, 'proposal_started', $3)`,
          [merchantIdA, proposalIdA, occurredAt],
        ),
      ).rejects.toThrow(/campaign_events_dedup_unique|unique/i);
    } finally {
      await pg.query(`set session_replication_role = 'replica'`);
      await pg.query(
        `delete from public.campaign_events
         where merchant_id = $1 and event_type = 'proposal_started'`,
        [merchantIdA],
      );
      await pg.query(`set session_replication_role = 'origin'`);
      await pg.end();
    }
  });

  it("campaign_proposals supersedes index keeps the version lineage linear", async () => {
    const pg = new PgClient({ connectionString: env.dbUrl });
    await pg.connect();
    try {
      // Two new proposals both claiming to supersede proposalIdA must collide.
      await pg.query(
        `insert into public.campaign_proposals
           (merchant_id, group_slug, model_version, version_number, supersedes_proposal_id)
         values ($1, 'lapsed_vips', 'm', 2, $2)`,
        [merchantIdA, proposalIdA],
      );
      await expect(
        pg.query(
          `insert into public.campaign_proposals
             (merchant_id, group_slug, model_version, version_number, supersedes_proposal_id)
           values ($1, 'lapsed_vips', 'm', 2, $2)`,
          [merchantIdA, proposalIdA],
        ),
      ).rejects.toThrow(/campaign_proposals_supersedes_unique_idx|unique|duplicate/i);
    } finally {
      await pg.end();
    }
  });
});
