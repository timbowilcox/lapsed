import type { Meta, StoryObj } from "@storybook/react";

interface Swatch {
  token: string;
  hex: string;
  usage: string;
}

const groups: Array<{ name: string; swatches: Swatch[] }> = [
  {
    name: "Lavender",
    swatches: [
      { token: "--lavender-50", hex: "#F5F1FF", usage: "Hover fills, soft tags" },
      { token: "--lavender-100", hex: "#E8DFFC", usage: "Avatar backgrounds, tag fills" },
      { token: "--lavender-200", hex: "#D4C5F8", usage: "Sub-surface emphasis" },
      { token: "--lavender-400", hex: "#B8A6F4", usage: "Sidebar primary, brand surfaces" },
      { token: "--lavender-500", hex: "#9C85EE", usage: "Chart accents, focus rings" },
      { token: "--lavender-700", hex: "#6B52C9", usage: "Tag text on lavender-100" },
    ],
  },
  {
    name: "Cream",
    swatches: [
      { token: "--cream-50", hex: "#FCFAF5", usage: "Panel surfaces" },
      { token: "--cream-100", hex: "#F8F5EE", usage: "App background" },
      { token: "--cream-200", hex: "#F2EDE2", usage: "Hover states, subtle wells" },
      { token: "--cream-300", hex: "#E8E1D2", usage: "Inputs, dividers" },
      { token: "--cream-400", hex: "#D6CCB7", usage: "Strong borders" },
    ],
  },
  {
    name: "Ink",
    swatches: [
      { token: "--ink-900", hex: "#0A0A0B", usage: "Primary text, primary CTA, wordmark" },
      { token: "--ink-700", hex: "#2E2C2A", usage: "Secondary heading, sidebar nav text" },
      { token: "--ink-500", hex: "#5F5C57", usage: "Body secondary, metric labels" },
      { token: "--ink-300", hex: "#94918A", usage: "Hints, timestamps, disabled" },
    ],
  },
  {
    name: "Status",
    swatches: [
      { token: "--success-500", hex: "#2D8A4E", usage: "Live, positive deltas" },
      { token: "--success-100", hex: "#DDF0E2", usage: "Live badge fill" },
      { token: "--warning-500", hex: "#C8941E", usage: "Paused, scheduled-soon" },
      { token: "--warning-100", hex: "#F8ECCD", usage: "Paused badge fill" },
      { token: "--danger-500", hex: "#C04848", usage: "Notifications, errors" },
      { token: "--danger-100", hex: "#F4DCDC", usage: "Error fills" },
    ],
  },
  {
    name: "Border",
    swatches: [
      { token: "--border", hex: "#ECE6D6", usage: "Default panel and divider" },
      { token: "--border-strong", hex: "#D8D0BC", usage: "Emphasised borders, input rings" },
    ],
  },
];

const meta: Meta = {
  title: "Foundations/Colors",
};

export default meta;
type Story = StoryObj;

export const Palette: Story = {
  render: () => (
    <div className="flex flex-col gap-32 p-32">
      {groups.map((group) => (
        <section key={group.name}>
          <h2 className="mb-16 text-h2 text-ink-900">{group.name}</h2>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
            {group.swatches.map((s) => (
              <div
                key={s.token}
                className="flex items-center gap-16 rounded-md border border-border bg-cream-50 p-16"
              >
                <div
                  style={{ background: s.hex }}
                  className="h-48 w-48 flex-shrink-0 rounded-sm border border-border"
                />
                <div>
                  <div className="text-body-strong text-ink-900">{s.token}</div>
                  <div className="text-mini text-ink-500">{s.hex}</div>
                  <div className="mt-4 text-mini text-ink-700">{s.usage}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  ),
};
