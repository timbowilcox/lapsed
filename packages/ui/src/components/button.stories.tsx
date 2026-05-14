import type { Meta, StoryObj } from "@storybook/react";
import { ArrowRight } from "lucide-react";
import { Button } from "./button";

const meta: Meta<typeof Button> = {
  title: "Components/Button",
  component: Button,
  args: { children: "Continue" },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {
  args: { variant: "primary" },
  parameters: {
    docs: {
      description: {
        story:
          "bg-ink-900 (#0A0A0B) · text-cream-50 (#FCFAF5) · WCAG contrast ratio **18.4:1** (AAA)",
      },
    },
  },
};

export const Secondary: Story = {
  args: { variant: "secondary" },
  parameters: {
    docs: {
      description: {
        story:
          "bg-transparent · text-ink-900 (#0A0A0B) on cream-100 (#F8F5EE) · WCAG contrast ratio **17.5:1** (AAA)",
      },
    },
  },
};

export const Ghost: Story = {
  args: { variant: "ghost" },
  parameters: {
    docs: {
      description: {
        story:
          "bg-transparent · text-ink-700 (#2E2C2A) on cream-100 (#F8F5EE) · WCAG contrast ratio **13.1:1** (AAA)",
      },
    },
  },
};

export const Small: Story = { args: { size: "sm" } };
export const Medium: Story = { args: { size: "md" } };
export const Large: Story = { args: { size: "lg" } };
export const Disabled: Story = { args: { disabled: true } };

export const WithIcon: Story = {
  args: {
    children: (
      <>
        Open campaign
        <ArrowRight strokeWidth={1.75} size={16} />
      </>
    ),
  },
};

/** All variants side-by-side for contrast verification */
export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-16 p-16 bg-cream-100">
      <div className="flex items-center gap-12">
        <Button variant="primary">Primary — 18.4:1</Button>
        <Button variant="secondary">Secondary — 17.5:1</Button>
        <Button variant="ghost">Ghost — 13.1:1</Button>
      </div>
      <div className="flex items-center gap-12">
        <Button variant="primary" size="sm">Small</Button>
        <Button variant="primary" size="md">Medium</Button>
        <Button variant="primary" size="lg">Large</Button>
      </div>
      <div className="flex items-center gap-12">
        <Button variant="primary" disabled>Disabled</Button>
        <Button variant="secondary" disabled>Disabled</Button>
      </div>
    </div>
  ),
};
