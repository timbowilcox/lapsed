// Per-campaign attribution view (Sprint 08, chunk 10). A read-only surface
// over the cron-materialised attribution_results row.
//
// Progressive disclosure (tenet 6): the page leads with ONE number —
// incremental revenue restored — as the hero. The attribution window, group
// sizes and LTV are a demoted second tier; the attributed-orders table is
// behind a disclosure. When a group is below 30 customers the result carries
// insufficient_evidence and the hero becomes an explicit "need 30+" state
// instead of a confidently-wrong interval. A negative incremental is shown
// plainly, never hidden (tenet 4 — honest numbers).
//
// Vocabulary: "group", never "cohort", in all merchant-facing copy.

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Panel,
  Card,
  HeroMetric,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Tag,
  formatCurrency,
  formatCount,
  formatDate,
} from "@lapsed/ui";
import {
  mintMerchantJwt,
  createMerchantClient,
  getCampaignAttribution,
  type AttributionResultRow,
  type AttributedOrderView,
} from "@lapsed/db";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../../../_components/merchant-shell";
import { groupLabel } from "../../_labels";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Short, stable display form of a Shopify gid (the trailing numeric id). */
function shortGid(gid: string): string {
  if (gid.length === 0) return "—";
  const tail = gid.split("/").pop();
  return tail && tail.length > 0 ? tail : gid;
}

export default async function CampaignAttributionPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return notFound();

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

  // A cross-merchant id resolves to null — answer 404 without leaking existence.
  const view = await getCampaignAttribution(client, merchant.id, id);
  if (!view) return notFound();

  const result = view.result;

  return (
    <MerchantShell pageTitle="Campaign attribution">
      <div className="mb-24">
        <Link
          href="/app/campaigns/list"
          className="text-meta text-ink-500 transition-colors hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-focus"
        >
          ← All campaigns
        </Link>
        <h1 className="mb-4 mt-8 text-h1 text-ink-900">
          {groupLabel(view.groupSlug)} — attribution
        </h1>
        <p className="text-meta text-ink-500">
          Revenue restored by this campaign, measured against its matched comparison group
          and reconciled against Shopify orders.
        </p>
      </div>

      {result === null ? (
        <Panel>
          <p className="px-16 py-40 text-center text-meta text-ink-500">
            Attribution will appear here once this campaign&rsquo;s {view.attributionWindowDays}-day
            attribution window closes and the nightly batch has run.
          </p>
        </Panel>
      ) : result.insufficient_evidence ? (
        <>
          <InsufficientEvidence
            treatment={result.treatment_cohort_size}
            holdout={result.holdout_cohort_size}
          />
          <ContextRow result={result} windowDays={view.attributionWindowDays} showLtv={false} />
        </>
      ) : (
        <>
          <HeroMetric
            label="Incremental revenue restored"
            value={formatCurrency(result.incremental_revenue_cents)}
            meta={<ConfidenceMeta
              lowCents={result.incremental_ci_low_cents}
              highCents={result.incremental_ci_high_cents}
              windowDays={view.attributionWindowDays}
            />}
            className="mb-16"
          />
          <ContextRow result={result} windowDays={view.attributionWindowDays} showLtv />
        </>
      )}

      {view.attributedOrders.length > 0 && (
        <details className="group mt-16">
          <summary className="cursor-pointer rounded-md border border-border bg-cream-50 px-20 py-16 text-label text-ink-700 transition-colors hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-focus">
            View {formatCount(view.attributedOrders.length)} attributed{" "}
            {view.attributedOrders.length === 1 ? "order" : "orders"}
          </summary>
          <AttributedOrdersTable orders={view.attributedOrders} />
        </details>
      )}
    </MerchantShell>
  );
}

/** The 95% confidence interval line shown under the hero figure. */
function ConfidenceMeta({
  lowCents,
  highCents,
  windowDays,
}: {
  lowCents: number | null;
  highCents: number | null;
  windowDays: number;
}) {
  return (
    <>
      {lowCents !== null && highCents !== null ? (
        <span className="tabular-nums">
          95% confidence: {formatCurrency(lowCents)} – {formatCurrency(highCents)}
        </span>
      ) : (
        <span>confidence interval unavailable</span>
      )}
      {" · "}
      {windowDays}-day attribution window
    </>
  );
}

/** The demoted second tier: window, group sizes, and (when shown) LTV. */
function ContextRow({
  result,
  windowDays,
  showLtv,
}: {
  result: AttributionResultRow;
  windowDays: number;
  showLtv: boolean;
}) {
  const total = result.treatment_cohort_size + result.holdout_cohort_size;
  const holdoutPct = total > 0 ? Math.round((result.holdout_cohort_size / total) * 100) : 0;

  return (
    <div className={`grid gap-12 ${showLtv ? "grid-cols-4" : "grid-cols-3"}`}>
      <Card className="p-20">
        <div className="text-label text-ink-500">Attribution window</div>
        <div className="mt-8 text-display text-ink-900 tabular-nums">{windowDays} days</div>
      </Card>
      <Card className="p-20">
        <div className="text-label text-ink-500">Treatment group</div>
        <div className="mt-8 text-display text-ink-900 tabular-nums">
          {formatCount(result.treatment_cohort_size)}
        </div>
        <div className="mt-4 text-mini text-ink-500">customers contacted</div>
      </Card>
      <Card className="p-20">
        <div className="text-label text-ink-500">Comparison group</div>
        <div className="mt-8 text-display text-ink-900 tabular-nums">
          {formatCount(result.holdout_cohort_size)}
        </div>
        <div className="mt-4 text-mini text-ink-500">
          comparison group · {holdoutPct}% of the campaign total
        </div>
      </Card>
      {showLtv && (
        <Card className="p-20">
          <div className="text-label text-ink-500">Value restored</div>
          <div className="mt-8 text-display text-ink-900 tabular-nums">
            {formatCurrency(result.ltv_restored_cents)}
          </div>
          {result.ltv_ci_low_cents !== null && result.ltv_ci_high_cents !== null && (
            <div className="mt-4 text-mini text-ink-500 tabular-nums">
              95% CI {formatCurrency(result.ltv_ci_low_cents)} –{" "}
              {formatCurrency(result.ltv_ci_high_cents)}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function AttributedOrdersTable({ orders }: { orders: AttributedOrderView[] }) {
  return (
    <Panel className="mt-12">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Driven by message</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Placed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((o) => (
            <TableRow key={o.decisionId}>
              <TableCell className="text-ink-900 tabular-nums">{shortGid(o.orderId)}</TableCell>
              <TableCell className="text-ink-500 tabular-nums">{shortGid(o.customerId)}</TableCell>
              <TableCell className="text-ink-500 tabular-nums">
                {shortGid(o.attributedMessageId ?? "")}
              </TableCell>
              <TableCell className="text-right text-ink-900 tabular-nums">
                {formatCurrency(o.totalPriceCents)}
              </TableCell>
              <TableCell className="text-ink-500">{formatDate(o.placedAt, "short")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

function InsufficientEvidence({ treatment, holdout }: { treatment: number; holdout: number }) {
  return (
    <Card className="mb-16 p-24">
      <Tag tone="stalled">Insufficient evidence</Tag>
      <p className="mt-12 text-meta text-ink-700">
        A defensible incremental figure needs at least 30 customers in each group. This campaign
        currently has {formatCount(treatment)} in the treatment group and {formatCount(holdout)} in
        the comparison group.
      </p>
      <p className="mt-8 text-mini text-ink-500">
        Raw revenue is recorded but no confidence interval is shown — a number from a group this
        small would be confidently wrong.
      </p>
    </Card>
  );
}
