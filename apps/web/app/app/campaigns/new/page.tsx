import { requireMerchant } from "@/app/lib/session";
import { createServiceClient, getCustomerGroupSizes } from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../../_components/merchant-shell";
import { CampaignWizard } from "./_campaign-wizard";
import { GROUP_SLUGS, groupLabel } from "../../../api/campaigns/_group-labels";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NewCampaignPage({ searchParams }: PageProps) {
  const merchant = await requireMerchant({ searchParams: await searchParams });

  const env = serverEnv();
  const client = createServiceClient({ url: env.supabaseUrl, serviceKey: env.supabaseSecretKey });

  let groups: Array<{ slug: string; label: string; customerCount: number; lastCampaignedAt: string | null }> = [];
  try {
    const sizes = await getCustomerGroupSizes(client, merchant.id, GROUP_SLUGS);
    groups = sizes.map((g) => ({
      slug: g.slug,
      label: groupLabel(g.slug),
      customerCount: g.customerCount,
      lastCampaignedAt: g.lastCampaignedAt,
    }));
  } catch {
    // Fall through with empty groups — wizard shows an inline error state.
  }

  return (
    <MerchantShell pageTitle="New campaign">
      <CampaignWizard groups={groups} />
    </MerchantShell>
  );
}
