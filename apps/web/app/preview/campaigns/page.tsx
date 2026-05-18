import { Panel, PanelHeader, PanelBody, CampaignRow } from "@lapsed/ui";
import { DemoShell } from "../_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";

export default function DemoCampaignsPage() {
  const { campaigns } = demoFixtures;

  return (
    <DemoShell>
      <div className="mb-24">
        <h1 className="mb-4 text-h1 text-ink-900">Campaign review</h1>
        <p className="text-meta text-ink-500">
          The agent drafts a campaign for each scored customer group. Review the proposals below
          and approve, edit, or reject them. Nothing is sent until you approve.
        </p>
      </div>

      <Panel>
        <PanelHeader title="Active campaigns" />
        <PanelBody>
          {campaigns.map((c) => (
            <CampaignRow
              key={c.id}
              name={c.name}
              meta={c.meta}
              status={c.status === "completed" ? "draft" : c.status}
              statusLabel={c.statusLabel}
              revenue={c.recoveredRevenueDisplay}
              revenueLabel={c.status === "draft" || c.status === "completed" ? "pending" : "restored"}
            />
          ))}
        </PanelBody>
      </Panel>
    </DemoShell>
  );
}
