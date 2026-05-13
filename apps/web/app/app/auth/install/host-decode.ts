/**
 * Extracts the Shopify shop domain from URL search params.
 *
 * Priority:
 *   1. ?shop= — direct value (standard install-link flow)
 *   2. ?host= — base64-encoded admin URL (embedded-app sidebar flow)
 *   3. null   — neither present; caller should show the disabled fallback
 *
 * Shopify passes ?host= (not ?shop=) when the merchant opens the app via
 * the Admin sidebar at admin.shopify.com/store/<shop>/apps/<app>. The host
 * value base64-encodes "admin.shopify.com/store/<shop-name>"; we reconstruct
 * "<shop-name>.myshopify.com" from that path segment.
 */
export function shopFromParams(params: { get(key: string): string | null }): string | null {
  const shop = params.get("shop");
  if (shop) return shop;

  const host = params.get("host");
  if (!host) return null;

  return shopFromHost(host);
}

/**
 * Decodes a Shopify ?host= base64 value and returns the shop domain,
 * or null if the value does not contain a recognisable /store/<shop> segment.
 */
export function shopFromHost(encodedHost: string): string | null {
  let decoded: string;
  try {
    // atob is available globally in Node 18+ and all modern browsers.
    decoded = atob(encodedHost);
  } catch {
    return null;
  }

  // Matches "/store/<shop-name>" with optional trailing slash at end of string.
  const match = decoded.match(/\/store\/([^/?#]+)\/?$/);
  if (!match?.[1]) return null;

  return `${match[1]}.myshopify.com`;
}
