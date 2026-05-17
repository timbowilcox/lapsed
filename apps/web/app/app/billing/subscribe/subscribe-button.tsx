"use client";

import { useState } from "react";
import { Button } from "@lapsed/ui";
import type { SubscriptionTier } from "@lapsed/core";

interface SubscribeButtonProps {
  tier: SubscriptionTier;
  /** Accessible button label, e.g. "Select Growth". */
  label: string;
}

/**
 * Starts a Stripe Checkout session for a tier and redirects the browser to the
 * Stripe-hosted page. POSTs to /api/billing/checkout; on success the response
 * carries the session URL. On failure an inline alert is shown and the button
 * is re-enabled so the merchant can retry.
 */
export function SubscribeButton({ tier, label }: SubscribeButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startCheckout(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      if (!res.ok) throw new Error(`checkout responded ${res.status}`);
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("checkout response missing url");
      window.location.href = data.url;
    } catch {
      setError("Checkout could not be started. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <Button
        variant="primary"
        onClick={() => void startCheckout()}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? "Starting checkout…" : label}
      </Button>
      {error ? (
        <p role="alert" className="text-mini text-danger-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
