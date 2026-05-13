import type { Meta, StoryObj } from "@storybook/react";

const scale = [0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64];

const meta: Meta = {
  title: "Foundations/Spacing",
};

export default meta;
type Story = StoryObj;

export const Scale: Story = {
  render: () => (
    <div className="flex flex-col gap-12 p-32">
      {scale.map((s) => (
        <div key={s} className="flex items-center gap-16">
          <div className="w-32 text-mini text-ink-700">{s}px</div>
          <div style={{ width: s || 1 }} className="h-16 bg-lavender-400" aria-hidden="true" />
        </div>
      ))}
    </div>
  ),
};
