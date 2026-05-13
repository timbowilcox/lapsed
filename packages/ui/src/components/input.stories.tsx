import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "./input";

const meta: Meta<typeof Input> = {
  title: "Components/Input",
  component: Input,
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = { args: { placeholder: "Shop name" } };
export const Filled: Story = { args: { defaultValue: "bondi-goods.myshopify.com" } };
export const Disabled: Story = { args: { placeholder: "Locked", disabled: true } };
