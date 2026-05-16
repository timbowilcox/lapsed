// Voice profile version history for the session merchant.
//
//   GET — returns every voice_versions row (newest first) as VoiceVersionView[].
//         Each stored profile jsonb is validated; a malformed row surfaces
//         with profile: null rather than failing the whole list.
//
// Auth: lapsed_session cookie / App Bridge bearer via getMerchantFromSession.

import { NextResponse } from "next/server";
import { createServiceClient, listVoiceVersions } from "@lapsed/db";
import { parseVoiceProfile, type VoiceProfile } from "@lapsed/core";
import { getMerchantFromSession } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface VoiceVersionView {
  id: string;
  versionNumber: number;
  modelVersion: string;
  extractedAt: string;
  /** Validated profile, or null when the stored jsonb fails validation. */
  profile: VoiceProfile | null;
}

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

  const versions = await listVoiceVersions(client, merchant.id);
  const views: VoiceVersionView[] = versions.map((version) => {
    let profile: VoiceProfile | null = null;
    try {
      profile = parseVoiceProfile(version.profile);
    } catch {
      console.warn(`voice_version_profile_parse_failed version_id=${version.id}`);
    }
    return {
      id: version.id,
      versionNumber: version.versionNumber,
      modelVersion: version.modelVersion,
      extractedAt: version.extractedAt,
      profile,
    };
  });

  return NextResponse.json(views);
}
