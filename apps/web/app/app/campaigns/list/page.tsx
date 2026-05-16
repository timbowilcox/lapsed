// Campaign list (Sprint 06, chunk 10) — the day-to-day surface after Sprint 06
// ships and before Sprint 07's conversation engine starts running campaigns.
// Every campaign the agent has prepared, across four tabs (Pending review /
// Approved / Rejected / All), searchable by group name.

import { mintMerchantJwt, createMerchantClient, getProposalsByStatus } from "@lapsed/db";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../../_components/merchant-shell";
import { CampaignList } from "./_campaign-list";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CampaignListPage({ searchParams }: PageProps) {
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

  // Fetch the full set once; the client component handles tab + search
  // filtering. Sprint 06's per-merchant daily cap keeps this set small.
  const items = await getProposalsByStatus(client, merchant.id, "all");

  return (
    <MerchantShell pageTitle="Campaigns">
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">All campaigns</h2>
        <p className="text-meta text-ink-500">
          Every campaign the agent has prepared from your customer groups — pending review,
          approved, and rejected.
        </p>
      </div>

      <CampaignList items={items} />
    </MerchantShell>
  );
}
