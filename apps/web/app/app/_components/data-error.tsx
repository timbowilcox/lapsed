"use client";

import { useEffect } from "react";
import { Button } from "@lapsed/ui";

interface DataErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export function DataError({ error, reset }: DataErrorProps) {
  useEffect(() => {
    // Surface to error monitoring; no PII in the message
    console.error("[data-error]", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-64 text-center">
      <p className="text-body-strong text-ink-900">Something went wrong loading this data.</p>
      <p className="mt-8 max-w-sm text-meta text-ink-500">
        This is usually a temporary issue. Try refreshing the page.
      </p>
      <Button variant="secondary" className="mt-16" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
