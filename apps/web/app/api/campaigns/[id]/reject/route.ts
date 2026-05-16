// POST /api/campaigns/[id]/reject — rejects a campaign proposal.
//
// Body: { userId, reason }. Records a campaign_rejected event carrying the
// merchant-supplied reason.
//
// Auth: getMerchantFromSession. A cross-merchant proposal id returns 404.

import { NextResponse } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { rejectProposal } from "@lapsed/core";
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

  let body: { userId?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as { userId?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof body.userId !== "string" || body.userId.length === 0) {
    return NextResponse.json({ error: "missing_user_id" }, { status: 400 });
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return NextResponse.json({ error: "missing_reason" }, { status: 400 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  try {
    const result = await rejectProposal(client, merchant.id, id, body.userId, body.reason);
    return NextResponse.json(result);
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
