import type { Meta, StoryObj } from "@storybook/react";
import { Icon } from "./icon";

const meta: Meta<typeof Icon> = {
  title: "Components/Icon",
  component: Icon,
  args: { name: "LayoutDashboard", size: 24 },
};

export default meta;
type Story = StoryObj<typeof Icon>;

export const Default: Story = {};
export const Send: Story = { args: { name: "Send", size: 24 } };
export const Bell: Story = { args: { name: "Bell", size: 24 } };
export const StrokeOverride: Story = { args: { name: "Users", size: 32, strokeWidth: 2.25 } };
