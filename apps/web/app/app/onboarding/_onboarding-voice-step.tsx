"use client";

// Onboarding voice step (Sprint 05, chunk 10). Composes the extraction
// progress indicator with the voice preview: once the extraction reaches
// `ready`, the active voice profile is fetched and previewed in place.

import { useCallback, useState } from "react";
import type { VoiceProfile } from "@lapsed/core";
import { ExtractionProgress } from "./_extraction-progress";
import { VoicePreview } from "../_components/voice-preview";

export function OnboardingVoiceStep() {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);

  const handleComplete = useCallback(async () => {
    // Best-effort: the progress indicator already shows `ready`; a fetch
    // failure here just means the preview doesn't render.
    try {
      const res = await fetch("/api/voice/profile", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { profile: VoiceProfile } | null;
      if (data?.profile) setProfile(data.profile);
    } catch {
      /* preview is non-critical during onboarding */
    }
  }, []);

  return (
    <div className="flex w-full flex-col gap-16">
      <ExtractionProgress onComplete={() => void handleComplete()} />
      {profile && <VoicePreview profile={profile} context="onboarding" />}
    </div>
  );
}
