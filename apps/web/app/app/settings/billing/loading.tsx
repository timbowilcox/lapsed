import { Skeleton } from "@lapsed/ui";

export default function BillingLoading() {
  return (
    <div className="p-32" aria-busy="true" aria-label="Loading billing">
      <div className="mb-24">
        <Skeleton className="mb-4 h-[28px] w-[100px]" />
        <Skeleton.Text />
      </div>
      <div className="grid grid-cols-2 gap-16">
        <Skeleton.Card />
        <Skeleton.Card />
      </div>
    </div>
  );
}
