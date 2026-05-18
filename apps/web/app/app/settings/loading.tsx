import { Skeleton } from "@lapsed/ui";

export default function SettingsLoading() {
  return (
    <div className="p-32" aria-busy="true">
      <div className="mb-24">
        <Skeleton className="mb-4 h-[28px] w-[120px]" />
        <Skeleton.Text />
      </div>
      <div className="mb-16 rounded-lg border border-border p-24">
        <Skeleton.Card className="mb-12" />
        <Skeleton.Card />
      </div>
      <div className="grid grid-cols-2 gap-16">
        <div className="rounded-lg border border-border p-24">
          <Skeleton.Card className="mb-12" />
          <Skeleton.Card />
        </div>
        <div className="rounded-lg border border-border p-24">
          <Skeleton.Card className="mb-12" />
          <Skeleton.Card />
        </div>
      </div>
    </div>
  );
}
