import { redirect } from "next/navigation";
import { verifyOAuthHmac } from "@lapsed/shopify";
import { createServiceClient } from "@lapsed/db";
import { serverEnv } from "./lib/env";
import { resolveRootRedirect, toURLSearchParams } from "./lib/root-redirect";
import { IframeBreakout } from "./_components/iframe-breakout";

// Force per-request rendering — search params drive the redirect target,
// and the merchant lookup hits Supabase. Caching would be wrong.
export const dynamic = "force-dynamic";

type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * Root entry. Three cases:
 *
 *   1. Shopify embedded entry (merchant installed):
 *      /?shop=...&host=...&hmac=...&timestamp=...
 *      Server-side redirect to /app preserving the query string so App
 *      Bridge can read shop/host/id_token from the iframe URL.
 *
 *   2. Shopify embedded entry (merchant NOT installed):
 *      Same URL shape, but the merchant lookup says they're not in our
 *      DB (or uninstalled_at is set). We CANNOT server-side redirect to
 *      /api/shopify/install from here — that would run the install
 *      endpoint inside the Shopify Admin iframe, making the state cookie
 *      a third-party cookie which Chrome drops. Instead we render a tiny
 *      client-side break-out page that does `window.top.location.href`
 *      to start OAuth as a top-level navigation. The install endpoint
 *      then sets the state cookie in first-party context.
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
  const result = await resolveRootRedirect({
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

  if (result.kind === "iframeBreakout") {
    return <IframeBreakout target={result.target} />;
  }
  redirect(result.target);
}
