import type { Meta, StoryObj } from "@storybook/react";
import { MetricCard } from "./metric-card";

const meta: Meta<typeof MetricCard> = {
  title: "Components/MetricCard",
  component: MetricCard,
};

export default meta;
type Story = StoryObj<typeof MetricCard>;

export const Default: Story = {
  args: {
    label: "Active campaigns",
    value: "3",
    trend: "2 live · 1 paused",
    trendDirection: "flat",
  },
};
export const TrendUp: Story = {
  args: {
    label: "Lapsed cohort",
    value: "2,847",
    trend: "↑ 184 this week",
    trendDirection: "up",
  },
};
export const TrendDown: Story = {
  args: {
    label: "Reactivation rate",
    value: "3.4%",
    trend: "↓ 0.6pp vs last 30d",
    trendDirection: "down",
  },
};
