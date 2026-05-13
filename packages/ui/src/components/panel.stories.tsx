import type { Meta, StoryObj } from "@storybook/react";
import { Panel, PanelHeader, PanelBody } from "./panel";

const meta: Meta<typeof Panel> = {
  title: "Components/Panel",
  component: Panel,
};

export default meta;
type Story = StoryObj<typeof Panel>;

export const Default: Story = {
  render: () => (
    <Panel className="w-[480px]">
      <PanelHeader title="Campaigns" action={<a className="text-meta text-ink-500" href="#">View all</a>} />
      <PanelBody>
        <div className="p-22 text-meta text-ink-500">Panel body content.</div>
      </PanelBody>
    </Panel>
  ),
};
