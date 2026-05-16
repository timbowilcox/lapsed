// Activates a prior brand voice version (Sprint 05, chunk 11).
//
//   POST { versionId } — writes a `voice_activated` event (source
//   settings_activate) and re-materializes agent_profiles so the chosen
//   version becomes active. The version must belong to the session
//   merchant — tenancy is enforced before any write.
//
// Auth: lapsed_session cookie / App Bridge bearer via getMerchantFromSession.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { appendVoiceEvent, materializeVoice } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ActivateBody {
  versionId?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  let body: ActivateBody;
  try {
    body = (await request.json()) as ActivateBody;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const versionId = body.versionId;
  if (typeof versionId !== "string" || versionId.length === 0) {
    return NextResponse.json({ error: "missing_version_id" }, { status: 400 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Tenancy: the version must belong to this merchant. The merchant_id
  // filter makes a guessed/foreign versionId unactivatable.
  const { data: version, error: versionError } = await client
    .from("voice_versions")
    .select("id")
    .eq("merchant_id", merchant.id)
    .eq("id", versionId)
    .maybeSingle();
  if (versionError) {
    console.warn(`voice_activate_lookup_failed code=${versionError.code ?? "unknown"}`);
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!version) {
    return NextResponse.json({ error: "version_not_found" }, { status: 404 });
  }

  // Previous active version, captured for the audit payload.
  const { data: agentProfile } = await client
    .from("agent_profiles")
    .select("active_voice_version_id")
    .eq("merchant_id", merchant.id)
    .maybeSingle();
  const previousVersionId =
    (agentProfile?.active_voice_version_id as string | null | undefined) ?? null;

  await appendVoiceEvent(client, {
    merchantId: merchant.id,
    eventType: "voice_activated",
    source: "settings_activate",
    occurredAt: new Date().toISOString(),
    payload: { version_id: versionId, previous_version_id: previousVersionId },
  });

  const { activeVoiceVersionId } = await materializeVoice(client, merchant.id);

  return NextResponse.json({ ok: true, activeVoiceVersionId });
}
