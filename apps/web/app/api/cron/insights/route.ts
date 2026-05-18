// AI Insights cron — Sprint 11 chunk 8.
// Runs at 05, 11, 17, 23 UTC (every 6 hours). For each merchant, evaluates
// all signal categories and inserts new active insight rows where a threshold
// is crossed and no non-expired active row exists (idempotent).
//
// Decision 36: deterministic, no LLM calls. Recommendations derived from
// existing DB signals only (RFM scores, cohort sizes, bandit posteriors,
// opt-out trends, conversation activity, payment status).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { generateRecommendations } from "@lapsed/core";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

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

  const { data: merchants, error: merchantsErr } = await serviceClient
    .from("merchants")
    .select("id,shopify_shop_domain");
  if (merchantsErr) {
    console.error(
      JSON.stringify({ event: "insights_cron_merchants_error", error: merchantsErr.message }),
    );
    return NextResponse.json({ error: "merchants_fetch_failed" }, { status: 500 });
  }

  const merchantList = (merchants ?? []) as MerchantRow[];
  const results = [];
  let totalGenerated = 0;
  let totalSkipped = 0;

  for (const merchant of merchantList) {
    try {
      const r = await generateRecommendations(serviceClient, merchant.id);
      totalGenerated += r.generated;
      totalSkipped += r.skipped;
      results.push({
        merchantId: merchant.id.slice(0, 8),
        generated: r.generated,
        skipped: r.skipped,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "insights_cron_merchant_failed",
          merchant_id: merchant.id.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      results.push({ merchantId: merchant.id.slice(0, 8), error: "failed" });
    }
  }

  const hadFailures = results.some((r) => "error" in r);
  console.info(
    `insights_cron merchants=${merchantList.length} generated=${totalGenerated} ` +
      `skipped=${totalSkipped} errors=${results.filter((r) => "error" in r).length}`,
  );
  return NextResponse.json(
    { merchants: merchantList.length, totalGenerated, totalSkipped, hadFailures, results },
    { status: hadFailures ? 207 : 200 },
  );
}
