import type { AttributionSummary } from "./types";

const refDate = new Date("2026-05-13T00:00:00Z");

function dayOffsetIso(offset: number): string {
  const d = new Date(refDate);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split("T")[0] ?? "";
}

const dailyValues: Array<[number, number]> = [
  [820, 2],
  [1142, 3],
  [654, 2],
  [1820, 5],
  [1320, 4],
  [968, 3],
  [2104, 6],
  [1450, 4],
  [1820, 5],
  [1240, 3],
  [1640, 5],
  [1842, 5],
  [1180, 3],
  [1980, 6],
  [2240, 7],
  [1420, 4],
  [1860, 5],
  [1620, 4],
  [1440, 4],
  [1840, 5],
  [1320, 4],
  [1980, 6],
  [2204, 7],
  [1620, 5],
  [1820, 5],
  [1340, 4],
  [1980, 6],
  [2104, 6],
  [1820, 5],
  [1240, 3],
];

export const attribution: AttributionSummary = {
  periodStart: dayOffsetIso(-29),
  periodEnd: dayOffsetIso(0),
  totalRecoveredRevenue: 47283,
  totalRecoveredOrders: 142,
  vsPreviousPeriodPct: 23,
  byDay: dailyValues.map(([revenue, orders], idx) => ({
    date: dayOffsetIso(-29 + idx),
    recoveredRevenue: revenue,
    recoveredOrders: orders,
  })),
  byCampaign: [
    {
      campaignId: "cam_001",
      campaignName: "Summer dormant — 60 day cohort",
      recoveredRevenue: 23140,
      recoveredOrders: 47,
      reconciliationStatus: "reconciled",
    },
    {
      campaignId: "cam_002",
      campaignName: "VIP win-back — 90+ days",
      recoveredRevenue: 18290,
      recoveredOrders: 21,
      reconciliationStatus: "reconciled",
    },
    {
      campaignId: "cam_004",
      campaignName: "Holiday returners",
      recoveredRevenue: 5853,
      recoveredOrders: 14,
      reconciliationStatus: "pending",
    },
  ],
};
