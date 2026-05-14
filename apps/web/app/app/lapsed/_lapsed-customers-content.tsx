import "server-only";

import { mintMerchantJwt, createMerchantClient, getLapsedCustomers } from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";
import type { SessionMerchant } from "@/app/lib/session";
import { LapsedCustomersList, type LapsedCustomerListItem } from "./_lapsed-customers-list";

function LapsedCustomersEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-64 text-center">
      <p className="text-body-strong text-ink-900">No lapsed customers identified yet.</p>
      <p className="mt-8 max-w-sm text-meta text-ink-500">
        Once your store data syncs, the agent will classify customers by purchase cadence and score
        them. Check back after Sprint 04 scoring runs.
      </p>
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

  const { data: customers } = await getLapsedCustomers(merchantClient, { limit: 50 });

  if (customers.length === 0) return <LapsedCustomersEmptyState />;

  const items: LapsedCustomerListItem[] = customers.map(
    ({
      id,
      shopify_customer_gid,
      first_name,
      last_name,
      email,
      tags,
      total_order_count,
      total_ltv_cents,
      last_order_days_ago,
      lapsed_score,
    }) => ({
      id,
      shopify_customer_gid,
      first_name,
      last_name,
      email,
      tags,
      total_order_count,
      total_ltv_cents,
      last_order_days_ago,
      lapsed_score,
    }),
  );

  return <LapsedCustomersList customers={items} />;
}
