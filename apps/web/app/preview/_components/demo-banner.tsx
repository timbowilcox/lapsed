"use client";

import { useState, useEffect } from "react";
import { X, ShoppingBag } from "lucide-react";
import Link from "next/link";

const SESSION_KEY = "lapsed_demo_banner_dismissed";

export function DemoBanner() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(sessionStorage.getItem(SESSION_KEY) === "1");
  }, []);

  function dismiss() {
    sessionStorage.setItem(SESSION_KEY, "1");
    setDismissed(true);
  }

  if (dismissed) return null;

  return (
    <div
      role="note"
      className="flex items-center justify-between gap-12 border-b border-lavender-200 bg-lavender-100 px-32 py-12"
    >
      <p className="text-meta text-lavender-700">
        <span className="font-medium">This is a demo.</span> Data shown is simulated — your real
        store data stays private.
      </p>
      <div className="flex items-center gap-12">
        <Link
          href="/app/auth/install"
          className="inline-flex items-center gap-6 rounded-sm bg-ink-900 px-12 py-6 text-mini font-semibold text-cream-50 transition-colors hover:opacity-80"
        >
          <ShoppingBag strokeWidth={1.75} size={13} />
          Install on Shopify
        </Link>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss demo banner"
          className="inline-flex h-24 w-24 items-center justify-center rounded-sm text-lavender-700 transition-colors hover:bg-lavender-200 focus-visible:outline-none focus-visible:shadow-focus"
        >
          <X strokeWidth={1.75} size={14} />
        </button>
      </div>
    </div>
  );
}
