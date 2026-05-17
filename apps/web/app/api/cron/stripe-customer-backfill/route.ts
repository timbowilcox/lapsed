// Stripe customer backfill cron — Sprint 09 chunk 6.
//
// ONE-SHOT. Provisions a Stripe customer for every pre-Sprint-09 merchant
// whose `stripe_customer_id` is still NULL (decision 28). Not scheduled in
// vercel.json — triggered manually (CRON_SECRET-authed GET) once after the
// Sprint 09 deploy. Idempotent: a re-trigger skips merchants already
// provisioned.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { backfillStripeCustomers } from "@lapsed/core";
import { serverEnv } from "@/app/lib/env";
import { billingStripeClient } from "@/app/lib/billing";

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
    const result = await backfillStripeCustomers(serviceClient, billingStripeClient());
    console.info(
      `stripe_customer_backfill_cron scanned=${result.merchantsScanned} ` +
        `created=${result.customersCreated} errors=${result.errors} ` +
        `elapsed_ms=${Date.now() - startedAt}`,
    );
    const status = result.errors > 0 ? 500 : 200;
    return NextResponse.json(result, { status });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "stripe_customer_backfill_cron_error",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "stripe_customer_backfill_failed" }, { status: 500 });
  }
}
