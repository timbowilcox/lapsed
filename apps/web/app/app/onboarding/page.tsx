import { MerchantShell } from "../_components/merchant-shell";
import { OnboardingFlow } from "./_onboarding-flow";

export default function OnboardingPage() {
  return (
    <MerchantShell pageTitle="Get started">
      <OnboardingFlow />
    </MerchantShell>
  );
}
