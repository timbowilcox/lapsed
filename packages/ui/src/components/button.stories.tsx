import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import { ArrowRight } from "lucide-react";

const meta: Meta<typeof Button> = {
  title: "Components/Button",
  component: Button,
  args: { children: "Continue" },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = { args: { variant: "primary" } };
export const Secondary: Story = { args: { variant: "secondary" } };
export const Ghost: Story = { args: { variant: "ghost" } };
export const Small: Story = { args: { size: "sm" } };
export const Large: Story = { args: { size: "lg" } };
export const Disabled: Story = { args: { disabled: true } };
export const WithIcon: Story = {
  args: {
    children: (
      <>
        Open campaign
        <ArrowRight strokeWidth={1.75} size={16} />
      </>
    ),
  },
};
