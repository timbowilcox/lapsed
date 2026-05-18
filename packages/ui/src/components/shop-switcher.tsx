import { ChevronsUpDown } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export interface ShopSwitcherProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  shopInitials?: string | null;
  shopName?: string | null;
  planLabel?: string | null;
}

export const ShopSwitcher = forwardRef<HTMLButtonElement, ShopSwitcherProps>(
  function ShopSwitcher(
    { shopInitials, shopName, planLabel, className, ...props },
    ref,
  ) {
    const initials = shopInitials?.slice(0, 2).toUpperCase() ?? "";
    const loading = !shopName;
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "mt-16 flex w-full items-center gap-10 rounded-md bg-ink-900/[0.08] p-12 text-left transition-colors hover:bg-ink-900/[0.12] focus-visible:outline-none focus-visible:shadow-focus",
          className,
        )}
        {...props}
      >
        <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-sm bg-ink-900 text-mini font-semibold text-cream-50">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          {loading ? (
            <div className="h-[12px] w-[70%] rounded bg-ink-900/20 motion-safe:animate-pulse" />
          ) : (
            <div className="truncate text-meta font-semibold text-ink-900">{shopName}</div>
          )}
          {planLabel && (
            <div className="text-[11px] text-ink-700 opacity-75">{planLabel}</div>
          )}
        </div>
        <ChevronsUpDown
          strokeWidth={1.75}
          size={14}
          className="flex-shrink-0 text-ink-900 opacity-60"
          aria-hidden="true"
        />
      </button>
    );
  },
);
