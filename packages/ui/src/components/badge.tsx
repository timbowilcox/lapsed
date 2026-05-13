import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-6 rounded-pill px-10 py-4 text-mini",
  {
    variants: {
      tone: {
        neutral: "bg-cream-200 text-ink-700",
        live: "bg-success-100 text-success-500",
        draft: "bg-cream-200 text-ink-700",
        paused: "bg-warning-100 text-warning-500",
        error: "bg-danger-100 text-danger-500",
        info: "bg-lavender-100 text-lavender-700",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(badgeVariants({ tone }), className)}
      {...props}
    />
  );
});

export { badgeVariants };
