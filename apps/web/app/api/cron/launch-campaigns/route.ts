// Campaign launcher cron — Sprint 07 chunk 8.
// Daily cron: for each merchant, launches every approved campaign proposal by
// Thompson-sampling an arm per customer and sending the variant draft via the
// outbound message engine. Idempotent — re-running skips already-sent
// customers via sendMessage's campaign guard. Cost-disciplined via
// OUTBOUND_DAILY_CAP_DEFAULT.

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { createTwilioClient, launchMerchantCampaigns } from "@lapsed/core";
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
  const twilioClient = createTwilioClient({
    accountSid: env.twilioAccountSid,
    authToken: env.twilioAuthToken,
  });

  const { data: merchants, error: merchantsErr } = await serviceClient
    .from("merchants")
    .select("id,shopify_shop_domain");
  if (merchantsErr) {
    console.error(
      JSON.stringify({ event: "launch_campaigns_merchants_error", error: merchantsErr.message }),
    );
    return NextResponse.json({ error: "merchants_fetch_failed" }, { status: 500 });
  }

  const merchantList = (merchants ?? []) as MerchantRow[];
  const results = [];
  let totalSent = 0;

  for (const merchant of merchantList) {
    try {
      const r = await launchMerchantCampaigns(serviceClient, twilioClient, {
        merchantId: merchant.id,
        fromNumber: env.twilioPhoneNumber,
        outboundDailyCap: env.outboundDailyCapDefault,
      });
      totalSent += r.sent;
      results.push({ ...r, merchantId: merchant.id.slice(0, 8) });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "launch_campaigns_merchant_failed",
          merchant_id: merchant.id.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      results.push({ merchantId: merchant.id.slice(0, 8), error: "failed" });
    }
  }

  const hadFailures = results.some((r) => "error" in r);
  return NextResponse.json(
    { merchants: merchantList.length, totalSent, hadFailures, results },
    // A merchant-level failure must be visible to the cron monitor — return
    // 207 (multi-status) so a watcher keying on HTTP status sees the run was
    // not fully clean, while the per-merchant isolation above still holds.
    { status: hadFailures ? 207 : 200 },
  );
}
