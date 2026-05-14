import { redirect } from "next/navigation";
import { verifyOAuthHmac } from "@lapsed/shopify";
import { createServiceClient } from "@lapsed/db";
import { serverEnv } from "./lib/env";
import { resolveRootRedirect, toURLSearchParams } from "./lib/root-redirect";

// Force per-request rendering — search params drive the redirect target,
// and the merchant lookup hits Supabase. Caching would be wrong.
export const dynamic = "force-dynamic";

type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Root entry. Three cases:
 *
 *   1. Shopify embedded entry: /?shop=...&host=...&hmac=...&timestamp=...
 *      Verify HMAC, look up the merchant, then either redirect into the
 *      dashboard (installed) or kick off OAuth (not installed).
 *
 *   2. Untrusted ?shop= without a valid HMAC: fall through to (3) — never
 *      blindly trust the query string from arbitrary callers.
 *
 *   3. Direct visit (no shop, e.g. someone typing the URL):
 *      Redirect to /app, which will then redirect to install if no session.
 */
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = toURLSearchParams(await searchParams);

  // Fast path: no shop param → no need to hit Supabase at all.
  if (!params.has("shop")) {
    redirect("/app");
  }

  const env = serverEnv();
  const { target } = await resolveRootRedirect({
    searchParams: params,
    verifyHmac: (p) => verifyOAuthHmac(p, env.shopifyApiSecret),
    lookupMerchant: async (shop) => {
      const admin = createServiceClient({
        url: env.supabaseUrl,
        serviceKey: env.supabaseSecretKey,
      });
      const { data } = await admin
        .from("merchants")
        .select("uninstalled_at")
        .eq("shopify_shop_domain", shop)
        .maybeSingle();
      return { installed: !!data && data.uninstalled_at === null };
    },
  });
  redirect(target);
}
