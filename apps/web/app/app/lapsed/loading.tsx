import { LapsedCustomersSkeleton } from "@lapsed/ui";

export default function LapsedLoading() {
  return (
    <div className="p-32" aria-busy="true" aria-label="Loading lapsed customers">
      <div className="mb-24">
        <div className="motion-safe:animate-pulse mb-4 h-[28px] w-[220px] rounded bg-cream-300" aria-hidden="true" />
        <div className="motion-safe:animate-pulse h-[16px] w-[320px] rounded bg-cream-300" aria-hidden="true" />
      </div>
      <LapsedCustomersSkeleton />
    </div>
  );
}
