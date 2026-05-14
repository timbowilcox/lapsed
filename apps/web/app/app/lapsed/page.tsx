import { Suspense } from "react";
import { Panel, LapsedCustomersSkeleton } from "@lapsed/ui";
import { requireMerchant } from "@/app/lib/session";
import { MerchantShell } from "../_components/merchant-shell";
import { LapsedCustomersContent } from "./_lapsed-customers-content";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LapsedPage({ searchParams }: PageProps) {
  const merchant = await requireMerchant({ searchParams: await searchParams });

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
        <Suspense fallback={<LapsedCustomersSkeleton />}>
          <LapsedCustomersContent merchant={merchant} />
        </Suspense>
      </Panel>
    </MerchantShell>
  );
}
