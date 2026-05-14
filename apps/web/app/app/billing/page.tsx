import {
  Button,
  Card,
  HeroMetric,
  Panel,
  PanelHeader,
  PanelBody,
  Badge,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  formatCount,
  formatDate,
} from "@lapsed/ui";
import { billing } from "@lapsed/fixtures";
import { MerchantShell } from "../_components/merchant-shell";

const planTiers = [
  { tier: "starter", label: "Starter", price: 299, quota: 5000 },
  { tier: "growth", label: "Growth", price: 799, quota: 25000 },
  { tier: "scale", label: "Scale", price: 1999, quota: 100000 },
];

export default function BillingPage() {
  const usagePercent = (billing.monthlyMessagesUsed / billing.monthlyMessageQuota) * 100;

  return (
    <MerchantShell pageTitle="Billing">
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">Billing</h2>
        <p className="text-meta text-ink-500">
          Manage your subscription, monitor SMS quota and download invoices.
        </p>
      </div>

      <div className="mb-12 rounded-sm border border-cream-200 bg-cream-50 px-12 py-8">
        <span className="text-mini text-ink-400">[demo data] — Stripe billing wired in Sprint 08</span>
      </div>

      <div className="mb-16 grid grid-cols-[1.5fr_1fr] gap-16">
        <Panel>
          <PanelHeader
            title="Current plan"
            action={<Badge tone="info">{billing.currentPlanLabel}</Badge>}
          />
          <PanelBody>
            <div className="flex items-end justify-between p-24">
              <HeroMetric
                label="Monthly"
                currency="$"
                value={String(billing.currentPlanPrice)}
                meta={`Renews ${formatDate(billing.renewsAt, "short")}`}
              />
              <Button variant="secondary">Manage subscription</Button>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Usage this period" />
          <PanelBody>
            <div className="flex flex-col gap-12 p-24">
              <div className="flex items-baseline justify-between">
                <span className="text-display text-ink-900 tabular-nums">
                  {formatCount(billing.monthlyMessagesUsed)}
                </span>
                <span className="text-meta text-ink-500">
                  of {formatCount(billing.monthlyMessageQuota)} SMS
                </span>
              </div>
              <div className="h-8 w-full overflow-hidden rounded-pill bg-cream-200">
                <div
                  className="h-full bg-lavender-500"
                  style={{ width: `${Math.min(100, usagePercent)}%` }}
                />
              </div>
              <div className="text-mini text-ink-500">
                {(100 - usagePercent).toFixed(0)}% remaining
              </div>
            </div>
          </PanelBody>
        </Panel>
      </div>

      <Panel className="mb-16">
        <PanelHeader title="Switch plan" />
        <PanelBody>
          <div className="grid grid-cols-3 gap-12 p-24">
            {planTiers.map((tier) => {
              const isCurrent = tier.tier === billing.currentPlan;
              return (
                <Card key={tier.tier} className={`p-20 ${isCurrent ? "border-lavender-400" : ""}`}>
                  <div className="mb-8 flex items-center justify-between">
                    <span className="text-body-strong text-ink-900">{tier.label}</span>
                    {isCurrent && <Badge tone="info">Current</Badge>}
                  </div>
                  <div className="mb-12 text-display text-ink-900 tabular-nums">
                    ${tier.price}
                    <span className="ml-2 text-meta font-normal text-ink-500">/ mo</span>
                  </div>
                  <div className="mb-16 text-meta text-ink-500">
                    {formatCount(tier.quota)} SMS messages
                  </div>
                  <Button variant={isCurrent ? "secondary" : "primary"} disabled={isCurrent}>
                    {isCurrent ? "Current plan" : "Choose plan"}
                  </Button>
                </Card>
              );
            })}
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Invoice history"
          action={<span className="text-meta text-ink-500">Card ending {billing.paymentMethodLast4}</span>}
        />
        <PanelBody>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {billing.invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell>{formatDate(inv.issuedAt, "short")}</TableCell>
                  <TableCell className="tabular-nums">${inv.amount}</TableCell>
                  <TableCell>
                    <Badge tone={inv.status === "paid" ? "live" : "neutral"}>
                      {inv.status === "paid" ? "Paid" : inv.status === "open" ? "Open" : "Void"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <a
                      href={inv.url}
                      className="text-meta font-medium text-lavender-700 hover:text-ink-900"
                    >
                      Download
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelBody>
      </Panel>
    </MerchantShell>
  );
}
