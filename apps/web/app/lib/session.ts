import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  verifyShopifySessionToken,
} from "@lapsed/shopify";
import { createServiceClient } from "@lapsed/db";
import type { Database } from "@lapsed/db";
import { serverEnv } from "./env";

type MerchantRow = Database["public"]["Tables"]["merchants"]["Row"];

export interface SessionMerchant {
  id: string;
  shopDomain: string;
  shopName: string;
  shopInitials: string;
  plan: string;
  planLabel: string;
  installedAt: string;
}

/**
 * Verify the caller's session and load the corresponding merchant row.
 * Server components / route handlers call this on every request that
 * needs the merchant identity. Returns null when the session is
 * missing, invalid, or refers to a merchant that's not in the DB
 * (e.g. because it was uninstalled).
 *
 * Token sources, in order:
 *   1. `Authorization: Bearer <jwt>` header (App Bridge or API calls)
 *   2. `lapsed_session` cookie (set by the OAuth callback)
 */
export async function getMerchantFromSession(): Promise<SessionMerchant | null> {
  const env = serverEnv();

  const hdr = (await headers()).get("authorization") ?? "";
  const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : null;
  const cookieToken = bearer ? null : (await cookies()).get(SESSION_COOKIE)?.value;
  const token = bearer ?? cookieToken;

  const verified = await verifyShopifySessionToken({
    token,
    apiKey: env.shopifyApiKey,
    apiSecret: env.shopifyApiSecret,
  });
  if (!verified.ok) return null;

  const admin = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });
  const { data, error } = await admin
    .from("merchants")
    .select("id, shopify_shop_domain, plan, installed_at, uninstalled_at")
    .eq("shopify_shop_domain", verified.shopDomain)
    .maybeSingle<Pick<MerchantRow, "id" | "shopify_shop_domain" | "plan" | "installed_at" | "uninstalled_at">>();

  if (error || !data) return null;
  if (data.uninstalled_at) return null;

  return {
    id: data.id,
    shopDomain: data.shopify_shop_domain,
    shopName: prettifyShopName(data.shopify_shop_domain),
    shopInitials: initialsForShop(data.shopify_shop_domain),
    plan: data.plan,
    planLabel: planLabelFor(data.plan),
    installedAt: data.installed_at,
  };
}

/**
 * Server-side guard: load the merchant or redirect to the install
 * screen. Server components for authenticated routes await this
 * before rendering.
 *
 * Callers should pass their page's `searchParams` so that any
 * Shopify-supplied params (`shop`, `host`, `embedded`, …) survive the
 * redirect — the install page reads them to drive the embedded-context
 * auto-redirect to OAuth.
 */
export async function requireMerchant(opts?: {
  searchParams?: Record<string, string | string[] | undefined>;
}): Promise<SessionMerchant> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    const qs = buildInstallQueryString(opts?.searchParams);
    redirect(qs ? `/app/auth/install?${qs}` : "/app/auth/install");
  }
  return merchant;
}

function buildInstallQueryString(
  searchParams?: Record<string, string | string[] | undefined>,
): string {
  if (!searchParams) return "";
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") out.set(k, v);
    else if (Array.isArray(v) && typeof v[0] === "string") out.set(k, v[0]);
  }
  return out.toString();
}

function prettifyShopName(domain: string): string {
  const handle = domain.replace(/\.myshopify\.com$/i, "");
  return handle
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function initialsForShop(domain: string): string {
  const name = prettifyShopName(domain);
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
}

function planLabelFor(plan: string): string {
  switch (plan) {
    case "growth":
      return "Growth · 25k msgs";
    case "scale":
      return "Scale · 100k msgs";
    case "starter":
    default:
      return "Starter · 5k msgs";
  }
}
