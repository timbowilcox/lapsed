"use client";

// Brand voice preview (Sprint 05, chunk 10). Renders the active voice
// profile — tone descriptors as chips, register/cadence as labels, the five
// sample sentences, and signature phrases as accent text. Shared between the
// onboarding screen and the Settings brand-voice tab.

import type { VoiceProfile } from "@lapsed/core";
import { Button, Tag } from "@lapsed/ui";
import { RefreshCw } from "lucide-react";

export interface VoicePreviewProps {
  profile: VoiceProfile;
  /**
   * "settings" enables the Re-extract action; "onboarding" renders it
   * disabled (re-extraction is a Settings-only action).
   */
  context?: "onboarding" | "settings";
  /** Invoked by the Re-extract button in the Settings context. */
  onReExtract?: () => void;
  /** When true, the Re-extract button shows an in-progress state. */
  reExtracting?: boolean;
}

/** Renders a taxonomy enum value (e.g. `down_to_earth`) as readable text. */
function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

export function VoicePreview({
  profile,
  context = "onboarding",
  onReExtract,
  reExtracting = false,
}: VoicePreviewProps) {
  const isSettings = context === "settings";

  return (
    <section
      className="flex w-full flex-col gap-16 rounded-xl bg-cream-50 p-24"
      aria-label="Brand voice preview"
    >
      <div className="flex items-start justify-between gap-16">
        <div className="flex flex-col gap-4">
          <h3 className="text-h3 text-ink-900">Your brand voice</h3>
          <p className="text-meta text-ink-500">
            Synthesized from your storefront. The agent writes win-back messages in this voice.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={!isSettings || reExtracting}
          onClick={isSettings ? onReExtract : undefined}
        >
          <RefreshCw
            strokeWidth={1.75}
            size={15}
            className={reExtracting ? "motion-safe:animate-spin" : undefined}
            aria-hidden="true"
          />
          {reExtracting ? "Re-extracting…" : "Re-extract"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-6">
        {profile.tone_descriptors.map((tone) => (
          <Tag key={tone} tone="active">
            {humanize(tone)}
          </Tag>
        ))}
      </div>

      <dl className="flex flex-wrap gap-x-32 gap-y-8">
        <div className="flex flex-col gap-2">
          <dt className="text-micro uppercase tracking-wide text-ink-500">Register</dt>
          <dd className="text-body text-ink-900">{humanize(profile.register)}</dd>
        </div>
        <div className="flex flex-col gap-2">
          <dt className="text-micro uppercase tracking-wide text-ink-500">Sentence length</dt>
          <dd className="text-body text-ink-900">{humanize(profile.sentence_length)}</dd>
        </div>
        <div className="flex flex-col gap-2">
          <dt className="text-micro uppercase tracking-wide text-ink-500">Emoji</dt>
          <dd className="text-body text-ink-900">{humanize(profile.emoji_policy)}</dd>
        </div>
      </dl>

      <div className="flex flex-col gap-8">
        <h4 className="text-label text-ink-700">Sample messages</h4>
        <ul className="flex flex-col gap-8">
          {profile.sample_sentences.map((sentence, idx) => (
            <li
              key={`${idx}-${sentence.slice(0, 24)}`}
              className="rounded-lg bg-cream-100 p-12 text-body text-ink-900"
            >
              {sentence}
            </li>
          ))}
        </ul>
      </div>

      {profile.signature_phrases.length > 0 && (
        <p className="text-meta text-ink-500">
          Signature phrases:{" "}
          <span className="text-ink-700">{profile.signature_phrases.join(" · ")}</span>
        </p>
      )}
    </section>
  );
}
