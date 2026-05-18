// Root 404 page for app.lapsed.ai (Sprint 11, Chunk 12).
// Rendered by Next.js whenever a route is not matched.

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-cream-100 px-16 text-center">
      <div className="mb-8 font-bold tracking-[-0.04em] text-display text-ink-900">lapsed.</div>
      <h1 className="mb-8 text-h1 text-ink-900">Page not found</h1>
      <p className="mb-24 max-w-[420px] text-body text-ink-500">
        That page doesn&apos;t exist. If you followed a link that should work, let us know.
      </p>
      <Link
        href="/app"
        className="inline-flex items-center rounded-md bg-ink-900 px-16 py-10 text-body-strong text-cream-50 transition-colors hover:bg-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
