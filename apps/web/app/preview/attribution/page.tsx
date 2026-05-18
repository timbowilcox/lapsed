import { Panel, PanelHeader, PanelBody, RevenueChart, formatCount } from "@lapsed/ui";
import { DemoShell } from "../_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";

export default function DemoAttributionPage() {
  const { attribution } = demoFixtures;

  return (
    <DemoShell>
      <div className="mb-24">
        <h1 className="mb-4 text-h1 text-ink-900">Revenue restored</h1>
        <p className="text-meta text-ink-500">
          Incremental revenue from campaign-driven conversations, measured against each
          campaign&apos;s matched comparison group and reconciled against Shopify orders.
        </p>
      </div>

      <div className="mb-16 grid grid-cols-3 gap-12">
        <div className="rounded-lg border border-border bg-cream-50 px-24 py-20">
          <div className="mb-4 text-label text-ink-500">Incremental revenue · last 30 days</div>
          <div className="text-display tabular-nums text-ink-900">
            ${formatCount(attribution.incrementalRevenue)}
          </div>
          <div className="mt-4 text-mini text-ink-500">
            {attribution.incrementalityPct}% of gross · 95% CI ${formatCount(attribution.ciLow)}–$
            {formatCount(attribution.ciHigh)}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-cream-50 px-24 py-20">
          <div className="mb-4 text-label text-ink-500">Gross restored</div>
          <div className="text-display tabular-nums text-ink-900">
            ${formatCount(attribution.totalRestoredRevenue)}
          </div>
          <div className="mt-4 text-mini text-ink-500">
            <span className="text-success-500">↑ {attribution.vsPreviousPeriodPct}%</span> vs
            prior period
          </div>
        </div>
        <div className="rounded-lg border border-border bg-cream-50 px-24 py-20">
          <div className="mb-4 text-label text-ink-500">Restored orders</div>
          <div className="text-display tabular-nums text-ink-900">
            {attribution.totalRestoredOrders}
          </div>
          <div className="mt-4 text-mini text-ink-500">across {attribution.byCampaign.length} campaigns</div>
        </div>
      </div>

      <Panel className="mb-16">
        <PanelHeader title="Daily restored revenue" />
        <PanelBody>
          <div className="px-4 pt-4">
            <RevenueChart
              data={attribution.byDay.map((d) => ({ date: d.date, value: d.recoveredRevenue }))}
              height={240}
              range="auto"
            />
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="By campaign" />
        <PanelBody>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left">
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500">Campaign</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500 tabular-nums">Restored</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500 tabular-nums">Incremental</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500 tabular-nums">Orders</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500">95% CI</th>
                </tr>
              </thead>
              <tbody>
                {attribution.byCampaign.map((row) => (
                  <tr key={row.campaignId} className="border-b border-border last:border-b-0">
                    <td className="px-22 py-14 text-body-strong text-ink-900">{row.campaignName}</td>
                    <td className="px-22 py-14 tabular-nums text-ink-900">
                      ${formatCount(row.recoveredRevenue)}
                    </td>
                    <td className="px-22 py-14 tabular-nums text-ink-900">
                      ${formatCount(row.incrementalRevenue)}
                    </td>
                    <td className="px-22 py-14 tabular-nums text-ink-700">{row.recoveredOrders}</td>
                    <td className="px-22 py-14 text-mini text-ink-500 tabular-nums">
                      ${formatCount(row.ciLow)}–${formatCount(row.ciHigh)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </PanelBody>
      </Panel>
    </DemoShell>
  );
}
