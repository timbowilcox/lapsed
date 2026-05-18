"use client";

// Root error boundary for app.lapsed.ai (Sprint 11, Chunk 12).
// Rendered when an unhandled error reaches the root layout.

export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-cream-100 px-16 text-center">
      <div className="mb-8 font-bold tracking-[-0.04em] text-[28px] text-ink-900">lapsed.</div>
      <h1 className="mb-8 text-h1 text-ink-900">Something went wrong</h1>
      <p className="mb-24 max-w-[420px] text-body text-ink-500">
        An unexpected error occurred. Refreshing the page usually resolves this — if it persists,
        contact support.
      </p>
      <div className="flex flex-wrap items-center justify-center gap-12">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center rounded-md bg-ink-900 px-16 py-10 text-body-strong text-cream-50 transition-colors hover:bg-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
        >
          Try again
        </button>
        <a
          href="/app"
          className="inline-flex items-center rounded-md border border-border bg-cream-100 px-16 py-10 text-body-strong text-ink-900 transition-colors hover:bg-cream-200 focus-visible:outline-none focus-visible:shadow-focus"
        >
          Back to dashboard
        </a>
      </div>
    </div>
  );
}
