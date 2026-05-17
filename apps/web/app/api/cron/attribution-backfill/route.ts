// Attribution results backfill cron — Sprint 09 chunk 4.
//
// ONE-SHOT migration route. Not scheduled in vercel.json — triggered manually
// (CRON_SECRET-authed GET) once, after the Sprint 09 deploy, to re-compute
// every existing attribution_results row under the symmetric-ITT methodology
// (decision 27). Idempotent: a re-trigger is a safe no-op (see
// runAttributionBackfill). The nightly attribution-batch cron continues to
// write new rows under the new methodology going forward.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { runAttributionBackfill } from "@lapsed/core";
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
    const result = await runAttributionBackfill(serviceClient);
    console.info(
      `attribution_backfill_cron scanned=${result.rowsScanned} ` +
        `migrated=${result.rowsMigrated} healed=${result.rowsHealed} ` +
        `already_migrated=${result.rowsAlreadyMigrated} ` +
        `unchanged=${result.rowsUnchanged} errors=${result.errors} ` +
        `elapsed_ms=${Date.now() - startedAt}`,
    );
    // This is an irreversible production-data migration: any per-row error
    // must be surfaced loudly so the operator re-investigates and re-triggers
    // (the run is idempotent + self-healing, so a re-trigger is safe). The
    // result body is returned either way for diagnosis.
    const status = result.errors > 0 ? 500 : 200;
    return NextResponse.json(result, { status });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "attribution_backfill_cron_error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "attribution_backfill_failed" }, { status: 500 });
  }
}
