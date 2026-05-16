// Conversation detail (Sprint 07, chunk 11) — the full thread for one
// customer. Inbound messages left, outbound right; outbounds carry their
// source campaign + bandit arm, inbounds carry the classified sentiment +
// intent. Real data, replacing the Sprint 01 fixture surface.

import { notFound } from "next/navigation";
import {
  Avatar,
  Panel,
  PanelHeader,
  PanelBody,
  Tag,
  Badge,
  formatDateTime,
  formatRelativeTime,
} from "@lapsed/ui";
import {
  mintMerchantJwt,
  createMerchantClient,
  getConversationThread,
  type ThreadMessage,
} from "@lapsed/db";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../../_components/merchant-shell";
import { groupLabel } from "../../campaigns/_labels";
import { OptOutButton } from "./_opt-out-button";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Vellum Tag tone for a classified inbound sentiment. */
function sentimentTone(sentiment: string): "converted" | "stalled" | "churned" {
  if (sentiment === "positive") return "converted";
  if (sentiment === "negative") return "churned";
  return "stalled";
}

/** Badge tone + label for an outbound message status. */
function statusBadge(status: string): { tone: "live" | "info" | "error" | "draft"; label: string } {
  if (status === "delivered") return { tone: "live", label: "Delivered" };
  if (status === "failed") return { tone: "error", label: "Failed" };
  if (status === "pending") return { tone: "draft", label: "Pending" };
  return { tone: "info", label: "Sent" };
}

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Two-letter initials from a display name. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Builds the Shopify admin customer URL from a customer gid, or null. */
function shopifyCustomerUrl(shopDomain: string, customerGid: string): string | null {
  const numeric = customerGid.split("/").pop();
  if (!numeric || !/^\d+$/.test(numeric)) return null;
  return `https://${shopDomain}/admin/customers/${numeric}`;
}

export default async function ConversationDetailPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const merchant = await requireMerchant({ searchParams: await searchParams });

  const env = serverEnv();
  const jwt = await mintMerchantJwt({
    shopDomain: merchant.shopDomain,
    jwtSecret: env.supabaseJwtSecret,
  });
  const client = createMerchantClient({
    url: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    merchantJwt: jwt,
  });

  const thread = await getConversationThread(client, merchant.id, id);
  if (!thread) return notFound();

  const shopifyUrl = shopifyCustomerUrl(merchant.shopDomain, thread.customerId);

  return (
    <MerchantShell pageTitle={`Conversation with ${thread.customerName}`}>
      <div className="grid grid-cols-[1fr_320px] gap-16">
        <Panel>
          <PanelHeader
            title={
              <span className="flex items-center gap-12">
                <Avatar initials={initialsOf(thread.customerName)} size="md" />
                <span>{thread.customerName}</span>
                {thread.optedOut && <Tag tone="churned">Opted out</Tag>}
              </span>
            }
          />
          <PanelBody>
            {thread.messages.length === 0 ? (
              <div className="px-24 py-48 text-center text-meta text-ink-500">
                No messages on this thread yet.
              </div>
            ) : (
              <ol className="flex list-none flex-col gap-16 p-24">
                {thread.messages.map((m) => (
                  <MessageBubble key={m.id} message={m} customerName={thread.customerName} />
                ))}
              </ol>
            )}
          </PanelBody>
        </Panel>

        <div className="flex flex-col gap-16">
          <Panel>
            <PanelHeader title="Customer" />
            <PanelBody>
              <dl className="flex flex-col gap-12 p-24">
                <div>
                  <dt className="text-label text-ink-500">Lifecycle stage</dt>
                  <dd className="mt-2 text-body text-ink-900">
                    {thread.lifecycleStage ? humanize(thread.lifecycleStage) : "Unknown"}
                  </dd>
                </div>
                <div>
                  <dt className="text-label text-ink-500">Last order</dt>
                  <dd className="mt-2 text-body text-ink-900">
                    {thread.lastOrderAt ? formatRelativeTime(thread.lastOrderAt) : "No orders"}
                  </dd>
                </div>
                <div>
                  <dt className="text-label text-ink-500">Repurchase propensity</dt>
                  <dd className="mt-2 text-body text-ink-900 tabular-nums">
                    {thread.propensity !== null
                      ? `${Math.round(thread.propensity * 100)}%`
                      : "Unscored"}
                  </dd>
                </div>
                <div>
                  <dt className="text-label text-ink-500">Opt-out status</dt>
                  <dd className="mt-2 text-body text-ink-900">
                    {thread.optedOut ? "Opted out" : "Subscribed"}
                  </dd>
                </div>
              </dl>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Actions" />
            <PanelBody>
              <div className="flex flex-col items-start gap-12 p-24">
                {thread.optedOut ? (
                  <p className="text-mini text-ink-500">
                    This customer has opted out — no further messages will be sent.
                  </p>
                ) : (
                  <OptOutButton conversationId={thread.conversationId} />
                )}
                {shopifyUrl && (
                  <a
                    href={shopifyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-meta font-medium text-lavender-700 hover:text-ink-900"
                  >
                    Open in Shopify <span aria-hidden="true">→</span>
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                )}
              </div>
            </PanelBody>
          </Panel>
        </div>
      </div>
    </MerchantShell>
  );
}

function MessageBubble({
  message,
  customerName,
}: {
  message: ThreadMessage;
  customerName: string;
}) {
  const isInbound = message.direction === "inbound";
  const badge = statusBadge(message.status);

  return (
    <li className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] rounded-md px-16 py-10 ${
          isInbound ? "bg-cream-200 text-ink-900" : "bg-lavender-400 text-ink-900"
        }`}
      >
        <div className="mb-4 text-[11px] uppercase tracking-wide text-ink-700">
          {isInbound ? customerName : "lapsed.ai"}
        </div>
        <div className="text-body">{message.body}</div>

        {isInbound && (message.sentiment || message.intent) && (
          <div className="mt-8 flex flex-wrap gap-4">
            {message.sentiment && (
              <Tag tone={sentimentTone(message.sentiment)}>
                {message.sentiment.charAt(0).toUpperCase() + message.sentiment.slice(1)}
              </Tag>
            )}
            {message.intent && <Tag tone="stalled">{humanize(message.intent)}</Tag>}
          </div>
        )}

        {!isInbound && (
          <div className="mt-8 flex flex-wrap items-center gap-6">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {message.campaignSlug && (
              <span className="text-[11px] text-ink-700">
                {groupLabel(message.campaignSlug)}
              </span>
            )}
            {message.armLabel && (
              <span className="text-[11px] text-ink-700">· {message.armLabel}</span>
            )}
          </div>
        )}

        <div className="mt-6 text-[11px] text-ink-700">
          {formatDateTime(message.sentAt)}
        </div>
      </div>
    </li>
  );
}
