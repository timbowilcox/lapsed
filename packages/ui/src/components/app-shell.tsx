"use client";

import { Bell, HelpCircle, User, ChevronRight } from "lucide-react";
import { type ReactNode } from "react";
import { SidebarItem } from "./sidebar-item";
import { ShopSwitcher } from "./shop-switcher";
import { type IconName } from "./icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "./dropdown-menu";

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
  /** Kept for backward-compat; no longer rendered in the topbar. */
  pageTitle: string;
  shopInitials: string;
  shopName: string;
  planLabel?: string;
  userInitials: string;
  hasNotifications?: boolean;
  onSignOut?: () => void;
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
  onSignOut,
  children,
}: AppShellProps) {
  return (
    <div className="grid min-h-screen grid-cols-[248px_1fr]">
      <a
        href="#main-content"
        className="absolute left-4 top-4 z-50 -translate-y-full rounded-sm bg-ink-900 px-12 py-8 text-cream-50 text-body-strong transition-transform focus:translate-y-0 focus-visible:translate-y-0"
      >
        Skip to content
      </a>
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
            {/* Help — opens docs site in new tab */}
            <a
              href="https://docs.lapsed.ai"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Help"
              className="relative inline-flex h-32 w-32 items-center justify-center rounded-md text-ink-700 transition-colors hover:bg-cream-200 focus-visible:outline-none focus-visible:shadow-focus"
            >
              <HelpCircle strokeWidth={1.75} size={20} />
            </a>

            {/* Notifications dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Notifications"
                  className="relative inline-flex h-32 w-32 items-center justify-center rounded-md text-ink-700 transition-colors hover:bg-cream-200 focus-visible:outline-none focus-visible:shadow-focus"
                >
                  <Bell strokeWidth={1.75} size={20} />
                  {hasNotifications && (
                    <span
                      className="absolute -right-0.5 -top-0.5 h-8 w-8 rounded-full bg-danger-500 ring-2 ring-cream-100"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <div className="px-8 py-12 text-center">
                  <p className="text-body-strong text-ink-900">No notifications yet</p>
                  <p className="mt-4 text-meta text-ink-500">
                    We&apos;ll let you know when campaigns finish or customers reply.
                  </p>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Avatar / account dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Account menu"
                  className="relative ml-4 inline-flex h-32 w-32 items-center justify-center rounded-pill bg-ink-900 text-[12px] font-semibold text-cream-50 transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:shadow-focus"
                >
                  {userInitials.slice(0, 2).toUpperCase()}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem asChild>
                  <a href="/app/settings">
                    <User className="mr-8 opacity-60" strokeWidth={1.75} size={14} />
                    Account settings
                  </a>
                </DropdownMenuItem>
                <DropdownMenuItem disabled>
                  <ChevronRight className="mr-8 opacity-60" strokeWidth={1.75} size={14} />
                  Switch shop
                  <span className="ml-auto pl-8 text-mini text-ink-300">Coming soon</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onSignOut?.()}>
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div id="main-content" className="flex-1 overflow-y-auto p-32">{children}</div>
      </main>
    </div>
  );
}
