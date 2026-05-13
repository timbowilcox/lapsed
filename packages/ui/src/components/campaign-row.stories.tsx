import type { Meta, StoryObj } from "@storybook/react";
import { CampaignRow } from "./campaign-row";

const meta: Meta<typeof CampaignRow> = {
  title: "Components/CampaignRow",
  component: CampaignRow,
};

export default meta;
type Story = StoryObj<typeof CampaignRow>;

export const Live: Story = {
  args: {
    name: "Summer dormant — 60 day cohort",
    meta: "812 customers · launched 8 days ago",
    status: "live",
    statusLabel: "Live",
    revenue: "$23,140",
  },
};

export const Draft: Story = {
  args: {
    name: "Replenishment — supplements",
    meta: "446 customers · scheduled tomorrow",
    status: "draft",
    statusLabel: "Draft",
    revenueLabel: "pending",
  },
};

export const Paused: Story = {
  args: {
    name: "Holiday returners",
    meta: "1,189 customers · paused yesterday",
    status: "paused",
    statusLabel: "Paused",
    revenue: "$5,853",
  },
};
