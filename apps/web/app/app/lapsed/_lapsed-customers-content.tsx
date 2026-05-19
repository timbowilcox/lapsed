import "server-only";

import Link from "next/link";
import {
  mintMerchantJwt,
  createMerchantClient,
  getLapsedCustomersWithSignals,
} from "@lapsed/db";
import { EmptyState, Button } from "@lapsed/ui";
import { serverEnv } from "@/app/lib/env";
import type { SessionMerchant } from "@/app/lib/session";
import { LapsedCustomersList, type LapsedCustomerListItem } from "./_lapsed-customers-list";

function LapsedCustomersEmptyState() {
  return (
    <div>
      {/* Greyed-out preview of the table structure that will appear */}
      <div
        className="mb-8 overflow-hidden rounded-lg border border-border opacity-30 select-none"
        aria-hidden="true"
      >
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-cream-50">
              {["Customer", "Days lapsed", "Lifetime value", "Score", "Status"].map((col) => (
                <th key={col} className="px-16 py-12 text-left text-label text-ink-500">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-16 py-14">
                  <div className="flex items-center gap-12">
                    <div className="h-32 w-32 shrink-0 rounded-pill bg-cream-300" />
                    <div className="flex flex-col gap-4">
                      <div className="h-[14px] w-[80px] rounded bg-cream-300" />
                      <div className="h-[12px] w-[120px] rounded bg-cream-300" />
                    </div>
                  </div>
                </td>
                <td className="px-16 py-14">
                  <div className="h-[14px] w-[40px] rounded bg-cream-300" />
                </td>
                <td className="px-16 py-14">
                  <div className="h-[14px] w-[56px] rounded bg-cream-300" />
                </td>
                <td className="px-16 py-14">
                  <div className="h-[14px] w-[32px] rounded bg-cream-300" />
                </td>
                <td className="px-16 py-14">
                  <div className="h-[22px] w-[64px] rounded-pill bg-cream-300" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <EmptyState
        heading="No lapsed customers identified yet"
        body="Once your store data syncs, the agent classifies customers by purchase cadence and scores them. Your lapsed customers appear here after the nightly scoring run, typically within 24 hours of installing."
        cta={
          <Button asChild variant="primary" size="sm">
            <Link href="/preview/lapsed">Preview what this looks like</Link>
          </Button>
        }
      />
    </div>
  );
}

export async function LapsedCustomersContent({ merchant }: { merchant: SessionMerchant }) {
  const env = serverEnv();

  const jwt = await mintMerchantJwt({
    shopDomain: merchant.shopDomain,
    jwtSecret: env.supabaseJwtSecret,
  });
  const merchantClient = createMerchantClient({
    url: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    merchantJwt: jwt,
  });

  const { data: customers } = await getLapsedCustomersWithSignals(merchantClient, {
    merchantId: merchant.id,
    limit: 50,
    sortBy: "propensity_90d",
  });

  if (customers.length === 0) return <LapsedCustomersEmptyState />;

  const items: LapsedCustomerListItem[] = customers.map((c) => ({
    id: c.id,
    shopify_customer_gid: c.shopify_customer_gid,
    first_name: c.first_name,
    last_name: c.last_name,
    email: c.email,
    tags: c.tags,
    total_order_count: c.total_order_count,
    total_ltv_cents: c.total_ltv_cents,
    last_order_days_ago: c.last_order_days_ago,
    lapsed_score: c.lapsed_score,
    inferred_state: c.inferred_state,
  }));

  return <LapsedCustomersList customers={items} />;
}
