// GET /api/campaigns/groups
//
// Returns the list of customer groups with current size and last-campaigned
// date for each. Used by the campaign creation wizard's group picker.
//
// Auth: lapsed_session cookie / App Bridge bearer token via getMerchantFromSession.

import { NextResponse } from "next/server";
import { createServiceClient, getCustomerGroupSizes } from "@lapsed/db";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { GROUP_SLUGS, groupLabel } from "../_group-labels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant)
    return NextResponse.json(
      { error: "Your session has expired. Please refresh and try again." },
      { status: 401 },
    );

  const env = serverEnv();
  const client = createServiceClient({ url: env.supabaseUrl, serviceKey: env.supabaseSecretKey });

  try {
    const sizes = await getCustomerGroupSizes(client, merchant.id, GROUP_SLUGS);
    return NextResponse.json({
      groups: sizes.map((g) => ({
        slug: g.slug,
        label: groupLabel(g.slug),
        customerCount: g.customerCount,
        lastCampaignedAt: g.lastCampaignedAt,
      })),
    });
  } catch {
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
