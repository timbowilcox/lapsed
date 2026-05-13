import type { Meta, StoryObj } from "@storybook/react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./table";

const meta: Meta<typeof Table> = {
  title: "Components/Table",
  component: Table,
};

export default meta;
type Story = StoryObj<typeof Table>;

export const Default: Story = {
  render: () => (
    <div className="w-[640px] overflow-hidden rounded-md border border-border bg-cream-50">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Score</TableHead>
            <TableHead>Lifetime value</TableHead>
            <TableHead>Last order</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Jess Reilly</TableCell>
            <TableCell>0.82</TableCell>
            <TableCell>$412.00</TableCell>
            <TableCell>62 days ago</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Marcus King</TableCell>
            <TableCell>0.74</TableCell>
            <TableCell>$298.40</TableCell>
            <TableCell>84 days ago</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  ),
};
