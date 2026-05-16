"use client";

// Onboarding voice step (Sprint 05, chunk 10). Composes the extraction
// progress indicator with the voice preview: once the extraction reaches
// `ready`, the active voice profile is fetched and previewed in place.

import { useCallback, useState } from "react";
import type { VoiceProfile } from "@lapsed/core";
import type { VoiceProfileResponse } from "@/app/api/voice/profile/route";
import { ExtractionProgress } from "./_extraction-progress";
import { VoicePreview } from "../_components/voice-preview";

export function OnboardingVoiceStep() {
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [previewError, setPreviewError] = useState(false);

  const handleComplete = useCallback(async () => {
    try {
      const res = await fetch("/api/voice/profile", { cache: "no-store" });
      if (!res.ok) {
        setPreviewError(true);
        return;
      }
      const data = (await res.json()) as VoiceProfileResponse | null;
      if (data) {
        setProfile(data.profile);
      } else {
        setPreviewError(true);
      }
    } catch {
      setPreviewError(true);
    }
  }, []);

  return (
    <div className="flex w-full flex-col gap-16">
      <ExtractionProgress onComplete={() => void handleComplete()} />
      {profile && <VoicePreview profile={profile} context="onboarding" />}
      {!profile && previewError && (
        <p className="text-meta text-ink-500">
          Your brand voice is ready. You can view it any time from Settings.
        </p>
      )}
    </div>
  );
}
