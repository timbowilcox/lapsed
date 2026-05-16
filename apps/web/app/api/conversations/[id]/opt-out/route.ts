// POST /api/conversations/[id]/opt-out — merchant manual opt-out override.
//
// Records a `merchant_manual` opt-out (decision 18): dual-recorded to
// customer_opt_outs AND the Twilio leg, immutable, idempotent. The merchant
// boundary is the verified session; a cross-merchant conversation id returns
// 404 (never reveals another merchant's resource).

import { NextResponse } from "next/server";
import { createServiceClient } from "@lapsed/db";
import { createTwilioClient, recordOptOut } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  // Resolve the conversation → customer (merchant-scoped — a cross-merchant
  // id resolves to null and 404s).
  const { data: conv, error: convErr } = await client
    .from("conversations")
    .select("customer_id")
    .eq("id", id)
    .eq("merchant_id", merchant.id)
    .maybeSingle();
  if (convErr) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!conv) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // The phone is only needed for the (best-effort) Twilio leg. Decision 18
  // requires the opt-out to ALWAYS be recordable, so a missing phone is NOT a
  // block — recordOptOut writes the customer_opt_outs source-of-truth row
  // regardless and simply skips the provider call when the phone is empty.
  const { data: customer, error: custErr } = await client
    .from("customers")
    .select("phone")
    .eq("merchant_id", merchant.id)
    .eq("shopify_customer_gid", conv.customer_id)
    .maybeSingle();
  if (custErr) {
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }

  const twilioClient = createTwilioClient({
    accountSid: env.twilioAccountSid,
    authToken: env.twilioAuthToken,
  });

  try {
    const result = await recordOptOut(client, twilioClient, {
      merchantId: merchant.id,
      customerId: conv.customer_id,
      phoneNumber: customer?.phone ?? "",
      source: "merchant_manual",
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "opt_out_failed" }, { status: 500 });
  }
}
