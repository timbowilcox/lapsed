import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Avatar,
  Card,
  Panel,
  PanelHeader,
  PanelBody,
  Tag,
  Badge,
  formatCurrency,
  formatDateTime,
} from "@lapsed/ui";
import { conversations, lapsedCustomers, campaigns } from "@lapsed/fixtures";
import { MerchantShell } from "../../_components/merchant-shell";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ConversationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const conversation = conversations.find((c) => c.id === id);
  if (!conversation) return notFound();

  const customer = lapsedCustomers.find((c) => c.id === conversation.customerId);
  const campaign = campaigns.find((c) => c.id === conversation.campaignId);

  return (
    <MerchantShell pageTitle={`Conversation with ${conversation.customerName}`}>
      <div className="grid grid-cols-[1fr_320px] gap-16">
        <Panel>
          <PanelHeader
            title={
              <span className="flex items-center gap-12">
                <Avatar initials={conversation.initials} size="md" />
                <span>{conversation.customerName}</span>
                <Tag tone={conversation.tagTone}>{conversation.tagLabel}</Tag>
              </span>
            }
          />
          <PanelBody>
            <div className="flex flex-col gap-12 p-24">
              {conversation.messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.role === "customer" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-md px-16 py-10 ${
                      m.role === "customer"
                        ? "bg-cream-200 text-ink-900"
                        : m.role === "ai"
                          ? "bg-lavender-400 text-ink-900"
                          : "bg-ink-900 text-cream-50"
                    }`}
                  >
                    <div className="mb-4 text-[11px] uppercase tracking-wide text-ink-700 opacity-70">
                      {m.role === "customer"
                        ? conversation.customerName
                        : m.role === "ai"
                          ? "lapsed.ai"
                          : "Merchant"}
                    </div>
                    <div className="text-body">{m.body}</div>
                    <div className="mt-6 text-[11px] text-ink-700 opacity-60">
                      {formatDateTime(m.sentAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </PanelBody>
        </Panel>

        <div className="flex flex-col gap-16">
          <Panel>
            <PanelHeader title="Customer" />
            <PanelBody>
              <div className="flex flex-col gap-12 p-24">
                <div>
                  <div className="text-label text-ink-500">Phone</div>
                  <div className="mt-2 text-body text-ink-900">{conversation.customerPhone}</div>
                </div>
                {customer && (
                  <>
                    <div>
                      <div className="text-label text-ink-500">Lifetime value</div>
                      <div className="mt-2 text-body text-ink-900 tabular-nums">
                        {formatCurrency(Math.round(customer.lifetimeValue * 100))}
                      </div>
                    </div>
                    <div>
                      <div className="text-label text-ink-500">Orders</div>
                      <div className="mt-2 text-body text-ink-900 tabular-nums">
                        {customer.orderCount}
                      </div>
                    </div>
                    <div>
                      <div className="text-label text-ink-500">Last order</div>
                      <div className="mt-2 text-body text-ink-900">
                        {customer.lastOrderDaysAgo} days ago
                      </div>
                    </div>
                    <Link
                      href={`/app/lapsed/${customer.id}`}
                      className="text-meta font-medium text-lavender-700 hover:text-ink-900"
                    >
                      View profile →
                    </Link>
                  </>
                )}
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Attribution" />
            <PanelBody>
              <div className="flex flex-col gap-12 p-24">
                {campaign && (
                  <Link
                    href="/app/campaigns"
                    className="text-meta font-medium text-lavender-700 hover:text-ink-900"
                  >
                    {campaign.name}
                  </Link>
                )}
                <Card className="p-16">
                  <div className="text-label text-ink-500">Restored revenue</div>
                  <div className="mt-4 text-display text-ink-900 tabular-nums">
                    {conversation.attributedRevenue !== null
                      ? formatCurrency(conversation.attributedRevenue * 100)
                      : "—"}
                  </div>
                  <div className="mt-2 text-mini text-ink-500">
                    {conversation.attributedOrderId
                      ? `Order ${conversation.attributedOrderId}`
                      : "No order attributed yet"}
                  </div>
                </Card>
                <div className="flex items-center gap-8 text-meta text-ink-500">
                  <Badge tone={conversation.attributedRevenue ? "live" : "neutral"}>
                    {conversation.attributedRevenue ? "Reconciled" : "Pending"}
                  </Badge>
                  <span>vs Shopify orders</span>
                </div>
              </div>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </MerchantShell>
  );
}
