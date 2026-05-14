import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import type { Database } from "./types";

export type { Database, Json } from "./types";
export type LapsedSupabaseClient = SupabaseClient<Database>;

export { encryptToken, decryptToken, decodeEncryptionKey } from "./encryption";

export {
  getLapsedCustomers,
  getCustomer,
  getCustomerOrders,
  getMerchantSummary,
  type LapsedCustomersPage,
  type MerchantSummaryRow,
} from "./queries";

const ROLE = "authenticated";
const SESSION_TTL_SECONDS = 3600; // align with Supabase auth.jwt_exp

interface MintMerchantJwtOptions {
  shopDomain: string;
  jwtSecret: string;
  ttlSeconds?: number;
}

/**
 * Mint a Supabase-compatible HS256 JWT that authenticates a server-side
 * request as a particular merchant. The JWT carries a `shop_domain`
 * custom claim which the merchants_self_read RLS policy compares
 * against the row's `shopify_shop_domain`.
 *
 * Caller is responsible for passing the Supabase project's JWT secret;
 * do not read process.env inside this function.
 */
export async function mintMerchantJwt(opts: MintMerchantJwtOptions): Promise<string> {
  const { shopDomain, jwtSecret, ttlSeconds = SESSION_TTL_SECONDS } = opts;
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    role: ROLE,
    shop_domain: shopDomain,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("supabase")
    .setSubject(`shop:${shopDomain}`)
    .setAudience(ROLE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(new TextEncoder().encode(jwtSecret));
}

interface ServiceClientOptions {
  url: string;
  serviceKey: string;
}

/**
 * Create a Supabase client with the secret/service role key. Bypasses
 * RLS — use for OAuth callback writes, webhook handlers, and other
 * server-side mutations that have already verified caller authority by
 * other means (e.g. Shopify HMAC).
 */
export function createServiceClient(opts: ServiceClientOptions): LapsedSupabaseClient {
  return createClient<Database>(opts.url, opts.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface MerchantClientOptions {
  url: string;
  publishableKey: string;
  merchantJwt: string;
}

/**
 * Create a Supabase client scoped to a particular merchant by passing a
 * minted merchant JWT in the Authorization header. PostgREST decodes
 * the JWT and exposes the claims to RLS policies via auth.jwt().
 *
 * Use for any read path that should be scoped to the calling merchant.
 */
export function createMerchantClient(opts: MerchantClientOptions): LapsedSupabaseClient {
  return createClient<Database>(opts.url, opts.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: `Bearer ${opts.merchantJwt}`,
      },
    },
  });
}
