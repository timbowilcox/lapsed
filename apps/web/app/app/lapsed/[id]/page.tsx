import { notFound } from "next/navigation";
import Link from "next/link";
import {
  Avatar,
  Badge,
  Card,
  Panel,
  PanelHeader,
  PanelBody,
  Button,
  Tag,
  formatCurrency,
  formatDate,
} from "@lapsed/ui";
import { lapsedCustomers, conversations } from "@lapsed/fixtures";
import { MerchantShell } from "../../_components/merchant-shell";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LapsedDetailPage({ params }: PageProps) {
  const { id } = await params;
  const customer = lapsedCustomers.find((c) => c.id === id);
  if (!customer) return notFound();

  const customerConversations = conversations.filter((c) => c.customerId === customer.id);

  return (
    <MerchantShell pageTitle={`${customer.firstName} ${customer.lastName}`}>
      <div className="mb-24 flex items-start justify-between gap-16">
        <div className="flex items-center gap-16">
          <Avatar initials={customer.initials} size="xl" />
          <div>
            <h2 className="text-h1 text-ink-900" data-testid="customer-name">
              {customer.firstName} {customer.lastName}
            </h2>
            <div className="mt-4 flex items-center gap-12 text-meta text-ink-500">
              <span>{customer.email}</span>
              <span aria-hidden="true">·</span>
              <span>{customer.phone}</span>
              <span aria-hidden="true">·</span>
              <span>
                {customer.city}, {customer.state}
              </span>
            </div>
          </div>
        </div>
        <div className="flex gap-8">
          <Button variant="secondary">Manually message</Button>
          <Button variant="primary">Add to campaign</Button>
        </div>
      </div>

      <div className="mb-16 grid grid-cols-4 gap-12">
        <Card className="p-20">
          <div className="text-label text-ink-500">Lifetime value</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {formatCurrency(Math.round(customer.lifetimeValue * 100))}
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Orders</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">{customer.orderCount}</div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Reactivation score</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {customer.reactivationScore.toFixed(2)}
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Cadence</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {customer.cadenceDays > 0 ? `${customer.cadenceDays} d` : "—"}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-[1.2fr_1fr] gap-16">
        <Panel>
          <PanelHeader title="Order history" />
          <PanelBody>
            <div className="flex flex-col">
              {customer.orderHistory.map((order, idx) => (
                <div
                  key={order.id}
                  className="grid grid-cols-[120px_1fr_120px] items-center gap-16 border-b border-border px-22 py-14 last:border-b-0"
                >
                  <div className="text-mini text-ink-500">
                    {formatDate(order.placedAt, "short")}
                  </div>
                  <div>
                    <div className="text-body-strong text-ink-900">{order.topProduct}</div>
                    <div className="text-mini text-ink-500">
                      {order.lineCount} item{order.lineCount === 1 ? "" : "s"} · order {idx + 1} of{" "}
                      {customer.orderHistory.length}
                    </div>
                  </div>
                  <div className="text-right text-body-strong tabular-nums text-ink-900">
                    {formatCurrency(Math.round(order.total * 100))}
                  </div>
                </div>
              ))}
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Conversation history"
            action={
              <Badge tone="neutral">
                {customerConversations.length} thread{customerConversations.length === 1 ? "" : "s"}
              </Badge>
            }
          />
          <PanelBody>
            {customerConversations.length === 0 ? (
              <div className="p-24 text-meta text-ink-500">
                No conversations yet. Add to a campaign to start a thread.
              </div>
            ) : (
              customerConversations.map((c) => (
                <Link key={c.id} href={`/app/conversations/${c.id}`} className="block">
                  <div className="border-b border-border px-22 py-14 transition-colors hover:bg-cream-100 last:border-b-0">
                    <div className="mb-4 flex items-baseline justify-between gap-12">
                      <span className="text-body-strong text-ink-900">{c.campaignName}</span>
                      <span className="text-mini text-ink-500">{c.time}</span>
                    </div>
                    <div className="mb-8 line-clamp-1 text-mini text-ink-500">{c.preview}</div>
                    <Tag tone={c.tagTone}>{c.tagLabel}</Tag>
                  </div>
                </Link>
              ))
            )}
          </PanelBody>
        </Panel>
      </div>
    </MerchantShell>
  );
}
