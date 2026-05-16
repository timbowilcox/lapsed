// GET /api/campaigns/[id] — full detail of one campaign proposal: row,
// variants, bandit state, and snapshot/holdout counts.
//
// A proposal that does not exist OR belongs to another merchant returns 404
// (never 403) so the API never leaks the existence of another merchant's
// proposal. Auth: getMerchantFromSession; merchant id from the verified
// session only.

import { NextResponse } from "next/server";
import { createServiceClient, getProposalById } from "@lapsed/db";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { isUuid } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  // A malformed id is answered 404 — same as a real cross-merchant miss, so
  // the response shape never distinguishes the two.
  if (!isUuid(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const detail = await getProposalById(client, merchant.id, id);
  if (!detail) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(detail);
}
