// Onboarding state API (Sprint 11, Chunk 12).
//
//   POST /api/onboarding — body: { state: "in_progress" | "completed" | "skipped" }
//
// Called by the first-run tour to persist progress. Auth: session cookie /
// App Bridge bearer token. Service-role write bypasses RLS (consistent with
// other settings mutations).

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATES = ["in_progress", "completed", "skipped"] as const;
type TransitionState = (typeof VALID_STATES)[number];

export async function POST(req: NextRequest): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const state = (body as Record<string, unknown>)?.state;
  if (!VALID_STATES.includes(state as TransitionState)) {
    return NextResponse.json(
      { error: "invalid_state", valid: VALID_STATES },
      { status: 400 },
    );
  }

  const env = serverEnv();
  const client = createServiceClient({ url: env.supabaseUrl, serviceKey: env.supabaseSecretKey });

  const { error } = await client
    .from("merchants")
    .update({ onboarding_state: state as string })
    .eq("id", merchant.id);

  if (error) {
    return NextResponse.json({ error: "db_error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, state });
}
