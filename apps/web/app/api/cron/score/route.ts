import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { scoreCustomers, createScoringClient } from "@lapsed/core";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface MerchantRow {
  id: string;
  shopify_shop_domain: string;
}

interface AggregateRow {
  merchant_id: string;
  median_aov_cents: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = serverEnv();

  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${env.cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const anthropicClient = createScoringClient({ apiKey: env.anthropicApiKey });

  const { data: merchants, error: merchantsErr } = await serviceClient
    .from("merchants")
    .select("id,shopify_shop_domain");

  if (merchantsErr) {
    return NextResponse.json({ error: "merchants_fetch_failed" }, { status: 500 });
  }

  const merchantList = (merchants ?? []) as MerchantRow[];
  const results: Array<{
    merchantId: string;
    status: string;
    customersScored: number;
    costCents: number;
    capReached: boolean;
  }> = [];

  for (const merchant of merchantList) {
    const { data: agg } = await serviceClient
      .from("merchant_aggregates")
      .select("merchant_id,median_aov_cents")
      .eq("merchant_id", merchant.id)
      .maybeSingle();

    const row = agg as unknown as AggregateRow | null;
    const medianAovCents = Number(row?.median_aov_cents ?? 0);

    try {
      const result = await scoreCustomers(serviceClient, anthropicClient, {
        merchantId: merchant.id,
        medianAovCents,
      });

      results.push({
        merchantId: merchant.id.slice(0, 8),
        status: result.status,
        customersScored: result.customersScored,
        costCents: result.costCents,
        capReached: result.capReached,
      });
    } catch (err) {
      results.push({
        merchantId: merchant.id.slice(0, 8),
        status: "failed",
        customersScored: 0,
        costCents: 0,
        capReached: false,
      });
      console.error(
        JSON.stringify({
          event: "score_cron_merchant_error",
          merchant_id: merchant.id.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return NextResponse.json({ merchants: merchantList.length, results });
}
