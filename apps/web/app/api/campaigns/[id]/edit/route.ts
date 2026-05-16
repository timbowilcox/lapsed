// POST /api/campaigns/[id]/edit — edits a campaign proposal.
//
// Body: { userId, edits }. Per decision 14 an edit creates a NEW proposal
// version with new arms; the prior version is retained and marked edited.
// Returns { editedProposalId, newProposalId, newVersionNumber, fieldsChanged }.
//
// Auth: getMerchantFromSession. A cross-merchant proposal id returns 404.

import { NextResponse } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { editProposal, type VariantEdit } from "@lapsed/core";
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

  let body: { userId?: unknown; edits?: unknown };
  try {
    body = (await request.json()) as { userId?: unknown; edits?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof body.userId !== "string" || body.userId.length === 0) {
    return NextResponse.json({ error: "missing_user_id" }, { status: 400 });
  }
  if (!Array.isArray(body.edits)) {
    return NextResponse.json({ error: "missing_edits" }, { status: 400 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  try {
    // editProposal Zod-validates every edit; a malformed entry surfaces as a
    // 400 via campaignErrorResponse.
    const result = await editProposal(
      client,
      merchant.id,
      id,
      body.userId,
      body.edits as VariantEdit[],
    );
    return NextResponse.json(result);
  } catch (err) {
    return campaignErrorResponse(err);
  }
}
