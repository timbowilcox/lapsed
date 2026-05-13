import type { Meta, StoryObj } from "@storybook/react";
import { ConversationRow } from "./conversation-row";

const meta: Meta<typeof ConversationRow> = {
  title: "Components/ConversationRow",
  component: ConversationRow,
};

export default meta;
type Story = StoryObj<typeof ConversationRow>;

export const Converted: Story = {
  args: {
    initials: "JR",
    name: "Jess R.",
    time: "2m ago",
    preview: "\"yeah I'd actually love to try the new one\"",
    tagTone: "converted",
    tagLabel: "Converted · $124",
  },
};

export const Active: Story = {
  args: {
    initials: "MK",
    name: "Marcus K.",
    time: "12m ago",
    preview: "\"is shipping still free over $80?\"",
    tagTone: "active",
    tagLabel: "AI replying",
  },
};

export const Stalled: Story = {
  args: {
    initials: "SP",
    name: "Sarah P.",
    time: "38m ago",
    preview: "\"maybe later, send me a reminder next month\"",
    tagTone: "stalled",
    tagLabel: "Re-scheduled",
  },
};
