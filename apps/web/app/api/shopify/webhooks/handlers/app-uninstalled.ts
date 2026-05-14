import type { WebhookHandler } from "./types";

export const appUninstalled: WebhookHandler = async ({
  merchantId,
  shopDomain,
  serviceClient,
}) => {

  // Mark the merchant as uninstalled. Do not delete data — retained for
  // potential reinstall and for billing reconciliation.
  await serviceClient
    .from("merchants")
    .update({ uninstalled_at: new Date().toISOString() })
    .eq("id", merchantId);

  // Log only the shop domain prefix (before the dot) to avoid PII log leakage.
  const domainLabel = shopDomain.split(".")[0] ?? "unknown";
  console.info(`webhook app/uninstalled shop_prefix=${domainLabel}`);
};
