import { Bell, HelpCircle } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "../lib/cn";
import { SidebarItem } from "./sidebar-item";
import { ShopSwitcher } from "./shop-switcher";
import { type IconName } from "./icon";

export interface SidebarNavItem {
  href: string;
  icon: IconName;
  label: string;
  count?: number | string;
}

export interface SidebarNavSection {
  label?: string;
  items: SidebarNavItem[];
}

export interface AppShellProps {
  sections: SidebarNavSection[];
  activeHref: string;
  pageTitle: string;
  shopInitials: string;
  shopName: string;
  planLabel: string;
  userInitials: string;
  hasNotifications?: boolean;
  children: ReactNode;
}

export function AppShell({
  sections,
  activeHref,
  pageTitle: _pageTitle,
  shopInitials,
  shopName,
  planLabel,
  userInitials,
  hasNotifications = false,
  children,
}: AppShellProps) {
  return (
    <div className="grid min-h-screen grid-cols-[248px_1fr]">
      <aside className="flex flex-col border-r border-border bg-lavender-400 px-16 py-24">
        <div className="px-12 pb-32 pt-8 text-[28px] font-bold leading-none tracking-[-0.04em] text-ink-900">
          lapsed<span>.</span>
        </div>

        <nav className="flex flex-1 flex-col gap-2" aria-label="Primary">
          {sections.map((section, sectionIndex) => (
            <div key={section.label ?? `section-${sectionIndex}`} className="flex flex-col gap-2">
              {section.label && (
                <div className="px-12 pb-8 pt-16 text-[11px] font-medium uppercase tracking-[0.08em] text-ink-700 opacity-60">
                  {section.label}
                </div>
              )}
              {section.items.map((item) => (
                <SidebarItem
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  label={item.label}
                  count={item.count}
                  active={item.href === activeHref}
                />
              ))}
            </div>
          ))}
        </nav>

        <ShopSwitcher shopInitials={shopInitials} shopName={shopName} planLabel={planLabel} />
      </aside>

      <main className="flex min-w-0 flex-col">
        <header className="flex h-64 items-center justify-end border-b border-border bg-cream-100 px-32">
          <div className="flex items-center gap-8">
            <IconButton aria-label="Help">
              <HelpCircle strokeWidth={1.75} size={20} />
            </IconButton>
            <IconButton aria-label="Notifications">
              <Bell strokeWidth={1.75} size={20} />
              {hasNotifications && (
                <span
                  className="absolute -right-0.5 -top-0.5 h-8 w-8 rounded-full bg-danger-500 ring-2 ring-cream-100"
                  aria-hidden="true"
                />
              )}
            </IconButton>
            <div className="ml-4 flex h-32 w-32 items-center justify-center rounded-pill bg-ink-900 text-[12px] font-semibold text-cream-50">
              {userInitials.slice(0, 2).toUpperCase()}
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-32">{children}</div>
      </main>
    </div>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
}

function IconButton({ children, className, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        "relative inline-flex h-36 w-36 items-center justify-center rounded-md text-ink-700 transition-colors hover:bg-cream-200 focus-visible:outline-none focus-visible:shadow-focus",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
