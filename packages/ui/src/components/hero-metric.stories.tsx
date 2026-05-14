import type { Meta, StoryObj } from "@storybook/react";
import { HeroMetric } from "./hero-metric";

const meta: Meta<typeof HeroMetric> = {
  title: "Components/HeroMetric",
  component: HeroMetric,
  parameters: {
    docs: {
      description: {
        component:
          "Instrument Serif hero numeral. **Rule**: used exactly once per page for the single largest metric. All other numeric values use Geist Sans with `tabular-nums`.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof HeroMetric>;

const chart = (
  <svg viewBox="0 0 280 80" preserveAspectRatio="none" className="h-full w-full overflow-visible">
    <defs>
      <linearGradient id="hero-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#9C85EE" stopOpacity="0.35" />
        <stop offset="100%" stopColor="#9C85EE" stopOpacity="0" />
      </linearGradient>
    </defs>
    <path
      d="M0,60 L20,55 L40,58 L60,48 L80,52 L100,42 L120,45 L140,38 L160,40 L180,30 L200,33 L220,22 L240,25 L260,15 L280,18 L280,80 L0,80 Z"
      fill="url(#hero-grad)"
    />
    <path
      d="M0,60 L20,55 L40,58 L60,48 L80,52 L100,42 L120,45 L140,38 L160,40 L180,30 L200,33 L220,22 L240,25 L260,15 L280,18"
      fill="none"
      stroke="#6B52C9"
      strokeWidth="2"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
);

/** Dashboard / Attribution — full width with pulse dot and mini chart */
export const WithChart: Story = {
  args: {
    label: "Recovered revenue · last 30 days",
    pulse: true,
    currency: "$",
    value: "47,283",
    meta: (
      <>
        <span className="font-medium text-success-500">↑ 23%</span> vs previous period · 142 orders
      </>
    ),
    chart,
  },
};

/** Billing — compact, no chart */
export const Compact: Story = {
  args: {
    label: "Monthly",
    currency: "$",
    value: "799",
    meta: "Renews 4 June 2026",
  },
};

/** No currency prefix */
export const NoCurrency: Story = {
  args: {
    label: "Active conversations",
    value: "2,847",
    meta: "↑ 184 this week",
  },
};
