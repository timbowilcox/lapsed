// Attribution batch cron — Sprint 08 chunk 9.
// Daily at 06:00 UTC (16:00 AEST) — well after the rfm (03:00) and score
// (04:00) nightly batches. For every approved-and-launched campaign whose
// attribution window has closed, materialises one attribution_results row,
// fires the ground-truth bandit order posterior, and writes the per-customer
// ltv_snapshots. Idempotent — re-running skips already-materialised campaigns
// (decision 26).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { runAttributionBatch } from "@lapsed/core";
import { serverEnv } from "@/app/lib/env";

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
    const result = await runAttributionBatch(serviceClient);
    console.info(
      `attribution_batch_cron merchants=${result.merchantsProcessed} ` +
        `computed=${result.campaignsComputed} skipped=${result.campaignsSkipped} ` +
        `results_written=${result.resultsWritten} errors=${result.errors} ` +
        `elapsed_ms=${Date.now() - startedAt}`,
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "attribution_batch_cron_error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "attribution_batch_failed" }, { status: 500 });
  }
}
