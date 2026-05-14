import type { Meta, StoryObj } from "@storybook/react";
import { RevenueChart } from "./revenue-chart";

const meta: Meta<typeof RevenueChart> = {
  title: "Components/RevenueChart",
  component: RevenueChart,
  parameters: {
    docs: {
      description: {
        component:
          "Recharts AreaChart with Vellum lavender gradient. `compact` omits axes/grid — used inside `<HeroMetric chart={...}>`. `auto` renders full axes with currency labels — used on Attribution page.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof RevenueChart>;

const thirtyDays = Array.from({ length: 30 }, (_, i) => {
  const d = new Date("2026-04-14");
  d.setDate(d.getDate() + i);
  const base = 800 + i * 40;
  return {
    date: d.toISOString().slice(0, 10),
    value: base + Math.round(Math.sin(i * 0.6) * 200),
  };
});

/** Attribution page — full axes, grid, tooltip */
export const Full: Story = {
  args: {
    data: thirtyDays,
    height: 280,
    range: "auto",
  },
};

/** Dashboard hero — compact, no axes, fits inside the 80px HeroMetric slot */
export const Compact: Story = {
  args: {
    data: thirtyDays,
    height: 80,
    range: "compact",
  },
};
