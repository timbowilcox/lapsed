// Active brand voice profile for the session merchant.
//
//   GET — returns the active ActiveVoiceProfile, or null when no extraction
//         has produced an active version yet. Consumed by the onboarding
//         voice preview (chunk 10) and the Settings brand-voice tab.
//
// Auth: lapsed_session cookie / App Bridge bearer token via
// getMerchantFromSession. The merchant id is resolved from the verified
// session — never taken from the request.

import { NextResponse } from "next/server";
import { createServiceClient, getActiveVoiceProfile } from "@lapsed/db";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const merchant = await getMerchantFromSession();
  if (!merchant) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const env = serverEnv();
  const client = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });

  const active = await getActiveVoiceProfile(client, merchant.id);
  return NextResponse.json(active);
}
