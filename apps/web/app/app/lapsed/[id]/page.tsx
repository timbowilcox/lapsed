import { notFound } from "next/navigation";
import {
  Avatar,
  Badge,
  Card,
  Panel,
  PanelHeader,
  PanelBody,
  Button,
  formatCurrency,
  formatDate,
} from "@lapsed/ui";
import {
  mintMerchantJwt,
  createMerchantClient,
  getCustomer,
  getCustomerOrders,
} from "@lapsed/db";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../../_components/merchant-shell";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function getInitials(firstName: string | null, lastName: string | null, email: string | null): string {
  if (firstName && lastName) return (firstName[0]! + lastName[0]!).toUpperCase();
  if (firstName) return firstName.slice(0, 2).toUpperCase();
  if (email) return email[0]!.toUpperCase();
  return "?";
}

export default async function LapsedDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;

  // Reject non-numeric IDs before building the GID
  if (!/^\d+$/.test(id)) return notFound();

  const merchant = await requireMerchant({ searchParams: await searchParams });
  const env = serverEnv();

  const jwt = await mintMerchantJwt({
    shopDomain: merchant.shopDomain,
    jwtSecret: env.supabaseJwtSecret,
  });
  const merchantClient = createMerchantClient({
    url: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    merchantJwt: jwt,
  });

  const gid = `gid://shopify/Customer/${id}`;
  const [customer, orders] = await Promise.all([
    getCustomer(merchantClient, merchant.id, gid),
    getCustomerOrders(merchantClient, merchant.id, gid),
  ]);

  if (!customer) return notFound();

  const fullName =
    [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
    customer.email ||
    "Unknown";
  const initials = getInitials(customer.first_name, customer.last_name, customer.email);

  return (
    <MerchantShell pageTitle={fullName}>
      <div className="mb-24 flex items-start justify-between gap-16">
        <div className="flex items-center gap-16">
          <Avatar initials={initials} size="xl" />
          <div>
            <h2 className="text-h1 text-ink-900" data-testid="customer-name">
              {fullName}
            </h2>
            <div className="mt-4 flex items-center gap-12 text-meta text-ink-500">
              {customer.email && <span>{customer.email}</span>}
              {customer.email && customer.phone && <span aria-hidden="true">·</span>}
              {customer.phone && <span>{customer.phone}</span>}
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
            {formatCurrency(customer.total_ltv_cents)}
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Orders</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {customer.total_order_count}
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Reactivation score</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {customer.lapsed_score != null ? customer.lapsed_score.toFixed(2) : "—"}
          </div>
        </Card>
        <Card className="p-20">
          <div className="text-label text-ink-500">Cadence</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">—</div>
        </Card>
      </div>

      <div className="grid grid-cols-[1.2fr_1fr] gap-16">
        <Panel>
          <PanelHeader title="Order history" />
          <PanelBody>
            {orders.length === 0 ? (
              <div className="p-24 text-meta text-ink-500">No orders synced yet.</div>
            ) : (
              <div className="flex flex-col">
                {orders.map((order, idx) => (
                  <div
                    key={order.id}
                    className="grid grid-cols-[120px_1fr_120px] items-center gap-16 border-b border-border px-22 py-14 last:border-b-0"
                  >
                    <div className="text-mini text-ink-500">
                      {order.shopify_created_at
                        ? formatDate(order.shopify_created_at, "short")
                        : "—"}
                    </div>
                    <div>
                      <div className="text-body-strong text-ink-900">
                        #{order.shopify_order_gid.split("/").pop() ?? order.shopify_order_gid}
                      </div>
                      <div className="text-mini text-ink-500">
                        order {idx + 1} of {orders.length}
                      </div>
                    </div>
                    <div className="text-right text-body-strong tabular-nums text-ink-900">
                      {formatCurrency(order.total_price_cents)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Conversation history"
            action={<Badge tone="neutral">0 threads</Badge>}
          />
          <PanelBody>
            <div className="p-24 text-meta text-ink-500">
              No conversations yet. Add to a campaign to start a thread.
            </div>
          </PanelBody>
        </Panel>
      </div>
    </MerchantShell>
  );
}
