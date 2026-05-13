import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-md border border-border bg-cream-50",
          className,
        )}
        {...props}
      />
    );
  },
);

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return <div ref={ref} className={cn("p-20", className)} {...props} />;
  },
);

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return <h3 ref={ref} className={cn("text-h3 text-ink-900", className)} {...props} />;
  },
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn("p-20 pt-0", className)} {...props} />;
  },
);

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("flex items-center p-20 pt-0", className)}
        {...props}
      />
    );
  },
);
