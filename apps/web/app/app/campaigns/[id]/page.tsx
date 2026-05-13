import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Card,
  Panel,
  PanelHeader,
  PanelBody,
  StatusDot,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  ConversationRow,
} from "@lapsed/ui";
import { campaigns, conversations } from "@lapsed/fixtures";
import { MerchantShell } from "../../_components/merchant-shell";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CampaignDetailPage({ params }: PageProps) {
  const { id } = await params;
  const campaign = campaigns.find((c) => c.id === id);
  if (!campaign) return notFound();

  const threadList = conversations.filter((c) => c.campaignId === campaign.id);

  return (
    <MerchantShell pageTitle={campaign.name}>
      <div className="mb-24 flex items-start justify-between gap-16">
        <div>
          <h2 className="mb-4 text-h1 text-ink-900" data-testid="campaign-name">
            {campaign.name}
          </h2>
          <div className="flex items-center gap-12">
            <StatusDot status={campaign.status} label={campaign.statusLabel} />
            <span className="text-mini text-ink-500">{campaign.cohortLabel}</span>
          </div>
        </div>
      </div>

      <div className="mb-16 grid grid-cols-4 gap-12">
        <Card className="p-20">
          <div className="text-label text-ink-500">Audience</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {campaign.audienceSize.toLocaleString()}
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Sent messages</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {campaign.sentMessages.toLocaleString()}
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Response rate</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {(campaign.responseRate * 100).toFixed(1)}%
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Recovered revenue</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {campaign.recoveredRevenueDisplay}
          </div>
          <div className="mt-2 text-mini text-ink-500">
            {campaign.recoveredOrders} orders
          </div>
        </Card>
      </div>

      <Tabs defaultValue="performance">
        <TabsList>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="audience">Audience</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="performance">
          <div className="grid grid-cols-2 gap-16">
            <Panel>
              <PanelHeader title="Offer" />
              <PanelBody>
                <div className="flex flex-col gap-12 p-22">
                  <div>
                    <div className="text-label text-ink-500">Description</div>
                    <div className="mt-4 text-body text-ink-900">
                      {campaign.offerDescription}
                    </div>
                  </div>
                  <div>
                    <div className="text-label text-ink-500">Discount code</div>
                    <code className="mt-4 inline-block rounded-sm bg-cream-200 px-8 py-4 text-meta text-ink-900">
                      {campaign.offerCode}
                    </code>
                  </div>
                </div>
              </PanelBody>
            </Panel>
            <Panel>
              <PanelHeader title="Conversion" />
              <PanelBody>
                <div className="grid grid-cols-2 gap-12 p-22">
                  <Card className="p-16">
                    <div className="text-label text-ink-500">Conversion rate</div>
                    <div className="mt-4 text-h1 text-ink-900 tabular-nums">
                      {(campaign.conversionRate * 100).toFixed(1)}%
                    </div>
                  </Card>
                  <Card className="p-16">
                    <div className="text-label text-ink-500">Recovered orders</div>
                    <div className="mt-4 text-h1 text-ink-900 tabular-nums">
                      {campaign.recoveredOrders}
                    </div>
                  </Card>
                </div>
              </PanelBody>
            </Panel>
          </div>
        </TabsContent>

        <TabsContent value="conversations">
          <Panel>
            <PanelHeader title="Conversation feed" />
            <PanelBody>
              {threadList.length === 0 ? (
                <div className="p-22 text-meta text-ink-500">
                  No conversations yet for this campaign.
                </div>
              ) : (
                threadList.map((c) => (
                  <Link key={c.id} href={`/app/conversations/${c.id}`} className="block">
                    <ConversationRow
                      initials={c.initials}
                      name={c.customerName}
                      time={c.time}
                      preview={c.preview}
                      tagTone={c.tagTone}
                      tagLabel={c.tagLabel}
                    />
                  </Link>
                ))
              )}
            </PanelBody>
          </Panel>
        </TabsContent>

        <TabsContent value="audience">
          <Panel>
            <PanelHeader title="Audience breakdown" />
            <PanelBody>
              <div className="flex flex-col">
                {campaign.audienceBreakdown.map((b) => (
                  <div
                    key={b.label}
                    className="flex items-center justify-between border-b border-border px-22 py-14 last:border-b-0"
                  >
                    <span className="text-body text-ink-900">{b.label}</span>
                    <span className="text-body-strong tabular-nums">
                      {b.count.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </PanelBody>
          </Panel>
        </TabsContent>

        <TabsContent value="timeline">
          <Panel>
            <PanelHeader title="Timeline" />
            <PanelBody>
              <ol className="flex flex-col">
                {campaign.timeline.map((event, idx) => (
                  <li
                    key={`${campaign.id}-tl-${idx}`}
                    className="flex items-start gap-12 border-b border-border px-22 py-14 last:border-b-0"
                  >
                    <div className="mt-6 h-7 w-7 flex-shrink-0 rounded-pill bg-lavender-400" />
                    <div className="flex-1">
                      <div className="text-body text-ink-900">{event.label}</div>
                      <div className="mt-2 text-mini text-ink-500">
                        {new Date(event.at).toLocaleString("en-AU", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </PanelBody>
          </Panel>
        </TabsContent>
      </Tabs>
    </MerchantShell>
  );
}
