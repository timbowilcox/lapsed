import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, type Page } from "@playwright/test";
import { Client as PgClient } from "pg";
import { mintSessionCookie, SESSION_COOKIE } from "@lapsed/shopify";
import { encryptToken, decodeEncryptionKey } from "@lapsed/db";
import { randomBytes } from "node:crypto";

interface TestEnv {
  shopifyApiKey: string;
  shopifyApiSecret: string;
  supabaseDbUrl: string;
  tokenEncryptionKey: string;
}

let cached: TestEnv | null = null;
function loadEnv(): TestEnv {
  if (cached) return cached;
  const path = join(process.cwd(), "..", "..", ".env.local");
  const txt = readFileSync(path, "utf8");
  function pick(name: string): string {
    const m = txt.match(new RegExp(`^${name}=(.+)$`, "m"));
    if (!m) throw new Error(`${name} missing in .env.local`);
    return m[1]!.trim();
  }
  cached = {
    shopifyApiKey: pick("SHOPIFY_API_KEY"),
    shopifyApiSecret: pick("SHOPIFY_API_SECRET"),
    supabaseDbUrl: pick("SUPABASE_DB_URL"),
    tokenEncryptionKey: pick("TOKEN_ENCRYPTION_KEY"),
  };
  return cached;
}

export const TEST_MERCHANT_SHOP = "lapsed-test.myshopify.com";

export async function seedTestMerchant(): Promise<void> {
  const env = loadEnv();
  const pg = new PgClient({ connectionString: env.supabaseDbUrl });
  await pg.connect();
  try {
    const key = decodeEncryptionKey(env.tokenEncryptionKey);
    const ciphertext = encryptToken("shpat_seed_token", key);
    await pg.query(
      `insert into public.merchants
         (shopify_shop_domain, shopify_access_token, shopify_scope, plan)
       values ($1, $2, 'read_orders', 'growth')
       on conflict (shopify_shop_domain) do update
         set shopify_access_token = excluded.shopify_access_token,
             shopify_scope = excluded.shopify_scope,
             plan = excluded.plan,
             uninstalled_at = null`,
      [TEST_MERCHANT_SHOP, ciphertext],
    );
  } finally {
    await pg.end();
  }
}

export async function removeTestMerchant(): Promise<void> {
  const env = loadEnv();
  const pg = new PgClient({ connectionString: env.supabaseDbUrl });
  await pg.connect();
  try {
    await pg.query(
      `delete from public.merchants where shopify_shop_domain = $1`,
      [TEST_MERCHANT_SHOP],
    );
  } finally {
    await pg.end();
  }
}

export async function attachMerchantSession(page: Page): Promise<void> {
  const env = loadEnv();
  const token = await mintSessionCookie({
    shopDomain: TEST_MERCHANT_SHOP,
    apiKey: env.shopifyApiKey,
    apiSecret: env.shopifyApiSecret,
  });
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      value: token,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
}

// Wrapped test that pre-seeds the merchant and attaches a session
// cookie. Use this in any test that needs to land inside the merchant
// shell without going through the real OAuth flow.
export const test = base.extend<{ merchantPage: Page }>({
  merchantPage: async ({ page }, use) => {
    await attachMerchantSession(page);
    await use(page);
  },
});

export { expect } from "@playwright/test";
export { randomBytes };
