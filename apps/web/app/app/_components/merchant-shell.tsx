"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode } from "react";
import { AppShell, type SidebarNavSection } from "@lapsed/ui";
import { useMerchant } from "./merchant-context";

const sections: SidebarNavSection[] = [
  {
    items: [
      { href: "/app", icon: "LayoutDashboard", label: "Dashboard" },
      { href: "/app/lapsed", icon: "Users", label: "Lapsed customers" },
      { href: "/app/campaigns", icon: "Send", label: "Campaigns" },
      { href: "/app/conversations", icon: "MessageCircle", label: "Conversations" },
      { href: "/app/attribution", icon: "TrendingUp", label: "Attribution" },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/app/settings/billing", icon: "CreditCard", label: "Billing" },
      { href: "/app/settings", icon: "Settings", label: "Settings" },
    ],
  },
];

function resolveActive(pathname: string): string {
  if (pathname.startsWith("/app/lapsed")) return "/app/lapsed";
  if (pathname.startsWith("/app/campaigns")) return "/app/campaigns";
  if (pathname.startsWith("/app/conversations")) return "/app/conversations";
  if (pathname.startsWith("/app/attribution")) return "/app/attribution";
  if (pathname.startsWith("/app/settings/billing")) return "/app/settings/billing";
  if (pathname.startsWith("/app/billing")) return "/app/settings/billing";
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
  const router = useRouter();
  const session = useMerchant();
  const activeHref = resolveActive(pathname);

  const shopInitials = session?.shopInitials ?? "?";
  const shopName = session?.shopName ?? "Your store";
  const planLabel = session?.planLabel;

  async function handleSignOut() {
    await fetch("/api/auth/signout", { method: "POST" });
    router.push("/app/auth/install");
  }

  return (
    <AppShell
      sections={sections}
      activeHref={activeHref}
      pageTitle={pageTitle}
      shopInitials={shopInitials}
      shopName={shopName}
      planLabel={planLabel}
      userInitials={shopInitials}
      hasNotifications={false}
      onSignOut={handleSignOut}
    >
      {children}
    </AppShell>
  );
}
