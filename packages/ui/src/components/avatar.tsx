import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

const avatarVariants = cva(
  "inline-flex items-center justify-center rounded-pill font-semibold uppercase",
  {
    variants: {
      size: {
        sm: "w-24 h-24 text-mini",
        md: "w-32 h-32 text-mini",
        lg: "w-40 h-40 text-body-strong",
        xl: "w-48 h-48 text-h3",
      },
      tone: {
        lavender: "bg-lavender-50 text-lavender-700",
        ink: "bg-ink-900 text-cream-50",
        cream: "bg-cream-200 text-ink-700",
      },
    },
    defaultVariants: { size: "md", tone: "lavender" },
  },
);

export interface AvatarProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof avatarVariants> {
  initials: string;
}

export const Avatar = forwardRef<HTMLDivElement, AvatarProps>(function Avatar(
  { className, size, tone, initials, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(avatarVariants({ size, tone }), className)}
      aria-label={`Avatar for ${initials}`}
      {...props}
    >
      {initials.slice(0, 2).toUpperCase()}
    </div>
  );
});

export { avatarVariants };
