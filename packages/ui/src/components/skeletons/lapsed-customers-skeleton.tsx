export function LapsedCustomersSkeleton() {
  return (
    <div className="animate-pulse" aria-label="Loading lapsed customers">
      <div className="flex items-center gap-12 border-b border-border p-16">
        <div className="h-36 flex-1 rounded-md bg-ink-100" />
        <div className="h-36 w-[200px] rounded-md bg-ink-100" />
        <div className="h-16 w-[80px] rounded bg-ink-100" />
      </div>
      <div className="border-b border-border px-16 py-12">
        <div className="flex gap-16">
          {["flex-1", "w-16", "w-24", "w-20", "w-16", "w-14", "w-16"].map((w, i) => (
            <div key={i} className={`h-12 rounded bg-ink-100 ${w}`} />
          ))}
        </div>
      </div>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-16 border-b border-border px-16 py-14 last:border-b-0">
          <div className="flex flex-1 items-center gap-12">
            <div className="h-32 w-32 shrink-0 rounded-full bg-ink-100" />
            <div className="space-y-4">
              <div className="h-12 w-[120px] rounded bg-ink-100" />
              <div className="h-10 w-[160px] rounded bg-ink-100" />
            </div>
          </div>
          <div className="h-20 w-[52px] rounded-full bg-ink-100" />
          <div className="h-12 w-[80px] rounded bg-ink-100" />
          <div className="h-12 w-[60px] rounded bg-ink-100" />
          <div className="h-12 w-[40px] rounded bg-ink-100" />
          <div className="h-12 w-[48px] rounded bg-ink-100" />
          <div className="h-20 w-[52px] rounded-full bg-ink-100" />
        </div>
      ))}
    </div>
  );
}
