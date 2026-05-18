import "server-only";

import { Button, formatDateTime } from "@lapsed/ui";
import { createServiceClient, getMerchantSummary } from "@lapsed/db";
import { serverEnv } from "@/app/lib/env";

export async function SettingsSyncStatus({ merchantId }: { merchantId: string }) {
  const env = serverEnv();
  const serviceClient = createServiceClient({
    url: env.supabaseUrl,
    serviceKey: env.supabaseSecretKey,
  });
  const summary = await getMerchantSummary(serviceClient, merchantId);

  const lastSyncedLabel = summary.last_synced_at
    ? formatDateTime(summary.last_synced_at)
    : "Never";

  return (
    <div className="flex items-center justify-between rounded-sm border border-border p-12">
      <div>
        <div className="text-label text-ink-700">Last synced</div>
        <div className="mt-2 text-meta text-ink-500">{lastSyncedLabel}</div>
      </div>
      <Button variant="secondary" disabled>
        Re-sync
      </Button>
    </div>
  );
}

export function SettingsSyncStatusSkeleton() {
  return (
    <div className="motion-safe:animate-pulse flex items-center justify-between rounded-sm border border-border p-12">
      <div className="space-y-4">
        <div className="h-10 w-20 rounded bg-cream-300" />
        <div className="h-10 w-32 rounded bg-cream-300" />
      </div>
      <div className="h-32 w-[84px] rounded-sm bg-cream-300" />
    </div>
  );
}
