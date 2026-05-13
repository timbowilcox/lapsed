import type { Meta, StoryObj } from "@storybook/react";
import { ShopSwitcher } from "./shop-switcher";

const meta: Meta<typeof ShopSwitcher> = {
  title: "Components/ShopSwitcher",
  component: ShopSwitcher,
  decorators: [
    (Story) => (
      <div className="w-[216px] bg-lavender-400 p-12">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ShopSwitcher>;

export const Default: Story = {
  args: { shopInitials: "BG", shopName: "Bondi Goods", planLabel: "Growth · 25k msgs" },
};
