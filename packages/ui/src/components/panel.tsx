import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export const Panel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Panel({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "overflow-hidden rounded-lg border border-border bg-cream-50",
          className,
        )}
        {...props}
      />
    );
  },
);

interface PanelHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: ReactNode;
  action?: ReactNode;
}

export function PanelHeader({ title, action, className, ...props }: PanelHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between border-b border-border px-22 pb-14 pt-18",
        className,
      )}
      {...props}
    >
      <div className="text-h3 text-ink-900">{title}</div>
      {action}
    </div>
  );
}

export const PanelBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function PanelBody({ className, ...props }, ref) {
    return <div ref={ref} className={cn("", className)} {...props} />;
  },
);
