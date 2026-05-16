// Campaign review — the approval surface (Sprint 06, chunk 9).
//
// Replaces the Sprint 01 fixture-backed campaigns table. The agent has
// prepared campaign proposals from the merchant's scored customer groups;
// this surface lets the merchant review each one and approve, edit, or
// reject it. Approved campaigns are what Sprint 07's conversation engine
// will run.

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
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">Campaign review</h2>
        <p className="text-meta text-ink-500">
          The agent drafts a campaign for each scored customer group. Review the proposals below
          and approve, edit, or reject them. Nothing is sent until you approve.
        </p>
      </div>

      {/* operatorId records who acted on the proposal; the merchant id is a
          non-PII internal identifier (shop domain would be PII in the event log). */}
      <ApprovalSurface operatorId={merchant.id} />
    </MerchantShell>
  );
}
