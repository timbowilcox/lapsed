import type { Meta, StoryObj } from "@storybook/react";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "./card";
import { Button } from "./button";

const meta: Meta<typeof Card> = {
  title: "Components/Card",
  component: Card,
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: () => (
    <Card className="w-[360px]">
      <CardHeader>
        <CardTitle>Plan: Growth</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-body text-ink-500">25,000 SMS messages per month included.</p>
      </CardContent>
      <CardFooter>
        <Button variant="secondary">Manage plan</Button>
      </CardFooter>
    </Card>
  ),
};
