// Active brand voice profile for the session merchant.
//
//   GET — returns the active voice profile (VoiceProfileResponse), or null
//         when no extraction has produced an active version yet. Consumed by
//         the onboarding voice preview (chunk 10) and the Settings tab.
//
// Auth: lapsed_session cookie / App Bridge bearer token via
// getMerchantFromSession. The merchant id is resolved from the verified
// session — never taken from the request.

import { NextResponse } from "next/server";
import { createServiceClient, getActiveVoiceProfile, type ActiveVoiceProfile } from "@lapsed/db";
import { parseVoiceProfile, type VoiceProfile } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wire shape of GET /api/voice/profile — the ActiveVoiceProfile envelope
 * with the stored jsonb validated into a typed VoiceProfile.
 */
export type VoiceProfileResponse = Omit<ActiveVoiceProfile, "profile"> & {
  profile: VoiceProfile;
};

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
  if (!active) return NextResponse.json(null);

  // Validate the stored jsonb at the read boundary. The profile is
  // Zod-validated at write time, but a future schema change could leave a
  // legacy row that would crash the preview render — a malformed row is
  // treated as "no usable profile" rather than a 500.
  try {
    const profile = parseVoiceProfile(active.profile);
    const body: VoiceProfileResponse = { ...active, profile };
    return NextResponse.json(body);
  } catch {
    // version_id is a UUID, not PII — safe to log.
    console.warn(`voice_profile_parse_failed version_id=${active.versionId}`);
    return NextResponse.json(null);
  }
}
