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

import { readFileSync } from "node:fs";
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

function loadEnv(): Env {
  const envPath = join(__dirname, "..", "..", "..", ".env.local");
  const txt = readFileSync(envPath, "utf8");
  function pick(k: string): string {
    const m = txt.match(new RegExp(`^${k}=(.+)$`, "m"));
    if (!m) throw new Error(`${k} missing from .env.local`);
    return m[1]!.trim();
  }
  return {
    url: pick("NEXT_PUBLIC_SUPABASE_URL"),
    publishableKey: pick("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    jwtSecret: pick("SUPABASE_JWT_SECRET"),
    dbUrl: pick("SUPABASE_DB_URL"),
  };
}

const SHOP_A = `rls-test-a-${Date.now()}.myshopify.com`;
const SHOP_B = `rls-test-b-${Date.now()}.myshopify.com`;
const ENCRYPTION_KEY = randomBytes(32);

let env: Env;

beforeAll(async () => {
  env = loadEnv();
  const pg = new PgClient({ connectionString: env.dbUrl });
  await pg.connect();
  try {
    const tokenA = encryptToken("shpat_token_A", ENCRYPTION_KEY);
    const tokenB = encryptToken("shpat_token_B", ENCRYPTION_KEY);
    await pg.query(
      `insert into public.merchants
         (shopify_shop_domain, shopify_access_token, shopify_scope)
       values ($1, $2, 'read_orders'), ($3, $4, 'read_orders')`,
      [SHOP_A, tokenA, SHOP_B, tokenB],
    );
  } finally {
    await pg.end();
  }
});

afterAll(async () => {
  const pg = new PgClient({ connectionString: env.dbUrl });
  await pg.connect();
  try {
    await pg.query(
      `delete from public.merchants where shopify_shop_domain = any($1)`,
      [[SHOP_A, SHOP_B]],
    );
  } finally {
    await pg.end();
  }
});

describe("RLS — merchants_self_read", () => {
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
