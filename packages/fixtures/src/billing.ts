import type { BillingSnapshot } from "./types";

export const billing: BillingSnapshot = {
  currentPlan: "growth",
  currentPlanLabel: "Growth",
  currentPlanPrice: 799,
  monthlyMessageQuota: 25000,
  monthlyMessagesUsed: 11342,
  renewsAt: "2026-06-04T00:00:00Z",
  paymentMethodLast4: "4242",
  invoices: [
    { id: "inv_2026_05", issuedAt: "2026-05-04T00:00:00Z", amount: 799, status: "paid", url: "#" },
    { id: "inv_2026_04", issuedAt: "2026-04-04T00:00:00Z", amount: 799, status: "paid", url: "#" },
    { id: "inv_2026_03", issuedAt: "2026-03-04T00:00:00Z", amount: 799, status: "paid", url: "#" },
    { id: "inv_2026_02", issuedAt: "2026-02-04T00:00:00Z", amount: 799, status: "paid", url: "#" },
    { id: "inv_2026_01", issuedAt: "2026-01-04T00:00:00Z", amount: 299, status: "paid", url: "#" },
    { id: "inv_2025_12", issuedAt: "2025-12-04T00:00:00Z", amount: 299, status: "paid", url: "#" },
  ],
};
