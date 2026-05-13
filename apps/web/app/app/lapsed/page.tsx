import { Panel } from "@lapsed/ui";
import { lapsedCustomers } from "@lapsed/fixtures";
import { MerchantShell } from "../_components/merchant-shell";
import { LapsedCustomersList } from "./_lapsed-customers-list";

export default function LapsedPage() {
  return (
    <MerchantShell pageTitle="Lapsed customers">
      <div className="mb-24 flex items-start justify-between">
        <div>
          <h2 className="mb-4 text-h1 text-ink-900">Lapsed customers</h2>
          <p className="text-meta text-ink-500">
            Customers past their typical purchase cadence. Score blends frequency, value and
            recency.
          </p>
        </div>
      </div>

      <Panel>
        <LapsedCustomersList customers={lapsedCustomers} />
      </Panel>
    </MerchantShell>
  );
}
