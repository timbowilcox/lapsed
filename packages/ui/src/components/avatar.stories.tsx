import type { Meta, StoryObj } from "@storybook/react";
import { Avatar } from "./avatar";

const meta: Meta<typeof Avatar> = {
  title: "Components/Avatar",
  component: Avatar,
  args: { initials: "JR" },
};

export default meta;
type Story = StoryObj<typeof Avatar>;

export const Small: Story = { args: { size: "sm" } };
export const Medium: Story = { args: { size: "md" } };
export const Large: Story = { args: { size: "lg" } };
export const XLarge: Story = { args: { size: "xl" } };
export const InkTone: Story = { args: { tone: "ink", initials: "BG" } };
export const CreamTone: Story = { args: { tone: "cream", initials: "TW" } };
