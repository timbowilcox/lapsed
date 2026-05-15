import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { runRfmBatch } from "@lapsed/core";
import type { MerchantContext } from "@lapsed/core";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface MerchantRow {
  id: string;
  shopify_shop_domain: string;
}

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

  // Refresh merchant_aggregates so percentile thresholds reflect the latest
  // materialized customer data from the Sprint 03 profile job.
  const { error: refreshErr } = await serviceClient.rpc("refresh_merchant_aggregates");
  if (refreshErr) {
    console.error(
      JSON.stringify({ event: "rfm_cron_refresh_error", error: refreshErr.message }),
    );
    return NextResponse.json({ error: "matview_refresh_failed" }, { status: 500 });
  }

  const { data: merchants, error: merchantsErr } = await serviceClient
    .from("merchants")
    .select("id,shopify_shop_domain");

  if (merchantsErr) {
    console.error(
      JSON.stringify({ event: "rfm_cron_merchants_error", error: merchantsErr.message }),
    );
    return NextResponse.json({ error: "merchants_fetch_failed" }, { status: 500 });
  }

  const merchantList = (merchants ?? []) as MerchantRow[];
  let totalProcessed = 0;
  let totalErrors = 0;
  const results: Array<{ merchantId: string; processed: number; errors: number }> = [];

  for (const merchant of merchantList) {
    const { data: agg, error: aggErr } = await serviceClient
      .from("merchant_aggregates")
      .select("merchant_id,ltv_p90_cents,median_aov_cents")
      .eq("merchant_id", merchant.id)
      .maybeSingle();

    if (aggErr || !agg) {
      console.warn(
        JSON.stringify({
          event: "rfm_cron_no_aggregates",
          merchant_id: merchant.id.slice(0, 8),
        }),
      );
      continue;
    }

    const merchantContext: MerchantContext = {
      ltvP90Cents: Number(agg.ltv_p90_cents ?? 0),
      medianAovCents: Number(agg.median_aov_cents ?? 0),
    };

    try {
      const result = await runRfmBatch(serviceClient, merchant.id, merchantContext);
      totalProcessed += result.processed;
      totalErrors += result.errors;
      results.push({ merchantId: merchant.id.slice(0, 8), ...result });
    } catch (err) {
      totalErrors++;
      console.error(
        JSON.stringify({
          event: "rfm_cron_merchant_error",
          merchant_id: merchant.id.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return NextResponse.json({
    merchants: merchantList.length,
    processed: totalProcessed,
    errors: totalErrors,
    results,
  });
}
