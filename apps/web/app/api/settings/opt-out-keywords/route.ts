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
  updateMerchantOptOutKeywords,
  updateMerchantAgentDraftDefaults,
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

  const config = await getMerchantOptOutConfig(client, merchant.id);

  // Merge Twilio reserved keywords into the display list (they are always present)
  const displayOptOut = dedupeKeywords([...TWILIO_RESERVED, ...config.optOutKeywords]);

  return NextResponse.json({
    optOutKeywords: displayOptOut,
    agentDraftDefaults: config.agentDraftDefaults,
  });
}

interface PatchBody {
  list: "opt_out_keywords" | "agent_draft_defaults";
  action: "add" | "remove";
  keyword: string;
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { list, action, keyword } = body;

  if (list !== "opt_out_keywords" && list !== "agent_draft_defaults") {
    return NextResponse.json({ error: "invalid_list" }, { status: 400 });
  }
  if (action !== "add" && action !== "remove") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }
  if (typeof keyword !== "string" || keyword.trim().length === 0) {
    return NextResponse.json({ error: "keyword_required" }, { status: 400 });
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

  const config = await getMerchantOptOutConfig(client, merchant.id);
  const currentList = list === "opt_out_keywords" ? config.optOutKeywords : config.agentDraftDefaults;
  const normalised = normalise(keyword);

  let updated: string[];
  if (action === "add") {
    updated = dedupeKeywords([...currentList, normalised]);
  } else {
    updated = currentList.filter((k) => k.toUpperCase() !== normalised);
  }

  if (list === "opt_out_keywords") {
    await updateMerchantOptOutKeywords(client, merchant.id, updated);
  } else {
    await updateMerchantAgentDraftDefaults(client, merchant.id, updated);
  }

  // Return the merged display list for opt_out (same as GET)
  const finalOptOut =
    list === "opt_out_keywords"
      ? dedupeKeywords([...TWILIO_RESERVED, ...updated])
      : dedupeKeywords([...TWILIO_RESERVED, ...config.optOutKeywords]);
  const finalDrafts =
    list === "agent_draft_defaults" ? updated : config.agentDraftDefaults;

  return NextResponse.json({
    optOutKeywords: finalOptOut,
    agentDraftDefaults: finalDrafts,
  });
}
