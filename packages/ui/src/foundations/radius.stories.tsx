import type { Meta, StoryObj } from "@storybook/react";

const tokens = [
  { name: "--radius-sm", value: 8, usage: "Buttons, inputs, small chips" },
  { name: "--radius-md", value: 12, usage: "Cards, metric cards, panels" },
  { name: "--radius-lg", value: 16, usage: "Hero card, modal containers" },
  { name: "--radius-xl", value: 20, usage: "Onboarding cards, marketing surfaces" },
  { name: "pill", value: 999, usage: "Status badges, tags" },
];

const meta: Meta = {
  title: "Foundations/Radius",
};

export default meta;
type Story = StoryObj;

export const Scale: Story = {
  render: () => (
    <div className="flex flex-col gap-16 p-32">
      {tokens.map((t) => (
        <div key={t.name} className="flex items-center gap-24">
          <div
            style={{ borderRadius: t.value }}
            className="h-64 w-64 border border-border bg-cream-50"
            aria-hidden="true"
          />
          <div>
            <div className="text-body-strong text-ink-900">{t.name}</div>
            <div className="text-mini text-ink-500">{t.value}px</div>
            <div className="mt-4 text-mini text-ink-700">{t.usage}</div>
          </div>
        </div>
      ))}
    </div>
  ),
};
