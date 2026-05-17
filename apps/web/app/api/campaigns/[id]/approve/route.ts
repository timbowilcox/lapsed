// POST /api/campaigns/[id]/approve — approves a campaign proposal.
//
// Body: { userId }. Records a campaign_approved event and initializes the
// Beta(1,1) bandit posteriors (decision 14). There is NO auto-approval — a
// campaign only becomes ready via this explicit, merchant-initiated call
// (decision 13).
//
// Auth: getMerchantFromSession. The merchant boundary is the verified
// session; `userId` is an in-merchant audit label carried on the event.
// A cross-merchant proposal id returns 404.

import { NextResponse } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { approveProposal, checkCampaignApprovalAllowed } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { campaignErrorResponse, isUuid } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: { userId?: unknown };
  try {
    body = (await request.json()) as { userId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof body.userId !== "string" || body.userId.length === 0) {
    return NextResponse.json({ error: "missing_user_id" }, { status: 400 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Billing gate (decisions 30/31): a suspended / no-plan merchant cannot
  // approve a campaign, and an active merchant cannot exceed their tier's
  // monthly campaign allowance.
  const gate = await checkCampaignApprovalAllowed(client, merchant.id);
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "billing_gate", reason: gate.reason },
      { status: 403 },
    );
  }

  try {
    const result = await approveProposal(client, merchant.id, id, body.userId);
    return NextResponse.json(result);
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
