// Conversation list (Sprint 07, chunk 10) — every two-way SMS thread the
// agent is running, one row per customer (decision 16). Real data, replacing
// the Sprint 01 fixture surface.

import { mintMerchantJwt, createMerchantClient, getConversationList } from "@lapsed/db";
import { requireMerchant } from "@/app/lib/session";
import { serverEnv } from "@/app/lib/env";
import { MerchantShell } from "../_components/merchant-shell";
import { ConversationsList } from "./_conversations-list";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ConversationsPage({ searchParams }: PageProps) {
  const merchant = await requireMerchant({ searchParams: await searchParams });

  const env = serverEnv();
  const jwt = await mintMerchantJwt({
    shopDomain: merchant.shopDomain,
    jwtSecret: env.supabaseJwtSecret,
  });
  const client = createMerchantClient({
    url: env.supabaseUrl,
    publishableKey: env.supabasePublishableKey,
    merchantJwt: jwt,
  });

  const items = await getConversationList(client, merchant.id);

  return (
    <MerchantShell pageTitle="Conversations">
      <div className="mb-24">
        <h1 className="mb-4 text-h1 text-ink-900">Conversations</h1>
        <p className="text-meta text-ink-500">
          Every two-way SMS thread the agent is running — one thread per customer, across all
          their campaigns.
        </p>
      </div>

      <ConversationsList items={items} />
    </MerchantShell>
  );
}
