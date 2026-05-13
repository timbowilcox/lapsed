import type { Meta, StoryObj } from "@storybook/react";

const scale = [
  { token: "text-hero", className: "font-serif text-hero", sample: "47,283", desc: "64 / 1.0 / 400 (Instrument Serif) / -0.03em — Hero stat values only" },
  { token: "text-display", className: "text-display", sample: "2,847", desc: "28 / 1.1 / 500 / -0.02em — Metric values" },
  { token: "text-h1", className: "text-h1", sample: "Campaign performance", desc: "22 / 1.2 / 600 / -0.015em — Page titles" },
  { token: "text-h2", className: "text-h2", sample: "Section heading", desc: "18 / 1.3 / 600 / -0.01em — Section titles" },
  { token: "text-h3", className: "text-h3", sample: "Panel title", desc: "15 / 1.35 / 600 / normal — Panel and card titles" },
  { token: "text-body", className: "text-body", sample: "Default body copy reads at this size.", desc: "14 / 1.5 / 400 — Default body" },
  { token: "text-body-strong", className: "text-body-strong", sample: "Emphasised body copy.", desc: "14 / 1.5 / 500 — Emphasis in body" },
  { token: "text-meta", className: "text-meta", sample: "Helper text under inputs.", desc: "13 / 1.4 / 400 — Helper / metadata" },
  { token: "text-label", className: "text-label", sample: "Recovered revenue", desc: "13 / 1.3 / 500 — Metric / form labels" },
  { token: "text-mini", className: "text-mini", sample: "812 customers · launched 8 days ago", desc: "12 / 1.35 / 500 — Statuses, sub-rows" },
  { token: "text-micro", className: "text-micro uppercase", sample: "CONVERTED", desc: "11 / 1.4 / 600 / 0.04em — Tags, section labels (uppercase)" },
];

const meta: Meta = {
  title: "Foundations/Typography",
};

export default meta;
type Story = StoryObj;

export const Scale: Story = {
  render: () => (
    <div className="flex flex-col gap-20 p-32">
      {scale.map((row) => (
        <div
          key={row.token}
          className="grid grid-cols-[160px_1fr] gap-16 border-b border-border pb-16 last:border-b-0"
        >
          <div>
            <div className="text-mini text-ink-700">{row.token}</div>
            <div className="mt-4 text-[11px] text-ink-500">{row.desc}</div>
          </div>
          <div className={row.className}>{row.sample}</div>
        </div>
      ))}
    </div>
  ),
};

export const Fonts: Story = {
  render: () => (
    <div className="flex flex-col gap-24 p-32">
      <div>
        <div className="mb-8 text-mini text-ink-500">Geist (sans)</div>
        <div className="font-sans text-h1 text-ink-900">The quick brown fox jumps</div>
      </div>
      <div>
        <div className="mb-8 text-mini text-ink-500">Instrument Serif (hero only)</div>
        <div className="font-serif text-hero text-ink-900">47,283</div>
      </div>
    </div>
  ),
};
