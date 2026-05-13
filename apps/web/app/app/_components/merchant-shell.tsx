"use client";

import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { AppShell, type SidebarNavSection } from "@lapsed/ui";
import { merchant, campaigns, conversations } from "@lapsed/fixtures";

const campaignsCount = campaigns.filter((c) => c.status !== "draft").length;
const conversationsCount = conversations.filter((c) => c.status === "active").length;

const sections: SidebarNavSection[] = [
  {
    items: [
      { href: "/app", icon: "LayoutDashboard", label: "Dashboard" },
      {
        href: "/app/lapsed",
        icon: "Users",
        label: "Lapsed customers",
        count: merchant.totalLapsedCount.toLocaleString(),
      },
      { href: "/app/campaigns", icon: "Send", label: "Campaigns", count: campaignsCount },
      {
        href: "/app/conversations",
        icon: "MessageCircle",
        label: "Conversations",
        count: conversationsCount,
      },
      { href: "/app/attribution", icon: "TrendingUp", label: "Attribution" },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/app/billing", icon: "CreditCard", label: "Billing" },
      { href: "/app/settings", icon: "Settings", label: "Settings" },
    ],
  },
];

function resolveActive(pathname: string): string {
  if (pathname.startsWith("/app/lapsed")) return "/app/lapsed";
  if (pathname.startsWith("/app/campaigns")) return "/app/campaigns";
  if (pathname.startsWith("/app/conversations")) return "/app/conversations";
  if (pathname.startsWith("/app/attribution")) return "/app/attribution";
  if (pathname.startsWith("/app/billing")) return "/app/billing";
  if (pathname.startsWith("/app/settings")) return "/app/settings";
  if (pathname.startsWith("/app/onboarding")) return "/app/onboarding";
  return "/app";
}

export function MerchantShell({
  pageTitle,
  children,
}: {
  pageTitle: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const activeHref = resolveActive(pathname);

  return (
    <AppShell
      sections={sections}
      activeHref={activeHref}
      pageTitle={pageTitle}
      shopInitials={merchant.shopInitials}
      shopName={merchant.shopName}
      planLabel={merchant.planLabel}
      userInitials={merchant.ownerInitials}
      hasNotifications
    >
      {children}
    </AppShell>
  );
}
