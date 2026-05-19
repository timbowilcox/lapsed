// POST /api/insights/[id]/dismiss
// POST /api/insights/[id]/act
// POST /api/insights/[id]/snooze
//
// State-transition routes for AI insights (decision 36). Each writes a new
// append-only row with the requested state — the original row is never mutated.
// The DISTINCT ON resolution in getActiveInsights picks the latest row per key,
// so the dismissed/acted/snoozed row becomes the effective current state.
//
// URL: /api/insights/[id]?action=dismiss|act|snooze
//
// Returns: 204 No Content on success.
// Errors:  400 invalid action
//          401 not authenticated
//          404 insight not found / wrong merchant
//          500 unexpected failure
//
// Auth: lapsed_session cookie / App Bridge bearer token via getMerchantFromSession.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { markDismissed, markActed, markSnoozed, InsightNotFoundError } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_ACTIONS = ["dismiss", "act", "snooze"] as const;
type InsightAction = (typeof VALID_ACTIONS)[number];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json(
      { error: "Your session has expired. Please refresh and try again." },
      { status: 401 },
    );
  }

  const { id } = await params;
  const action = request.nextUrl.searchParams.get("action");

  if (!VALID_ACTIONS.includes(action as InsightAction)) {
    return NextResponse.json(
      { error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(", ")}.` },
      { status: 400 },
    );
  }

  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  try {
    switch (action as InsightAction) {
      case "dismiss":
        await markDismissed(serviceClient, merchant.id, id);
        break;
      case "act":
        await markActed(serviceClient, merchant.id, id);
        break;
      case "snooze":
        await markSnoozed(serviceClient, merchant.id, id);
        break;
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof InsightNotFoundError) {
      return NextResponse.json({ error: "Insight not found." }, { status: 404 });
    }
    console.error(
      JSON.stringify({
        event: "insight_transition_error",
        insight_id: id,
        action,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "Failed to update insight." }, { status: 500 });
  }
}
