import { Skeleton } from "@lapsed/ui";

export default function AttributionLoading() {
  return (
    <div className="p-32" aria-busy="true">
      <div className="mb-24">
        <Skeleton className="mb-4 h-[28px] w-[200px]" />
        <Skeleton.Text />
      </div>
      <div className="mb-16 grid grid-cols-3 gap-12">
        <Skeleton.Card />
        <Skeleton.Card />
        <Skeleton.Card />
      </div>
      <div className="mb-16 rounded-lg border border-border p-24">
        <Skeleton className="h-[240px] w-full" />
      </div>
      <div className="rounded-lg border border-border">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton.Row key={i} />
        ))}
      </div>
    </div>
  );
}
