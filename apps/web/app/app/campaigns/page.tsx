// Campaigns — approval surface (Sprint 11, chunk 7).
//
// The agent drafts proposals from scored customer groups; the merchant
// reviews and approves them here. Merchants can also create a campaign
// manually via the wizard (a secondary escape hatch, not the primary flow).
// Approved campaigns enter the sending pipeline (decision 13).

import Link from "next/link";
import { requireMerchant } from "@/app/lib/session";
import { MerchantShell } from "../_components/merchant-shell";
import { ApprovalSurface } from "./_approval-surface";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CampaignsPage({ searchParams }: PageProps) {
  const merchant = await requireMerchant({ searchParams: await searchParams });

  return (
    <MerchantShell pageTitle="Campaigns">
      <div className="mb-24 flex items-start justify-between gap-16">
        <div>
          <h1 className="mb-4 text-h1 text-ink-900">Campaigns</h1>
          <p className="text-meta text-ink-500">
            The agent drafts campaigns from your scored customer groups. Review each proposal
            below — nothing is sent until you approve.
          </p>
        </div>
        <Link
          href="/app/campaigns/new"
          className="inline-flex shrink-0 items-center gap-8 rounded-md border border-border bg-cream-50 px-16 py-10 text-label text-ink-900 transition-colors hover:bg-cream-100 focus-visible:outline-none focus-visible:shadow-focus"
        >
          Create manually
        </Link>
      </div>

      {/* operatorId records who acted on the proposal; the merchant id is a
          non-PII internal identifier (shop domain would be PII in the event log). */}
      <ApprovalSurface operatorId={merchant.id} />
    </MerchantShell>
  );
}
