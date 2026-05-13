import type { Meta, StoryObj } from "@storybook/react";
import { Toaster, toast } from "./toast";
import { Button } from "./button";

const meta: Meta<typeof Toaster> = {
  title: "Components/Toast",
  component: Toaster,
};

export default meta;
type Story = StoryObj<typeof Toaster>;

export const Default: Story = {
  render: () => (
    <div>
      <Button onClick={() => toast("Campaign launched")}>Show toast</Button>
      <Toaster />
    </div>
  ),
};
