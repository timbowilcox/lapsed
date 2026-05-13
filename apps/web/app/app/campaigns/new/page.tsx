import { MerchantShell } from "../../_components/merchant-shell";
import { CampaignWizard } from "./_campaign-wizard";

export default function NewCampaignPage() {
  return (
    <MerchantShell pageTitle="New campaign">
      <CampaignWizard />
    </MerchantShell>
  );
}
