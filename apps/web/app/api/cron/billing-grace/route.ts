// Failed-payment grace cron — Sprint 09 chunk 9 (decision 31).
//
// Runs daily at 07:00 UTC (after rfm 03:00, score 04:00, attribution-batch
// 06:00 — see apps/web/vercel.json). Suspends any merchant whose failed-payment
// grace window has elapsed. Idempotent — a suspended merchant no longer
// matches the past_due sweep, so re-running is a no-op.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { runBillingGraceSweep } from "@lapsed/core";
import { serverEnv, billingEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();

  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const startedAt = Date.now();
  try {
    const result = await runBillingGraceSweep(serviceClient, {
      gracePeriodDays: billingEnv().billingGracePeriodDays,
    });
    console.info(
      `billing_grace_cron scanned=${result.scanned} suspended=${result.suspended} ` +
        `within_grace=${result.withinGrace} skipped=${result.skipped} ` +
        `failed=${result.failed} elapsed_ms=${Date.now() - startedAt}`,
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "billing_grace_cron_error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "billing_grace_failed" }, { status: 500 });
  }
}
