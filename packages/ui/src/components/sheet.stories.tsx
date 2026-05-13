import type { Meta, StoryObj } from "@storybook/react";
import { Sheet, SheetTrigger, SheetContent } from "./sheet";
import { Button } from "./button";

const meta: Meta<typeof Sheet> = {
  title: "Components/Sheet",
  component: Sheet,
};

export default meta;
type Story = StoryObj<typeof Sheet>;

export const Default: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="secondary">Open sidebar</Button>
      </SheetTrigger>
      <SheetContent>
        <div className="text-h3 text-ink-900">lapsed.</div>
        <div className="mt-32 text-meta text-ink-900 opacity-75">
          Mobile sidebar contents render here.
        </div>
      </SheetContent>
    </Sheet>
  ),
};
