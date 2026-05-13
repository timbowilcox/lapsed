import type { Meta, StoryObj } from "@storybook/react";
import { AppShell, type SidebarNavSection } from "./app-shell";

const meta: Meta<typeof AppShell> = {
  title: "Components/AppShell",
  component: AppShell,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof AppShell>;

const sections: SidebarNavSection[] = [
  {
    items: [
      { href: "/app", icon: "LayoutDashboard", label: "Dashboard" },
      { href: "/app/lapsed", icon: "Users", label: "Lapsed customers", count: "2,847" },
      { href: "/app/campaigns", icon: "Send", label: "Campaigns", count: 3 },
      { href: "/app/conversations", icon: "MessageCircle", label: "Conversations", count: 14 },
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

export const Default: Story = {
  args: {
    sections,
    activeHref: "/app",
    pageTitle: "Dashboard",
    shopInitials: "BG",
    shopName: "Bondi Goods",
    planLabel: "Growth · 25k msgs",
    userInitials: "TW",
    hasNotifications: true,
    children: <div className="text-body text-ink-500">Page content goes here.</div>,
  },
};
