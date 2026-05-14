import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { Icon, type IconName } from "./icon";

export interface SidebarItemProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  icon: IconName;
  label: string;
  count?: number | string;
  active?: boolean;
}

export const SidebarItem = forwardRef<HTMLAnchorElement, SidebarItemProps>(function SidebarItem(
  { href, icon, label, count, active = false, className, ...props },
  ref,
) {
  return (
    <a
      ref={ref}
      href={href}
      className={cn(
        "flex items-center gap-12 rounded-md px-12 py-10 text-body-strong text-ink-900 transition-colors focus-visible:outline-none focus-visible:shadow-focus",
        active
          ? "bg-ink-900 text-cream-50 opacity-100"
          : "opacity-[0.78] hover:bg-white/25 hover:opacity-100",
        className,
      )}
      aria-current={active ? "page" : undefined}
      {...props}
    >
      <Icon name={icon} size={18} className="flex-shrink-0" aria-hidden="true" />
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            "rounded-pill px-7 py-2 text-[11px] font-semibold leading-[1.4]",
            active ? "bg-lavender-400 text-ink-900" : "bg-lavender-100 text-lavender-700",
          )}
        >
          {count}
        </span>
      )}
    </a>
  );
});
