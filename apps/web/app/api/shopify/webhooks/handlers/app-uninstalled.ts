import type { WebhookHandler } from "./types";

export const appUninstalled: WebhookHandler = async ({
  merchantId,
  shopDomain,
  serviceClient,
}) => {
  const now = new Date().toISOString();

  // 1. Append merchant lifecycle event — required for billing reconciliation.
  //    Incremental revenue attribution is bounded by install windows derived from
  //    this log. ignoreDuplicates guards against double delivery.
  await serviceClient.from("merchant_events").upsert(
    {
      merchant_id: merchantId,
      event_type: "app_uninstalled",
      source: "shopify_webhook",
      occurred_at: now,
    },
    { onConflict: "merchant_id,event_type,source,occurred_at", ignoreDuplicates: true },
  );

  // 2. Mark the merchant as uninstalled. Do not delete data — retained for
  //    potential reinstall and for billing reconciliation.
  //    The IS NULL guard prevents a duplicate webhook from overwriting a
  //    reinstall's cleared uninstalled_at.
  await serviceClient
    .from("merchants")
    .update({ uninstalled_at: now })
    .eq("id", merchantId)
    .is("uninstalled_at", null);

  // Log only the shop domain prefix (before the dot) to avoid PII log leakage.
  const domainLabel = shopDomain.split(".")[0] ?? "unknown";
  console.info(`webhook app/uninstalled shop_prefix=${domainLabel}`);
};
