import { notFound } from "next/navigation";
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
  formatRelativeTime,
} from "@lapsed/ui";
import {
  mintMerchantJwt,
  createMerchantClient,
  getCustomer,
  getCustomerOrders,
  getCustomerInferredState,
  type Database,
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

type LifecycleStage = Database["public"]["Enums"]["lifecycle_stage"];
type BadgeTone = "neutral" | "live" | "draft" | "paused" | "error" | "info";

function lifecycleBadgeTone(stage: LifecycleStage | null): BadgeTone {
  switch (stage) {
    case "new": return "info";
    case "engaged": return "live";
    case "at_risk": return "paused";
    case "lapsed": return "info";
    case "won_back": return "live";
    case "churned": return "error";
    default: return "info";
  }
}

function lifecycleLabel(stage: LifecycleStage | null): string {
  switch (stage) {
    case "new": return "New";
    case "engaged": return "Engaged";
    case "at_risk": return "At Risk";
    case "lapsed": return "Lapsed";
    case "won_back": return "Won Back";
    case "churned": return "Churned";
    default: return "Unknown";
  }
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
  const [customer, orders, inferredState] = await Promise.all([
    getCustomer(merchantClient, merchant.id, gid),
    getCustomerOrders(merchantClient, merchant.id, gid),
    getCustomerInferredState(merchantClient, merchant.id, gid),
  ]);

  if (!customer) return notFound();

  const fullName =
    [customer.first_name, customer.last_name].filter(Boolean).join(" ") ||
    customer.email ||
    "Unknown";
  const initials = getInitials(customer.first_name, customer.last_name, customer.email);
  const isScored = inferredState?.last_scored_at != null;

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

      <Panel className="mb-16">
        <PanelHeader
          title="Signals"
          action={
            inferredState?.lifecycle_stage ? (
              <Badge tone={lifecycleBadgeTone(inferredState.lifecycle_stage)}>
                {lifecycleLabel(inferredState.lifecycle_stage)}
              </Badge>
            ) : null
          }
        />
        <PanelBody>
          {!isScored ? (
            <div className="p-24 text-meta text-ink-500">
              Not scored yet — check back after tomorrow&rsquo;s run.
            </div>
          ) : (
            <>
              {inferredState?.top_signal && (
                <div className="border-b border-border px-24 py-14 text-meta text-ink-700">
                  {inferredState.top_signal}
                </div>
              )}
              <div className="grid grid-cols-3 divide-x divide-border">
                <div className="px-24 py-20">
                  <div className="mb-12 text-label text-ink-500">Return probability</div>
                  <div className="flex flex-col gap-10">
                    {(
                      [
                        { label: "30 d", ariaLabel: "30 days", value: inferredState?.propensity_30d },
                        { label: "60 d", ariaLabel: "60 days", value: inferredState?.propensity_60d },
                        { label: "90 d", ariaLabel: "90 days", value: inferredState?.propensity_90d },
                      ] as const
                    ).map(({ label, ariaLabel, value }) => {
                      const pct = value != null ? Math.round(value * 100) : null;
                      return (
                        <div key={label} className="flex items-center gap-10">
                          <div className="w-28 flex-shrink-0 text-mini text-ink-500">{label}</div>
                          <div
                            className="relative h-8 flex-1 overflow-hidden rounded-pill bg-cream-200"
                            role="progressbar"
                            aria-valuenow={pct ?? 0}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={
                              pct != null
                                ? `approximately ${pct}% estimated probability of returning within ${ariaLabel}`
                                : `Return probability within ${ariaLabel}: not yet available`
                            }
                          >
                            {pct != null && (
                              <div
                                className="h-full rounded-pill bg-lavender-400 transition-all"
                                style={{ width: `${pct}%` }}
                              />
                            )}
                          </div>
                          <div className="w-28 flex-shrink-0 text-right text-mini tabular-nums text-ink-500">
                            {pct != null ? `~${pct}%` : "—"}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="px-24 py-20">
                  <div className="mb-12 text-label text-ink-500">Est. residual value</div>
                  <div className="text-h1 tabular-nums text-ink-900">
                    {inferredState?.predicted_residual_ltv_cents != null
                      ? formatCurrency(parseInt(inferredState.predicted_residual_ltv_cents, 10))
                      : "—"}
                  </div>
                  <div className="mt-4 text-micro text-ink-300">model estimate</div>
                </div>

                <div className="px-24 py-20">
                  <div className="mb-12 text-label text-ink-500">Groups</div>
                  {inferredState?.group_memberships && inferredState.group_memberships.length > 0 ? (
                    <div className="flex flex-wrap gap-6">
                      {inferredState.group_memberships.map((group) => (
                        <Tag key={group} tone="active">
                          {group}
                        </Tag>
                      ))}
                    </div>
                  ) : (
                    <div className="text-mini text-ink-500">No groups assigned</div>
                  )}
                  {inferredState?.last_scored_at && (
                    <div className="mt-12 text-micro text-ink-300">
                      Scored {formatRelativeTime(inferredState.last_scored_at)}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </PanelBody>
      </Panel>

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
