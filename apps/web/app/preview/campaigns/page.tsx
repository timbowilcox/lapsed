import { Panel, PanelHeader, PanelBody, CampaignRow } from "@lapsed/ui";
import { DemoShell } from "../_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";
import { SuggestedCampaigns } from "../../app/campaigns/_suggested-campaigns";
import { TemplateLibrary } from "../../app/campaigns/_template-library";

export default function DemoCampaignsPage() {
  const { campaigns, insights } = demoFixtures;
  const cohortInsights = insights.filter((i) => i.category === "cohort");

  return (
    <DemoShell>
      <div className="mb-32 flex items-start justify-between gap-16">
        <div>
          <h1 className="mb-4 text-h1 text-ink-900">Campaigns</h1>
          <p className="text-meta text-ink-500">
            Review agent-drafted proposals, start from a suggested campaign, or pick a proven
            pattern. Nothing is sent until you approve.
          </p>
        </div>
      </div>

      {/* AI-suggested campaigns (demo fixtures) */}
      <SuggestedCampaigns demoInsights={cohortInsights} />

      {/* Agent-drafted proposals */}
      <section aria-label="Campaigns waiting for review">
        <h2 className="mb-16 text-h2 text-ink-900">Waiting for your review</h2>
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
                revenueLabel={
                  c.status === "draft" || c.status === "completed" ? "pending" : "restored"
                }
              />
            ))}
          </PanelBody>
        </Panel>
      </section>

      {/* Template library */}
      <TemplateLibrary />
    </DemoShell>
  );
}
