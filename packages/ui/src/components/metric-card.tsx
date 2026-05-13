import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface MetricCardProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  value: ReactNode;
  trend?: ReactNode;
  trendDirection?: "up" | "down" | "flat";
}

export const MetricCard = forwardRef<HTMLDivElement, MetricCardProps>(function MetricCard(
  { label, value, trend, trendDirection = "flat", className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-md border border-border bg-cream-50 p-20",
        className,
      )}
      {...props}
    >
      <div className="mb-8 text-label text-ink-500">{label}</div>
      <div className="mb-4 text-display text-ink-900">{value}</div>
      {trend && (
        <div
          className={cn(
            "text-mini",
            trendDirection === "up" && "text-success-500",
            trendDirection === "down" && "text-danger-500",
            trendDirection === "flat" && "text-ink-500",
          )}
        >
          {trend}
        </div>
      )}
    </div>
  );
});
