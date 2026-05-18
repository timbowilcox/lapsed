import { Skeleton } from "@lapsed/ui";

export default function ConversationsLoading() {
  return (
    <div className="p-32" aria-busy="true" aria-label="Loading conversations">
      <div className="mb-24">
        <Skeleton className="mb-4 h-[28px] w-[190px]" />
        <Skeleton.Text />
      </div>
      <div className="rounded-lg border border-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton.Row key={i} />
        ))}
      </div>
    </div>
  );
}
