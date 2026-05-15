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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

    // conversations (and conversation_messages seeded after)
    const convRes = await pg.query<{ id: string; merchant_id: string }>(
      `insert into public.conversations
         (merchant_id, shopify_customer_gid)
       values ($1, $2), ($3, $4)
       returning id, merchant_id`,
      [merchantIdA, GID_A, merchantIdB, GID_B],
    );
    for (const conv of convRes.rows) {
      await pg.query(
        `insert into public.conversation_messages
           (conversation_id, merchant_id, role, body)
         values ($1, $2, 'assistant', 'hello')`,
        [conv.id, conv.merchant_id],
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
  } finally {
    await pg.end();
  }
});

afterAll(async () => {
  if (!SUPABASE_AVAILABLE) return;
  const pg = new PgClient({ connectionString: env.dbUrl });
  await pg.connect();
  try {
    // session_replication_role = 'replica' disables non-replica triggers for this
    // session so that the append-only BEFORE DELETE triggers on customer_events and
    // order_events don't block cleanup. Revert immediately after event-table deletes.
    await pg.query(`set session_replication_role = 'replica'`);

    // Delete in FK dependency order (leaf tables before parent tables).
    // conversation_messages cascades from conversations, but explicit delete is safe.
    await pg.query(
      `delete from public.conversation_messages
       where merchant_id = any($1::uuid[])`,
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

    await pg.query(`set session_replication_role = 'origin'`);

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
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — conversations", () => {
  it("merchant A sees only their own conversation", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("conversations")
      .select("shopify_customer_gid");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.shopify_customer_gid === GID_A)).toBe(true);
  });

  it("merchant A cannot see merchant B's conversation", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("conversations")
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
      .from("conversations")
      .select("id");
    expect(data ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RLS — conversation_messages
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!SUPABASE_AVAILABLE)("RLS — conversation_messages", () => {
  it("merchant A sees only their own messages", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("conversation_messages")
      .select("merchant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
    expect(data?.every((r) => r.merchant_id === merchantIdA)).toBe(true);
  });

  it("merchant A cannot see merchant B's messages", async () => {
    const { data, error } = await (await clientFor(SHOP_A))
      .from("conversation_messages")
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
      .from("conversation_messages")
      .select("id");
    expect(data ?? []).toEqual([]);
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
