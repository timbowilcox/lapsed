// Campaigns — Sprint 11, chunk 9.
//
// Three sections:
//   1. Suggested campaigns (chunk 9) — AI-derived from cohort insights engine
//   2. Pending approval (chunk 7) — agent-drafted proposals awaiting merchant review
//   3. Template library (chunk 9) — proven campaign patterns as a starting point

import Link from "next/link";
import { requireMerchant } from "@/app/lib/session";
import { MerchantShell } from "../_components/merchant-shell";
import { ApprovalSurface } from "./_approval-surface";
import { SuggestedCampaigns } from "./_suggested-campaigns";
import { TemplateLibrary } from "./_template-library";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CampaignsPage({ searchParams }: PageProps) {
  const merchant = await requireMerchant({ searchParams: await searchParams });

  return (
    <MerchantShell pageTitle="Campaigns">
      {/* Page header */}
      <div className="mb-32 flex items-start justify-between gap-16">
        <div>
          <h1 className="mb-4 text-h1 text-ink-900">Campaigns</h1>
          <p className="text-meta text-ink-500">
            Review agent-drafted proposals, start from a suggested campaign, or pick a proven
            pattern. Nothing is sent until you approve.
          </p>
        </div>
        <Link
          href="/app/campaigns/new"
          className="inline-flex shrink-0 items-center gap-8 rounded-md border border-border bg-cream-50 px-16 py-10 text-label text-ink-900 transition-colors hover:bg-cream-100 focus-visible:outline-none focus-visible:shadow-focus"
        >
          Create manually
        </Link>
      </div>

      {/* 1. AI-suggested campaigns (cohort insights) */}
      <SuggestedCampaigns />

      {/* 2. Agent-drafted proposals awaiting approval */}
      <section aria-label="Campaigns waiting for review">
        <h2 className="mb-16 text-h2 text-ink-900">Waiting for your review</h2>
        {/* operatorId records who acted on the proposal; the merchant id is a
            non-PII internal identifier (shop domain would be PII in the event log). */}
        <ApprovalSurface operatorId={merchant.id} />
      </section>

      {/* 3. Template library */}
      <TemplateLibrary />
    </MerchantShell>
  );
}
