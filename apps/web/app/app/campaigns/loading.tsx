import { Skeleton } from "@lapsed/ui";

export default function CampaignsLoading() {
  return (
    <div className="p-32" aria-busy="true">
      <div className="mb-24">
        <Skeleton className="mb-4 h-[28px] w-[160px]" />
        <Skeleton.Text />
      </div>
      <div className="rounded-lg border border-border">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton.Row key={i} />
        ))}
      </div>
    </div>
  );
}
