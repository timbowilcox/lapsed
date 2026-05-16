// Conversation sweep cron — Sprint 07 chunk 9.
// Daily cron with two passes per merchant:
//   A. no-reply posterior sweep — fires updatePosterior(arm, false) for
//      campaign outbounds NO_REPLY_SWEEP_DAYS old with no posterior yet.
//   B. degraded-reply retry — re-runs classify/generate/send for inbounds
//      the synchronous webhook deferred via a degraded_mode event (decision 17).

import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@lapsed/db";
import {
  createTwilioClient,
  createClassifyClient,
  createGenerateClient,
  sweepNoReplyPosteriors,
  retryDegradedReplies,
} from "@lapsed/core";
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
  const classifyClient = createClassifyClient({ apiKey: env.anthropicApiKey });
  const generateClient = createGenerateClient({ apiKey: env.anthropicApiKey });

  const { data: merchants, error: merchantsErr } = await serviceClient
    .from("merchants")
    .select("id,shopify_shop_domain");
  if (merchantsErr) {
    console.error(
      JSON.stringify({ event: "sweep_no_reply_merchants_error", error: merchantsErr.message }),
    );
    return NextResponse.json({ error: "merchants_fetch_failed" }, { status: 500 });
  }

  const merchantList = (merchants ?? []) as MerchantRow[];
  const results = [];
  let totalSwept = 0;
  let totalRetried = 0;

  for (const merchant of merchantList) {
    try {
      const swept = await sweepNoReplyPosteriors(serviceClient, {
        merchantId: merchant.id,
        noReplySweepDays: env.noReplySweepDays,
      });
      const retried = await retryDegradedReplies(
        { serviceClient, twilioClient, classifyClient, generateClient },
        {
          merchantId: merchant.id,
          fromNumber: env.twilioPhoneNumber,
          outboundDailyCap: env.outboundDailyCapDefault,
          model: env.sonnetModel,
        },
      );
      totalSwept += swept.sweptCount;
      totalRetried += retried.retried;
      results.push({
        merchantId: merchant.id.slice(0, 8),
        sweptCount: swept.sweptCount,
        retried: retried.retried,
        optedOut: retried.optedOut,
        stillDegraded: retried.stillDegraded,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "sweep_no_reply_merchant_failed",
          merchant_id: merchant.id.slice(0, 8),
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      results.push({ merchantId: merchant.id.slice(0, 8), error: "failed" });
    }
  }

  const hadFailures = results.some((r) => "error" in r);
  return NextResponse.json(
    { merchants: merchantList.length, totalSwept, totalRetried, hadFailures, results },
    { status: hadFailures ? 207 : 200 },
  );
}
