/**
 * Pure decision logic for the root-path entry (apps/web/app/page.tsx).
 *
 * Shopify loads embedded apps at the root URL with query params:
 *   /?shop=<shop>&host=<base64>&embedded=1&hmac=<sig>&timestamp=<ts>&id_token=...
 *
 * We:
 *   - Verify the HMAC before trusting ?shop= (anyone can craft query strings)
 *   - Look up whether the merchant is installed (& not uninstalled)
 *   - Route to /app with query string preserved if installed (App Bridge needs it)
 *   - Route to /app/auth/install with shop+host if NOT installed — the install
 *     screen has a user-clickable button that does a top-window redirect to
 *     /api/shopify/install (browsers require a user gesture for cross-origin
 *     iframe → top-window navigation; we cannot auto-redirect server-side or
 *     via window.top.location.href in useEffect, see HANDOFF.md)
 *   - Fall through to /app for direct visits with no shop param
 *
 * Extracted from page.tsx so the routing decision is unit-testable
 * without spinning up Next or a real Supabase client.
 */

export interface RootRedirectDeps {
  searchParams: URLSearchParams;
  /** Verify HMAC of the full searchParams (excluding `hmac` itself). */
  verifyHmac: (params: URLSearchParams) => boolean;
  /** Returns whether the merchant has an installed (uninstalled_at IS NULL) row. */
  lookupMerchant: (shopDomain: string) => Promise<{ installed: boolean }>;
}

export interface RootRedirectResult {
  target: string;
}

export async function resolveRootRedirect(
  deps: RootRedirectDeps,
): Promise<RootRedirectResult> {
  const shop = deps.searchParams.get("shop");

  // Direct visit (no shop) or untrusted query string → existing behavior.
  // We refuse to act on ?shop= without a valid HMAC because anyone can
  // hit /?shop=victim.myshopify.com and try to coerce a redirect.
  if (!shop || !deps.verifyHmac(deps.searchParams)) {
    return { target: "/app" };
  }

  const { installed } = await deps.lookupMerchant(shop);

  if (installed) {
    // Preserve the full query string so App Bridge can read shop/host/id_token.
    // /app renders inside the Admin iframe and App Bridge handles auth from there.
    return { target: `/app?${deps.searchParams.toString()}` };
  }

  // Not installed (or previously uninstalled) → route to the install screen,
  // NOT directly to /api/shopify/install. The install screen renders the
  // "Install on Shopify" button inside the iframe; the user's click triggers
  // a top-window navigation to /api/shopify/install (user gesture allows the
  // cross-origin iframe → top-window jump). The install endpoint then runs
  // first-party and the state cookie is set first-party where the OAuth
  // callback can read it back.
  //
  // Earlier iterations tried window.top.location.href in a useEffect — Chrome
  // blocks that with "Unsafe attempt to initiate navigation… no user gesture",
  // see https://www.chromestatus.com/feature/5851021045661696.
  const installParams = new URLSearchParams();
  installParams.set("shop", shop);
  const host = deps.searchParams.get("host");
  if (host) installParams.set("host", host);
  return { target: `/app/auth/install?${installParams.toString()}` };
}

/**
 * Helper: convert Next's `Promise<{[k]: string | string[] | undefined}>`
 * resolved value into URLSearchParams. Arrays use the first value (matching
 * standard URLSearchParams.get semantics).
 */
export function toURLSearchParams(
  raw: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out.set(k, v);
    else if (Array.isArray(v) && typeof v[0] === "string") out.set(k, v[0]);
  }
  return out;
}
