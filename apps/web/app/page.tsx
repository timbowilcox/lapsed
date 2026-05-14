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
 *   1. Shopify embedded entry (merchant installed):
 *      /?shop=...&host=...&hmac=...&timestamp=...&id_token=...
 *      Server-side redirect to /app preserving the query string so App
 *      Bridge can read shop/host/id_token.
 *
 *   2. Shopify embedded entry (merchant NOT installed):
 *      Same URL shape, but the merchant isn't in our DB (or uninstalled).
 *      Redirect to /app/auth/install?shop=...&host=... — the install
 *      screen renders the "Install on Shopify" button inside the iframe,
 *      and the user's click does a top-window redirect to OAuth.
 *
 *      We cannot auto-redirect to /api/shopify/install from here:
 *      a) Server-side redirect inside the iframe would set the state
 *         cookie in third-party context (admin.shopify.com is the top
 *         frame, app.lapsed.ai is the iframe), and Chrome drops it.
 *      b) Client-side window.top.location.href in useEffect is blocked
 *         by Chrome's user-gesture requirement for cross-origin iframe
 *         → top-window navigation.
 *
 *   3. Direct visit (no shop) or invalid HMAC:
 *      Redirect to /app, which will redirect to install if no session.
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
