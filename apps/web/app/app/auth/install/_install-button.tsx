"use client";

import { useEffect, useState } from "react";
import { Button } from "@lapsed/ui";
import { ShoppingBag } from "lucide-react";
import { shopFromParams } from "./host-decode";

/**
 * Install CTA on the public install screen. The screen is typically
 * rendered inside the Shopify Admin iframe (via the App Listing or
 * Partner Dashboard "Test on dev store" flow) — clicking install
 * needs to break out of the iframe to Shopify's OAuth consent page.
 *
 * We do a top-window redirect to `/api/shopify/install` instead of an
 * anchor navigation, because:
 *   1. The install URL needs the `shop` (and optionally `host`) param
 *      that Shopify passes when it embeds us
 *   2. Shopify's consent page must load top-level — embedded auth is
 *      not allowed and would itself break out, double-redirecting
 *
 * App Bridge's Redirect API is not applicable here: there is no
 * merchant session yet, so App Bridge has nothing to bind to.
 *
 * Shop resolution priority (see host-decode.ts):
 *   ?shop= → use directly (standard install-link flow)
 *   ?host= → base64-decode to derive shop domain (Admin sidebar flow)
 *   neither → button disabled
 *
 * Styling note: the button uses the lavender accent on ink-black ring
 * rather than the default primary (ink-on-cream). The default has had
 * a contrast regression in iframe contexts where some hosts apply
 * `color: inherit` to button content; a hard-coded lavender background
 * with ink text reads clearly regardless of host CSS.
 */
export function InstallButton() {
  const [shop, setShop] = useState<string | null>(null);
  const [host, setHost] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setShop(shopFromParams(params));
    setHost(params.get("host"));
  }, []);

  const handleInstall = () => {
    if (!shop) return;
    const target = new URL("/api/shopify/install", window.location.origin);
    target.searchParams.set("shop", shop);
    if (host) target.searchParams.set("host", host);
    const dest = target.toString();
    // Break out of the Shopify Admin iframe before navigating to
    // Shopify's OAuth consent page (which refuses to load embedded).
    if (window.top && window.top !== window.self) {
      window.top.location.href = dest;
    } else {
      window.location.href = dest;
    }
  };

  return (
    <Button
      size="lg"
      onClick={handleInstall}
      disabled={!shop}
      title={!shop ? "Open this page from your Shopify Admin to install" : undefined}
      className="bg-lavender-400 text-ink-900 hover:bg-lavender-500"
    >
      <ShoppingBag strokeWidth={1.75} size={18} />
      {shop ? "Install on Shopify" : "Open from Shopify Admin to install"}
    </Button>
  );
}
