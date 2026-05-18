// Root loading screen — shown during initial navigation to the app
// before the first page renders. Displays the lapsed wordmark with a
// subtle pulse so merchants see the brand rather than a blank screen.

export default function RootLoading() {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-cream-100"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="flex flex-col items-center gap-16">
        {/* Wordmark */}
        <div className="font-bold tracking-[-0.04em] text-[32px] text-ink-900 opacity-0 motion-safe:animate-reveal">
          lapsed.
        </div>
        {/* Subtle spinner */}
        <div
          className="h-4 w-4 rounded-pill bg-lavender-400 motion-safe:animate-pulse"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
