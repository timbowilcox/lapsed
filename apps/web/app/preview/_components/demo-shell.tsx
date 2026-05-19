"use client";

import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { AppShell, type SidebarNavSection } from "@lapsed/ui";
import { demoFixtures } from "@lapsed/core/demo-fixtures";
import { DemoBanner } from "./demo-banner";

const { merchant, campaigns, conversations } = demoFixtures;

const liveCampaigns = campaigns.filter((c) => c.status === "live" || c.status === "paused").length;
const activeConversations = conversations.filter((c) => c.status === "active").length;

const sections: SidebarNavSection[] = [
  {
    items: [
      { href: "/preview", icon: "LayoutDashboard", label: "Dashboard" },
      {
        href: "/preview/lapsed",
        icon: "Users",
        label: "Lapsed customers",
        count: merchant.totalLapsedCount,
      },
      { href: "/preview/campaigns", icon: "Send", label: "Campaigns", count: liveCampaigns },
      {
        href: "/preview/conversations",
        icon: "MessageCircle",
        label: "Conversations",
        count: activeConversations,
      },
      { href: "/preview/attribution", icon: "TrendingUp", label: "Attribution" },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/preview/billing", icon: "CreditCard", label: "Billing" },
      { href: "/preview/settings", icon: "Settings", label: "Settings" },
    ],
  },
];

function resolveActive(pathname: string): string {
  if (pathname.startsWith("/preview/lapsed")) return "/preview/lapsed";
  if (pathname.startsWith("/preview/campaigns")) return "/preview/campaigns";
  if (pathname.startsWith("/preview/conversations")) return "/preview/conversations";
  if (pathname.startsWith("/preview/attribution")) return "/preview/attribution";
  if (pathname.startsWith("/preview/billing")) return "/preview/billing";
  if (pathname.startsWith("/preview/settings")) return "/preview/settings";
  return "/preview";
}

export function DemoShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const activeHref = resolveActive(pathname);

  return (
    <AppShell
      sections={sections}
      activeHref={activeHref}
      pageTitle="Demo"
      shopInitials={merchant.shopInitials}
      shopName={merchant.shopName}
      planLabel={merchant.planLabel}
      userInitials={merchant.ownerInitials}
      hasNotifications={false}
    >
      <div className="-mx-16 -mt-16 mb-16 md:-mx-32 md:-mt-32 md:mb-32">
        <DemoBanner />
      </div>
      {children}
    </AppShell>
  );
}
