"use client";

import { useEffect } from "react";

/**
 * Escapes the Shopify Admin iframe before navigating to `target`. Renders
 * a small loading card and immediately performs `window.top.location.href
 * = target` so the destination loads as a top-level navigation.
 *
 * Why break out before OAuth instead of doing a server-side redirect:
 *   - If /api/shopify/install is hit inside the Admin iframe, the state
 *     cookie it sets is a third-party cookie (app.lapsed.ai inside an
 *     admin.shopify.com page). Modern Chrome drops third-party cookies
 *     without `Partitioned`, so the callback can't read the state.
 *   - Breaking out to top-level navigation means the install endpoint
 *     runs first-party. SameSite=Lax works, and the callback (also
 *     top-level — Shopify's consent page refuses to embed) reads the
 *     cookie reliably.
 *
 * Defense-in-depth: the install endpoint also sets the cookie with
 * SameSite=None; Secure; Partitioned, so if window.top is blocked for
 * any reason, the third-party path still works in CHIPS-compliant
 * browsers.
 *
 * The component itself is `aria-live="polite"` so screen readers
 * announce the redirecting state.
 */
export function IframeBreakout({ target }: { target: string }) {
  useEffect(() => {
    // window.top can be null when the page is in a sandboxed iframe
    // without allow-top-navigation. Fall back to in-frame navigation —
    // the Shopify Admin iframe sets allow-top-navigation, so this path
    // is mostly paranoia.
    const top = window.top ?? window;
    top.location.href = target;
  }, [target]);

  return (
    <>
      {/* meta refresh fallback if JS is disabled (extremely unlikely in
          Shopify Admin, included for completeness). React 19 hoists
          <meta> from body into <head> automatically. */}
      <noscript>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <meta httpEquiv="refresh" content={`0; url=${target}`} />
      </noscript>
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-screen items-center justify-center bg-cream-100 px-24"
      >
        <div className="max-w-[420px] rounded-lg border border-border bg-white p-32 text-center">
          <div className="flex items-center justify-center gap-8 text-h3 text-ink-900">
            <span
              aria-hidden="true"
              className="h-8 w-8 animate-pulse rounded-full bg-lavender-400"
            />
            Starting install…
          </div>
          <p className="mt-8 text-meta text-ink-500">
            Redirecting to Shopify to confirm permissions. If this page
            doesn&apos;t forward,{" "}
            <a href={target} className="font-medium text-ink-900 underline">
              click here
            </a>
            .
          </p>
        </div>
      </div>
    </>
  );
}
