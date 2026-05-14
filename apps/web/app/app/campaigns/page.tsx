import Link from "next/link";
import {
  Button,
  Panel,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  StatusDot,
  formatCount,
} from "@lapsed/ui";
import { Plus } from "lucide-react";
import { campaigns } from "@lapsed/fixtures";
import { MerchantShell } from "../_components/merchant-shell";

export default function CampaignsPage() {
  return (
    <MerchantShell pageTitle="Campaigns">
      <div className="mb-24 flex items-start justify-between gap-16">
        <div>
          <h2 className="mb-4 text-h1 text-ink-900">Campaigns</h2>
          <p className="text-meta text-ink-500">
            Manage your active, draft and paused win-back campaigns.
          </p>
        </div>
        <Button asChild>
          <Link href="/app/campaigns/new">
            <Plus strokeWidth={1.75} size={16} /> New campaign
          </Link>
        </Button>
      </div>

      <Panel>
        <div className="flex items-center gap-8 border-b border-border px-16 py-10">
          <span className="text-mini text-ink-400">[demo data] — real campaigns in Sprint 06</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign</TableHead>
              <TableHead>Audience</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead>Response</TableHead>
              <TableHead>Restored</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link
                    href={`/app/campaigns/${c.id}`}
                    className="block hover:text-ink-900"
                  >
                    <div className="text-body-strong text-ink-900">{c.name}</div>
                    <div className="text-mini text-ink-500">{c.cohortLabel}</div>
                  </Link>
                </TableCell>
                <TableCell>{formatCount(c.audienceSize)}</TableCell>
                <TableCell>{formatCount(c.sentMessages)}</TableCell>
                <TableCell>{(c.responseRate * 100).toFixed(1)}%</TableCell>
                <TableCell>{c.recoveredRevenueDisplay}</TableCell>
                <TableCell>
                  <StatusDot status={c.status} label={c.statusLabel} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </MerchantShell>
  );
}
