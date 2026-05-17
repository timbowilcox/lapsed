"use client";

import { useState } from "react";
import { Button } from "@lapsed/ui";

/**
 * Opens the Stripe Customer Portal: POSTs to /api/billing/portal and redirects
 * the browser to the returned Stripe-hosted session URL. On failure an inline
 * alert is shown and the button is re-enabled.
 */
export function ManageBillingButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPortal(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      if (!res.ok) throw new Error(`portal responded ${res.status}`);
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("portal response missing url");
      window.location.href = data.url;
    } catch {
      setError("Could not open the billing portal. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <Button
        variant="secondary"
        onClick={() => void openPortal()}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? "Opening…" : "Manage billing"}
      </Button>
      {error ? (
        <p role="alert" className="text-mini text-danger-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}
