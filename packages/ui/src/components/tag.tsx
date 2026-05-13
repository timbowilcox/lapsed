import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const tagVariants = cva(
  "inline-flex items-center rounded px-6 py-2 text-micro uppercase",
  {
    variants: {
      tone: {
        converted: "bg-success-100 text-success-500",
        active: "bg-lavender-100 text-lavender-700",
        stalled: "bg-cream-200 text-ink-500",
        churned: "bg-danger-100 text-danger-500",
      },
    },
    defaultVariants: { tone: "active" },
  },
);

export interface TagProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof tagVariants> {}

export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { className, tone, ...props },
  ref,
) {
  return <span ref={ref} className={cn(tagVariants({ tone }), className)} {...props} />;
});

export { tagVariants };
