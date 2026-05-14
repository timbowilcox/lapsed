import {
  Card,
  HeroMetric,
  Panel,
  PanelHeader,
  PanelBody,
  Badge,
  RevenueChart,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  formatCurrency,
  formatCount,
} from "@lapsed/ui";
import { attribution } from "@lapsed/fixtures";
import { MerchantShell } from "../_components/merchant-shell";

export default function AttributionPage() {
  return (
    <MerchantShell pageTitle="Attribution">
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">Restored revenue</h2>
        <p className="text-meta text-ink-500">
          Revenue from orders attributable to a campaign-driven conversation, reconciled against
          Shopify orders.
        </p>
      </div>

      <div className="mb-12 rounded-sm border border-cream-200 bg-cream-50 px-12 py-8">
        <span className="text-mini text-ink-400">[demo data] — real attribution in Sprint 08</span>
      </div>

      <HeroMetric
        label="Total restored · last 30 days"
        currency="$"
        value={formatCount(attribution.totalRecoveredRevenue)}
        meta={
          <>
            <span className="font-medium text-success-500">↑ {attribution.vsPreviousPeriodPct}%</span>{" "}
            vs previous period · {attribution.totalRecoveredOrders} orders
          </>
        }
        className="mb-16"
      />

      <div className="mb-16 grid grid-cols-3 gap-12">
        <Card className="p-20">
          <div className="text-label text-ink-500">Recovered orders</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {attribution.totalRecoveredOrders}
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">vs previous 30 days</div>
          <div className="mt-8 text-display text-success-500 tabular-nums">
            ↑ {attribution.vsPreviousPeriodPct}%
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Average order</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {formatCurrency(
              Math.round(attribution.totalRecoveredRevenue / attribution.totalRecoveredOrders) * 100,
            )}
          </div>
        </Card>
      </div>

      <Panel className="mb-16">
        <PanelHeader title="Restored revenue — last 30 days" />
        <PanelBody>
          <div className="p-24">
            <RevenueChart
              data={attribution.byDay.map((d) => ({ date: d.date, value: d.recoveredRevenue }))}
            />
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="By campaign" />
        <PanelBody>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Restored revenue</TableHead>
                <TableHead>Orders</TableHead>
                <TableHead>Reconciliation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attribution.byCampaign.map((b) => (
                <TableRow key={b.campaignId}>
                  <TableCell>{b.campaignName}</TableCell>
                  <TableCell className="tabular-nums">
                    {formatCurrency(b.recoveredRevenue * 100)}
                  </TableCell>
                  <TableCell className="tabular-nums">{b.recoveredOrders}</TableCell>
                  <TableCell>
                    <Badge
                      tone={
                        b.reconciliationStatus === "reconciled"
                          ? "live"
                          : b.reconciliationStatus === "pending"
                            ? "paused"
                            : "error"
                      }
                    >
                      {b.reconciliationStatus === "reconciled"
                        ? "Reconciled"
                        : b.reconciliationStatus === "pending"
                          ? "Pending"
                          : "Discrepancy"}
                    </Badge>
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
