import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export interface HeroMetricProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  currency?: string;
  value: ReactNode;
  meta?: ReactNode;
  pulse?: boolean;
  chart?: ReactNode;
}

export const HeroMetric = forwardRef<HTMLDivElement, HeroMetricProps>(function HeroMetric(
  { label, currency, value, meta, pulse = false, chart, className, ...props },
  ref,
) {
  return (
    <section
      ref={ref}
      className={cn(
        "grid grid-cols-[1fr_auto] items-center gap-32 rounded-lg border border-border bg-cream-50 px-32 py-28",
        className,
      )}
      {...props}
    >
      <div>
        <div className="mb-8 flex items-center gap-8 text-label text-ink-500">
          {pulse && (
            <span className="relative inline-flex h-7 w-7" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full rounded-pill bg-success-500 opacity-30 motion-safe:animate-pulse" />
              <span className="relative inline-flex h-7 w-7 rounded-pill bg-success-500" />
            </span>
          )}
          {label}
        </div>
        <div className="mb-6 font-serif text-hero text-ink-900">
          {currency && (
            <span className="align-top text-[36px] leading-[1.2] text-ink-500">{currency}</span>
          )}
          {value}
        </div>
        {meta && <div className="text-meta text-ink-500">{meta}</div>}
      </div>
      {chart && <div className="h-80 w-[280px]">{chart}</div>}
    </section>
  );
});
