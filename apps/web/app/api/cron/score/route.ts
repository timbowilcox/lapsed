import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { scoreCustomers, createScoringClient } from "@lapsed/core";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_RETRIES = 3;

interface MerchantRow {
  id: string;
  shopify_shop_domain: string;
}

interface AggregateRow {
  merchant_id: string;
  median_aov_cents: string | null;
}

/** Exponential backoff: 5s, 15s, 45s */
function backoffMs(attempt: number): number {
  return 5_000 * Math.pow(3, attempt);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    attempts: number;
  }> = [];

  for (const merchant of merchantList) {
    const { data: agg } = await serviceClient
      .from("merchant_aggregates")
      .select("merchant_id,median_aov_cents")
      .eq("merchant_id", merchant.id)
      .maybeSingle();

    const row = agg as unknown as AggregateRow | null;
    const medianAovCents = Number(row?.median_aov_cents ?? 0);

    let lastErr: unknown = null;
    let succeeded = false;
    let finalResult = { customersScored: 0, costCents: 0, capReached: false };

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt - 1));
      }
      try {
        const result = await scoreCustomers(serviceClient, anthropicClient, {
          merchantId: merchant.id,
          medianAovCents,
        });
        finalResult = {
          customersScored: result.customersScored,
          costCents: result.costCents,
          capReached: result.capReached,
        };
        succeeded = true;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(
          JSON.stringify({
            event: "score_cron_retry",
            merchant_id: merchant.id.slice(0, 8),
            attempt,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }

    if (!succeeded) {
      console.error(
        JSON.stringify({
          event: "score_cron_merchant_failed",
          merchant_id: merchant.id.slice(0, 8),
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        }),
      );
    }

    results.push({
      merchantId: merchant.id.slice(0, 8),
      status: succeeded ? "succeeded" : "failed",
      ...finalResult,
      attempts: succeeded ? 1 : MAX_RETRIES,
    });
  }

  return NextResponse.json({ merchants: merchantList.length, results });
}
