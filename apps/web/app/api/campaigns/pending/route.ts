// GET /api/campaigns/pending — campaign proposals awaiting the merchant's
// decision. Powers the approval surface's "Pending review" list.
//
// Auth: App Bridge bearer token / lapsed_session cookie via
// getMerchantFromSession. The merchant id is resolved from the verified
// session — never taken from the request.

import { NextResponse } from "next/server";
import { createServiceClient, getPendingProposals } from "@lapsed/db";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const proposals = await getPendingProposals(client, merchant.id);
  return NextResponse.json({ proposals });
}
