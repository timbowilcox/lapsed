import { Panel, PanelHeader, PanelBody } from "@lapsed/ui";
import { DemoShell } from "../_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";

const tierLabel: Record<string, string> = {
  vip: "VIP",
  repeat: "Repeat",
  new: "New",
};

const statusLabel: Record<string, string> = {
  lapsed: "Lapsed",
  reactivating: "Reactivating",
  churned: "Churned",
  converted: "Restored",
};

export default function DemoLapsedPage() {
  const { lapsedCustomers } = demoFixtures;

  return (
    <DemoShell>
      <div className="mb-24 flex items-start justify-between">
        <div>
          <h1 className="mb-4 text-h1 text-ink-900">Lapsed customers</h1>
          <p className="text-meta text-ink-500">
            Customers past their typical purchase cadence. Score blends frequency, value and
            recency.
          </p>
        </div>
      </div>

      <Panel>
        <PanelHeader title={`${lapsedCustomers.length} customers shown`} />
        <PanelBody>
          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="border-b border-border text-left">
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500">Customer</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500">Tier</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500 tabular-nums">Total spent</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500">Days since order</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500">Score</th>
                  <th scope="col" className="px-22 py-12 text-label font-medium text-ink-500">Status</th>
                </tr>
              </thead>
              <tbody>
                {lapsedCustomers.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-b-0 hover:bg-cream-100">
                    <td className="px-22 py-14">
                      <div className="flex items-center gap-10">
                        <span className="inline-flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-pill bg-lavender-100 text-mini font-semibold text-lavender-700">
                          {c.initials}
                        </span>
                        <div>
                          <div className="text-body-strong text-ink-900">
                            {c.firstName} {c.lastName}
                          </div>
                          <div className="text-mini text-ink-500">{c.preferredCategory}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-22 py-14 text-meta text-ink-700">{tierLabel[c.tier]}</td>
                    <td className="px-22 py-14 text-meta tabular-nums text-ink-900">
                      ${c.lifetimeValue.toLocaleString("en-US")}
                    </td>
                    <td className="px-22 py-14 text-meta tabular-nums text-ink-700">
                      {c.lastOrderDaysAgo}d
                    </td>
                    <td className="px-22 py-14">
                      <div className="flex items-center gap-8">
                        <div className="h-6 w-48 overflow-hidden rounded-pill bg-cream-300">
                          <div
                            className="h-full rounded-pill bg-lavender-400"
                            style={{ width: `${c.reactivationScore}%` }}
                          />
                        </div>
                        <span className="text-mini tabular-nums text-ink-700">
                          {c.reactivationScore}
                        </span>
                      </div>
                    </td>
                    <td className="px-22 py-14">
                      <span
                        className={`inline-flex items-center rounded-pill px-8 py-3 text-mini font-medium ${
                          c.status === "converted"
                            ? "bg-success-100 text-success-500"
                            : c.status === "reactivating"
                              ? "bg-lavender-100 text-lavender-700"
                              : c.status === "churned"
                                ? "bg-danger-100 text-danger-500"
                                : "bg-cream-200 text-ink-700"
                        }`}
                      >
                        {statusLabel[c.status]}
                      </span>
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
