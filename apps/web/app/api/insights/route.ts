// GET /api/insights
//
// Returns the current active, non-expired AI insights for the authenticated
// merchant. Backed by the deterministic insights engine (decision 36 —
// no LLM calls). Results are pre-computed by the /api/cron/insights job
// every 6 hours and stored in the insights table.
//
// Auth: lapsed_session cookie / App Bridge bearer token via getMerchantFromSession.

import { NextResponse } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { getActiveInsights } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json(
      { error: "Your session has expired. Please refresh and try again." },
      { status: 401 },
    );
  }

  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  try {
    const insights = await getActiveInsights(serviceClient, merchant.id);
    return NextResponse.json({ insights });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "insights_fetch_error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "Failed to load insights." }, { status: 500 });
  }
}
