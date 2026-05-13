import type { Meta, StoryObj } from "@storybook/react";
import { Icon, type IconName } from "../components/icon";

const sampleIcons: IconName[] = [
  "LayoutDashboard",
  "Users",
  "Send",
  "MessageCircle",
  "TrendingUp",
  "CreditCard",
  "Settings",
  "Bell",
  "HelpCircle",
  "ChevronsUpDown",
  "ArrowRight",
  "Plus",
  "Search",
  "Filter",
  "Check",
  "X",
];

const meta: Meta = {
  title: "Foundations/Iconography",
};

export default meta;
type Story = StoryObj;

export const Library: Story = {
  render: () => (
    <div className="flex flex-col gap-16 p-32">
      <div className="text-meta text-ink-500">
        Lucide React · stroke-width 1.75 default · 18px in nav, 20px in buttons, 14–16px inline
      </div>
      <div className="grid grid-cols-2 gap-16 md:grid-cols-4 lg:grid-cols-6">
        {sampleIcons.map((name) => (
          <div
            key={name}
            className="flex flex-col items-center gap-8 rounded-md border border-border bg-cream-50 p-16"
          >
            <Icon name={name} size={24} className="text-ink-900" />
            <div className="text-mini text-ink-500">{name}</div>
          </div>
        ))}
      </div>
    </div>
  ),
};

export const StrokeWidths: Story = {
  render: () => (
    <div className="flex items-center gap-32 p-32">
      <div className="flex flex-col items-center gap-8">
        <Icon name="Users" size={32} strokeWidth={1.25} />
        <div className="text-mini text-ink-500">1.25</div>
      </div>
      <div className="flex flex-col items-center gap-8">
        <Icon name="Users" size={32} strokeWidth={1.75} />
        <div className="text-mini text-ink-500">1.75 (default)</div>
      </div>
      <div className="flex flex-col items-center gap-8">
        <Icon name="Users" size={32} strokeWidth={2.25} />
        <div className="text-mini text-ink-500">2.25</div>
      </div>
    </div>
  ),
};
