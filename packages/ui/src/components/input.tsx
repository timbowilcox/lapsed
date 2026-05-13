import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-40 w-full rounded-sm border border-cream-300 bg-cream-50 px-12 text-body text-ink-900 placeholder:text-ink-300 transition-colors focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-lavender-500 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
