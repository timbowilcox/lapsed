"use client";

import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { AppShell, formatCount, type SidebarNavSection } from "@lapsed/ui";
import {
  merchant as fixtureMerchant,
  campaigns,
  conversations,
} from "@lapsed/fixtures";
import { useMerchant } from "./merchant-context";

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
        count: formatCount(fixtureMerchant.totalLapsedCount),
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
  const session = useMerchant();
  const activeHref = resolveActive(pathname);

  const shopInitials = session?.shopInitials ?? fixtureMerchant.shopInitials;
  const shopName = session?.shopName ?? fixtureMerchant.shopName;
  const planLabel = session?.planLabel ?? fixtureMerchant.planLabel;

  return (
    <AppShell
      sections={sections}
      activeHref={activeHref}
      pageTitle={pageTitle}
      shopInitials={shopInitials}
      shopName={shopName}
      planLabel={planLabel}
      userInitials={fixtureMerchant.ownerInitials}
      hasNotifications
    >
      {children}
    </AppShell>
  );
}
