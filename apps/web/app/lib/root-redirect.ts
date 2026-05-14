/**
 * Pure decision logic for the root-path entry (apps/web/app/page.tsx).
 *
 * Shopify loads embedded apps at the root URL with query params:
 *   /?shop=<shop>&host=<base64>&embedded=1&hmac=<sig>&timestamp=<ts>
 *
 * We need to:
 *   - Verify the HMAC before trusting ?shop= (anyone can craft query strings)
 *   - Look up whether the merchant is installed (& not uninstalled)
 *   - Route to /app (with query string preserved for App Bridge) if installed
 *   - Start OAuth at /api/shopify/install if not
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
    return { target: `/app?${deps.searchParams.toString()}` };
  }

  // Not installed (or previously uninstalled) → run OAuth.
  const installParams = new URLSearchParams();
  installParams.set("shop", shop);
  const host = deps.searchParams.get("host");
  if (host) installParams.set("host", host);
  return { target: `/api/shopify/install?${installParams.toString()}` };
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
