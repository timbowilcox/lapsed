import { Skeleton } from "@lapsed/ui";

export default function AppLoading() {
  return (
    <div className="p-32" aria-busy="true" aria-label="Loading">
      <div className="mb-16">
        <Skeleton className="mb-12 h-[120px] w-full rounded-xl" />
      </div>
      <div className="mb-32 grid grid-cols-3 gap-12">
        <Skeleton.Card />
        <Skeleton.Card />
        <Skeleton.Card />
      </div>
      <div className="grid grid-cols-[1.4fr_1fr] gap-16">
        <div className="rounded-lg border border-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton.Row key={i} />
          ))}
        </div>
        <div className="rounded-lg border border-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton.Row key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
