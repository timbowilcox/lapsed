// Campaigns — approval surface + primary create CTA (Sprint 11, chunk 7).
//
// The agent drafts proposals from scored customer groups; the merchant
// can also build one manually via the wizard at /app/campaigns/new.
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
            Review proposals from the agent or build a campaign yourself. Nothing is sent until
            you approve.
          </p>
        </div>
        <Link
          href="/app/campaigns/new"
          className="inline-flex shrink-0 items-center gap-8 rounded-md bg-ink-900 px-16 py-10 text-label text-cream-50 transition-colors hover:bg-ink-700 focus-visible:outline-none focus-visible:shadow-focus"
        >
          Create campaign
        </Link>
      </div>

      {/* operatorId records who acted on the proposal; the merchant id is a
          non-PII internal identifier (shop domain would be PII in the event log). */}
      <ApprovalSurface operatorId={merchant.id} />
    </MerchantShell>
  );
}
