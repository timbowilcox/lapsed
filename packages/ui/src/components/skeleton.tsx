import { cn } from "../lib/cn";

interface SkeletonProps {
  className?: string;
}

function SkeletonBase({ className }: SkeletonProps) {
  return (
    <div
      className={cn("rounded bg-cream-300 motion-safe:animate-pulse", className)}
      aria-hidden="true"
    />
  );
}

function SkeletonText({ className, lines = 1 }: SkeletonProps & { lines?: number }) {
  if (lines === 1) {
    return <SkeletonBase className={cn("h-[14px] w-[60%]", className)} />;
  }
  return (
    <div className="flex flex-col gap-6">
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBase
          key={i}
          className={cn("h-[14px]", i === lines - 1 ? "w-[40%]" : "w-full", className)}
        />
      ))}
    </div>
  );
}

function SkeletonRow({ className }: SkeletonProps) {
  return (
    <div className={cn("flex items-center gap-12 px-22 py-14", className)} aria-hidden="true">
      <SkeletonBase className="h-32 w-32 shrink-0 rounded-pill" />
      <div className="flex flex-1 flex-col gap-6">
        <SkeletonBase className="h-[14px] w-[40%]" />
        <SkeletonBase className="h-[12px] w-[60%]" />
      </div>
    </div>
  );
}

function SkeletonCard({ className }: SkeletonProps) {
  return (
    <div
      className={cn("rounded-lg border border-border p-24", className)}
      aria-hidden="true"
    >
      <SkeletonBase className="mb-8 h-[12px] w-[30%]" />
      <SkeletonBase className="mb-16 h-[32px] w-[50%]" />
      <SkeletonBase className="h-[14px] w-full" />
    </div>
  );
}

export const Skeleton = Object.assign(SkeletonBase, {
  Text: SkeletonText,
  Row: SkeletonRow,
  Card: SkeletonCard,
});
