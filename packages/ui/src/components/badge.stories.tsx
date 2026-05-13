import type { Meta, StoryObj } from "@storybook/react";
import { Badge } from "./badge";

const meta: Meta<typeof Badge> = {
  title: "Components/Badge",
  component: Badge,
  args: { children: "Label" },
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const Neutral: Story = { args: { tone: "neutral", children: "Default" } };
export const Live: Story = { args: { tone: "live", children: "Live" } };
export const Draft: Story = { args: { tone: "draft", children: "Draft" } };
export const Paused: Story = { args: { tone: "paused", children: "Paused" } };
export const Error: Story = { args: { tone: "error", children: "Error" } };
export const Info: Story = { args: { tone: "info", children: "Beta" } };
