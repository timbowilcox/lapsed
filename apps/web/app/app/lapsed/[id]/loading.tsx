export default function LapsedDetailLoading() {
  return (
    <div className="animate-pulse">
      <div className="mb-24 flex items-start justify-between gap-16">
        <div className="flex items-center gap-16">
          <div className="h-48 w-48 rounded-full bg-cream-200" />
          <div>
            <div className="mb-8 h-20 w-48 rounded bg-cream-200" />
            <div className="h-12 w-40 rounded bg-cream-200" />
          </div>
        </div>
        <div className="flex gap-8">
          <div className="h-32 w-40 rounded-md bg-cream-200" />
          <div className="h-32 w-40 rounded-md bg-cream-200" />
        </div>
      </div>

      <div className="mb-16 grid grid-cols-4 gap-12">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-cream-50 p-20">
            <div className="mb-8 h-10 w-24 rounded bg-cream-200" />
            <div className="h-24 w-20 rounded bg-cream-200" />
          </div>
        ))}
      </div>

      <div className="mb-16 rounded-lg border border-border bg-cream-50">
        <div className="border-b border-border px-22 pb-14 pt-18">
          <div className="h-14 w-16 rounded bg-cream-200" />
        </div>
        <div className="grid grid-cols-3 divide-x divide-border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="px-24 py-20">
              <div className="mb-12 h-10 w-32 rounded bg-cream-200" />
              <div className="h-20 w-24 rounded bg-cream-200" />
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[1.2fr_1fr] gap-16">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-cream-50">
            <div className="border-b border-border px-22 pb-14 pt-18">
              <div className="h-14 w-32 rounded bg-cream-200" />
            </div>
            <div className="p-24">
              <div className="mb-8 h-10 w-full rounded bg-cream-200" />
              <div className="h-10 w-3/4 rounded bg-cream-200" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
