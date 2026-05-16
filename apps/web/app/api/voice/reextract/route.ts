// Triggers a brand voice re-extraction from Settings (Sprint 05, chunk 11).
//
//   POST — fires the CRON-authed /api/voice/extract route server-side with
//   source `settings_reextract`. The cron secret never reaches the client.
//   Progress is observed by polling GET /api/voice/status.
//
//   A pre-flight daily-cap check returns 429 immediately when the cap is
//   already exhausted, so the UI gets fast feedback instead of polling a
//   guaranteed no-op. runVoiceExtraction performs the authoritative check.
//
// Auth: lapsed_session cookie / App Bridge bearer via getMerchantFromSession.

import { NextResponse, after } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Pre-flight cap check — count voice_extracted events since UTC midnight.
  const now = new Date();
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const { count, error: countError } = await client
    .from("voice_events")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchant.id)
    .eq("event_type", "voice_extracted")
    .gte("occurred_at", utcMidnight);
  if (countError) {
    console.warn(`voice_reextract_cap_check_failed code=${countError.code ?? "unknown"}`);
    return NextResponse.json({ error: "cap_check_failed" }, { status: 500 });
  }
  if ((count ?? 0) >= env.voiceExtractionDailyCapDefault) {
    return NextResponse.json({ error: "daily_cap_exhausted" }, { status: 429 });
  }

  after(
    fetch(`${env.shopifyAppUrl}/api/voice/extract`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merchantId: merchant.id, source: "settings_reextract" }),
    })
      .then((res) => {
        if (!res.ok) {
          console.warn(`voice_reextract_trigger_non_ok status=${res.status}`);
        }
      })
      .catch((err: unknown) => {
        console.warn(`voice_reextract_trigger_failed err=${(err as Error).message}`);
      }),
  );

  return NextResponse.json({ ok: true }, { status: 202 });
}
