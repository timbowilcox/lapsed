"use client";

// Settings → Brand voice (Sprint 05, chunk 11). Three sections behind two
// sub-tabs: the active voice preview (with Re-extract), and the version
// history list (View + Activate per row).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  Tag,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@lapsed/ui";
import type { VoiceProfile } from "@lapsed/core";
import type { VoiceProfileResponse } from "@/app/api/voice/profile/route";
import type { VoiceVersionView } from "@/app/api/voice/versions/route";
import { VoicePreview } from "../_components/voice-preview";

const POLL_INTERVAL_MS = 2000;
// ~2 minute ceiling on waiting for a re-extraction to complete.
const MAX_REEXTRACT_POLLS = 60;

interface ExtractionStatusLite {
  phase: "analyzing" | "extracting" | "generating" | "ready" | "failed";
  startedAt: string | null;
  errorMessage: string | null;
}

const PHASE_LABEL: Record<ExtractionStatusLite["phase"], string> = {
  analyzing: "Analyzing storefront…",
  extracting: "Extracting brand voice…",
  generating: "Generating agent identity…",
  ready: "Done",
  failed: "Failed",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function BrandVoiceSettings() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [activeProfile, setActiveProfile] = useState<VoiceProfile | null>(null);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [versions, setVersions] = useState<VoiceVersionView[]>([]);

  const [reExtracting, setReExtracting] = useState(false);
  const [reExtractPhase, setReExtractPhase] = useState<ExtractionStatusLite["phase"] | null>(null);
  const [reExtractError, setReExtractError] = useState<string | null>(null);

  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [viewVersion, setViewVersion] = useState<VoiceVersionView | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [profileRes, versionsRes] = await Promise.all([
        fetch("/api/voice/profile", { cache: "no-store" }),
        fetch("/api/voice/versions", { cache: "no-store" }),
      ]);
      if (!profileRes.ok || !versionsRes.ok) {
        setLoadError(true);
        return;
      }
      const profileData = (await profileRes.json()) as VoiceProfileResponse | null;
      const versionsData = (await versionsRes.json()) as VoiceVersionView[];
      setActiveProfile(profileData?.profile ?? null);
      setActiveVersionId(profileData?.versionId ?? null);
      setVersions(versionsData);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [loadData]);

  const handleReExtract = useCallback(async () => {
    setReExtractError(null);
    setActionError(null);

    // Capture the current run boundary so the poller can tell when the new
    // run has begun (rather than reading the prior run's terminal status).
    let priorStartedAt: string | null = null;
    try {
      const statusRes = await fetch("/api/voice/status", { cache: "no-store" });
      if (statusRes.ok) {
        priorStartedAt = ((await statusRes.json()) as ExtractionStatusLite).startedAt;
      }
    } catch {
      /* no baseline — the poller still terminates via the poll ceiling */
    }

    let res: Response;
    try {
      res = await fetch("/api/voice/reextract", { method: "POST" });
    } catch {
      setReExtractError("We couldn't start a re-extraction. Please try again.");
      return;
    }
    if (res.status === 429) {
      setReExtractError(
        "You've reached today's brand-voice extraction limit. Please try again tomorrow.",
      );
      return;
    }
    if (!res.ok) {
      setReExtractError("We couldn't start a re-extraction. Please try again.");
      return;
    }

    setReExtracting(true);
    setReExtractPhase("analyzing");

    let polls = 0;
    const poll = async (): Promise<void> => {
      polls += 1;
      try {
        const statusRes = await fetch("/api/voice/status", { cache: "no-store" });
        if (statusRes.ok) {
          const status = (await statusRes.json()) as ExtractionStatusLite;
          const isNewRun = status.startedAt !== null && status.startedAt !== priorStartedAt;
          if (isNewRun) {
            setReExtractPhase(status.phase);
            if (status.phase === "ready") {
              setReExtracting(false);
              setReExtractPhase(null);
              await loadData();
              return;
            }
            if (status.phase === "failed") {
              setReExtracting(false);
              setReExtractPhase(null);
              setReExtractError("The re-extraction failed. Please try again.");
              return;
            }
          }
        }
      } catch {
        /* transient — keep polling */
      }
      if (polls >= MAX_REEXTRACT_POLLS) {
        setReExtracting(false);
        setReExtractPhase(null);
        setReExtractError("The re-extraction is taking longer than expected. Refresh to check.");
        return;
      }
      pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    pollTimerRef.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }, [loadData]);

  const handleActivate = useCallback(
    async (versionId: string) => {
      setActionError(null);
      setActivatingId(versionId);
      try {
        const res = await fetch("/api/voice/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionId }),
        });
        if (!res.ok) {
          setActionError("We couldn't activate that version. Please try again.");
          return;
        }
        await loadData();
      } catch {
        setActionError("We couldn't activate that version. Please try again.");
      } finally {
        setActivatingId(null);
      }
    },
    [loadData],
  );

  if (loading) {
    return (
      <div className="p-24">
        <div
          className="h-160 w-full animate-pulse rounded-lg bg-cream-200"
          aria-label="Loading brand voice"
        />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-24">
        <p className="text-body text-ink-700" role="alert">
          We couldn&apos;t load your brand voice. Please refresh the page.
        </p>
      </div>
    );
  }

  return (
    <div className="p-24">
      <Tabs defaultValue="active">
        <TabsList>
          <TabsTrigger value="active">Active voice</TabsTrigger>
          <TabsTrigger value="history">Version history</TabsTrigger>
        </TabsList>

        <TabsContent value="active">
          {activeProfile ? (
            <div className="flex flex-col gap-12">
              <VoicePreview
                profile={activeProfile}
                context="settings"
                onReExtract={() => void handleReExtract()}
                reExtracting={reExtracting}
              />
              {reExtracting && reExtractPhase && (
                <p className="text-meta text-ink-500" aria-live="polite">
                  {PHASE_LABEL[reExtractPhase]}
                </p>
              )}
              {reExtractError && (
                <p className="text-meta text-danger-500" role="alert">
                  {reExtractError}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-12">
              <p className="text-body text-ink-700">
                No brand voice has been extracted yet.
              </p>
              <Button
                variant="secondary"
                disabled={reExtracting}
                onClick={() => void handleReExtract()}
              >
                {reExtracting ? "Extracting…" : "Extract brand voice"}
              </Button>
              {reExtracting && reExtractPhase && (
                <p className="text-meta text-ink-500" aria-live="polite">
                  {PHASE_LABEL[reExtractPhase]}
                </p>
              )}
              {reExtractError && (
                <p className="text-meta text-danger-500" role="alert">
                  {reExtractError}
                </p>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="history">
          {versions.length === 0 ? (
            <p className="text-body text-ink-500">No voice versions yet.</p>
          ) : (
            <>
              {actionError && (
                <p className="mb-12 text-meta text-danger-500" role="alert">
                  {actionError}
                </p>
              )}
              <ul className="flex flex-col gap-8">
                {versions.map((version) => {
                  const isActive = version.id === activeVersionId;
                  return (
                    <li key={version.id}>
                      <Card className="flex items-center justify-between gap-16 p-16">
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-8">
                            <span className="text-body-strong text-ink-900">
                              Version {version.versionNumber}
                            </span>
                            {isActive && <Tag tone="converted">Active</Tag>}
                          </div>
                          <span className="text-mini text-ink-500">
                            Extracted {formatDate(version.extractedAt)} · {version.modelVersion}
                          </span>
                        </div>
                        <div className="flex items-center gap-8">
                          <Button
                            variant="ghost"
                            disabled={version.profile === null}
                            onClick={() => setViewVersion(version)}
                          >
                            View
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={isActive || activatingId !== null}
                            onClick={() => void handleActivate(version.id)}
                          >
                            {activatingId === version.id
                              ? "Activating…"
                              : isActive
                                ? "Active"
                                : "Activate"}
                          </Button>
                        </div>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </TabsContent>
      </Tabs>

      <Dialog
        open={viewVersion !== null}
        onOpenChange={(open) => {
          if (!open) setViewVersion(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Version {viewVersion?.versionNumber}</DialogTitle>
            <DialogDescription>
              {viewVersion
                ? `Extracted ${formatDate(viewVersion.extractedAt)} · ${viewVersion.modelVersion}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {viewVersion?.profile ? (
            <VoicePreview profile={viewVersion.profile} context="onboarding" />
          ) : (
            <p className="text-body text-ink-500">
              This version&apos;s profile could not be displayed.
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Close</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
