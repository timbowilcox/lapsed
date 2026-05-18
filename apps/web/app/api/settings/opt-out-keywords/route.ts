// Opt-out keyword configuration API.
//
//   GET  — returns { optOutKeywords, agentDraftDefaults }. Merges Twilio-reserved
//          STOP/STOPALL into the optOutKeywords for display, but they are NOT
//          stored in the DB column (the column holds only merchant-configured
//          extras; the migration comment explains why).
//
//   PATCH — { list, action, keyword }
//           list:    "opt_out_keywords" | "agent_draft_defaults"
//           action:  "add" | "remove"
//           keyword: the keyword string to add or remove
//
// Auth: lapsed_session cookie / App Bridge bearer token via getMerchantFromSession.

import { NextResponse } from "next/server";
import {
  createServiceClient,
  getMerchantOptOutConfig,
  mutateMerchantKeyword,
} from "@lapsed/db";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { validateKeyword, assertNotReserved, normalise, dedupeKeywords, TWILIO_RESERVED } from "./_validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const env = serverEnv();
  const client = createServiceClient({ url: env.supabaseUrl, serviceKey: env.supabaseSecretKey });

  try {
    const config = await getMerchantOptOutConfig(client, merchant.id);
    const displayOptOut = dedupeKeywords([...TWILIO_RESERVED, ...config.optOutKeywords]);
    return NextResponse.json({
      optOutKeywords: displayOptOut,
      agentDraftDefaults: config.agentDraftDefaults,
    });
  } catch {
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { list, action, keyword } = raw as Record<string, unknown>;

  if (list !== "opt_out_keywords" && list !== "agent_draft_defaults") {
    return NextResponse.json({ error: "Unknown keyword list." }, { status: 400 });
  }
  if (action !== "add" && action !== "remove") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
  if (typeof keyword !== "string" || keyword.trim().length === 0) {
    return NextResponse.json({ error: "Please enter a keyword." }, { status: 400 });
  }

  const keywordValidation = validateKeyword(keyword);
  if (!keywordValidation.valid) {
    return NextResponse.json({ error: keywordValidation.error }, { status: 422 });
  }

  if (action === "remove") {
    const reservedCheck = assertNotReserved(keyword);
    if (!reservedCheck.valid) {
      return NextResponse.json({ error: reservedCheck.error }, { status: 422 });
    }
  }

  const env = serverEnv();
  const client = createServiceClient({ url: env.supabaseUrl, serviceKey: env.supabaseSecretKey });
  const normalised = normalise(keyword);

  try {
    // Atomic single-statement UPDATE via Postgres function (migration 0012).
    await mutateMerchantKeyword(client, merchant.id, list, action, normalised);
    // Re-read for the response (no race: the mutation already committed).
    const updatedConfig = await getMerchantOptOutConfig(client, merchant.id);
    const finalOptOut = dedupeKeywords([...TWILIO_RESERVED, ...updatedConfig.optOutKeywords]);
    return NextResponse.json({
      optOutKeywords: finalOptOut,
      agentDraftDefaults: updatedConfig.agentDraftDefaults,
    });
  } catch {
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
