import type { Meta, StoryObj } from "@storybook/react";
import { Tag } from "./tag";

const meta: Meta<typeof Tag> = {
  title: "Components/Tag",
  component: Tag,
};

export default meta;
type Story = StoryObj<typeof Tag>;

export const Converted: Story = { args: { tone: "converted", children: "Converted · $124" } };
export const Active: Story = { args: { tone: "active", children: "AI replying" } };
export const Stalled: Story = { args: { tone: "stalled", children: "Re-scheduled" } };
export const Churned: Story = { args: { tone: "churned", children: "Churned" } };
