// Voice-extraction status endpoint for the onboarding progress UI.
//
//   GET  — returns the current ExtractionStatus for the session merchant.
//          Polled every 2s by the onboarding progress component (chunk 9).
//   POST — re-triggers a fresh extraction (the onboarding "Retry" action
//          after a failed run). Fires the CRON-authed /api/voice/extract
//          route server-side so the cron secret never reaches the client.
//
// Auth: lapsed_session cookie / App Bridge bearer token via
// getMerchantFromSession. The merchant id is resolved from the verified
// session — never taken from the request body.

import { NextResponse, after } from "next/server";
import { createServiceClient, getExtractionStatus } from "@lapsed/db";
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

  const status = await getExtractionStatus(client, merchant.id);
  return NextResponse.json(status);
}

export async function POST(): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const env = serverEnv();

  // Re-trigger as a background fetch so the function stays alive past the
  // response. source stays `install_orchestrator` — an onboarding retry is
  // still the install flow, so identity defaults should be (re)derived.
  after(
    fetch(`${env.shopifyAppUrl}/api/voice/extract`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merchantId: merchant.id, source: "install_orchestrator" }),
    })
      .then((res) => {
        // A non-2xx resolves (not rejects) — log it so a stranded retry is
        // observable. The orchestrator writes its own extraction_failed
        // event on failure, which the poller surfaces.
        if (!res.ok) {
          console.warn(`voice_retry_trigger_non_ok status=${res.status}`);
        }
      })
      .catch((err: unknown) => {
        console.warn(`voice_retry_trigger_failed err=${(err as Error).message}`);
      }),
  );

  return NextResponse.json({ ok: true }, { status: 202 });
}
