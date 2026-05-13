import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const statusVariants = cva(
  "inline-flex items-center gap-6 rounded-pill px-10 py-4 text-mini font-medium",
  {
    variants: {
      status: {
        live: "bg-success-100 text-success-500",
        draft: "bg-cream-200 text-ink-700",
        paused: "bg-warning-100 text-warning-500",
        error: "bg-danger-100 text-danger-500",
      },
    },
    defaultVariants: { status: "live" },
  },
);

const dotVariants = cva("h-6 w-6 rounded-pill flex-shrink-0", {
  variants: {
    status: {
      live: "bg-success-500",
      draft: "bg-ink-300",
      paused: "bg-warning-500",
      error: "bg-danger-500",
    },
  },
  defaultVariants: { status: "live" },
});

export interface StatusDotProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusVariants> {
  label: string;
}

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(function StatusDot(
  { className, status, label, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(statusVariants({ status }), className)}
      {...props}
    >
      <span className={dotVariants({ status })} aria-hidden="true" />
      {label}
    </span>
  );
});
