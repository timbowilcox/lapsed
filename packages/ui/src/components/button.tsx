import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-8 font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-focus",
  {
    variants: {
      variant: {
        primary: "bg-ink-900 text-cream-50 hover:bg-ink-700",
        secondary:
          "bg-transparent border border-cream-300 text-ink-900 hover:bg-cream-200",
        ghost: "bg-transparent text-ink-700 hover:bg-cream-200",
      },
      size: {
        sm: "h-32 px-12 text-meta rounded-sm",
        md: "h-40 px-16 text-body-strong rounded-sm",
        lg: "h-48 px-20 text-body-strong rounded-sm",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
});

export { buttonVariants };
