import type { Meta, StoryObj } from "@storybook/react";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "./select";

const meta: Meta<typeof Select> = {
  title: "Components/Select",
  component: Select,
};

export default meta;
type Story = StoryObj<typeof Select>;

export const Default: Story = {
  render: () => (
    <div className="w-[280px]">
      <Select>
        <SelectTrigger>
          <SelectValue placeholder="Choose audience" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="60d">Lapsed 60 days</SelectItem>
          <SelectItem value="90d">Lapsed 90 days</SelectItem>
          <SelectItem value="180d">Lapsed 180 days</SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};
