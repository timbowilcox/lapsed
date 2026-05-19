// First-run onboarding tour (Sprint 11, Chunk 12).
//
// Standalone page — no AppShell sidebar — so new merchants aren't confused
// by navigation they can't use yet. A merchant who completes or skips the
// tour lands on the dashboard. Authenticated via requireMerchant().

import { requireMerchant } from "@/app/lib/session";
import { OnboardingFlow } from "./_onboarding-flow";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  // Require session — unauthenticated visitors redirect to install.
  // No onboarding_state guard here: allow any state so merchants who
  // return to /app/onboarding manually (e.g. from Settings) can re-enter.
  await requireMerchant();

  return (
    <div className="min-h-screen bg-cream-100 px-16 py-32 md:px-32 md:py-48">
      <OnboardingFlow />
    </div>
  );
}
