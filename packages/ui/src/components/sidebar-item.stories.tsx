import type { Meta, StoryObj } from "@storybook/react";
import { SidebarItem } from "./sidebar-item";

const meta: Meta<typeof SidebarItem> = {
  title: "Components/SidebarItem",
  component: SidebarItem,
  decorators: [
    (Story) => (
      <div className="w-[216px] bg-lavender-400 p-12">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SidebarItem>;

export const Default: Story = {
  args: { href: "#", icon: "LayoutDashboard", label: "Dashboard" },
};
export const Active: Story = {
  args: { href: "#", icon: "LayoutDashboard", label: "Dashboard", active: true },
};
export const WithCount: Story = {
  args: { href: "#", icon: "Users", label: "Lapsed customers", count: "2,847" },
};
export const ActiveWithCount: Story = {
  args: { href: "#", icon: "Send", label: "Campaigns", count: 3, active: true },
};
