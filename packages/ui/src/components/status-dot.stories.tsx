import type { Meta, StoryObj } from "@storybook/react";
import { StatusDot } from "./status-dot";

const meta: Meta<typeof StatusDot> = {
  title: "Components/StatusDot",
  component: StatusDot,
};

export default meta;
type Story = StoryObj<typeof StatusDot>;

export const Live: Story = { args: { status: "live", label: "Live" } };
export const Draft: Story = { args: { status: "draft", label: "Draft" } };
export const Paused: Story = { args: { status: "paused", label: "Paused" } };
export const Error: Story = { args: { status: "error", label: "Error" } };
