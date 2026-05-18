// Unit tests for dashboard pure-utility functions (chunk 10).
//
// Covers: computePeriodStats, parsePeriod, computeForecast,
// deriveCampaignHealthRows — all pure functions with no I/O.

import { describe, it, expect } from "vitest";
import {
  parsePeriod,
  computePeriodStats,
  computeForecast,
  deriveCampaignHealthRows,
} from "../app/app/_dashboard-utils";
import type { MerchantAttributionCampaign } from "@lapsed/db";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-18T12:00:00Z");

function makeCampaign(
  windowCloseDate: string,
  incrementalRevenueCents: number,
  overrides: Partial<MerchantAttributionCampaign> = {},
): MerchantAttributionCampaign {
  return {
    campaignId: "cam-1",
    groupSlug: "lapsed_vips",
    windowCloseDate,
    treatmentCohortSize: 100,
    holdoutCohortSize: 10,
    incrementalRevenueCents,
    ciLowCents: null,
    ciHighCents: null,
    ltvRestoredCents: incrementalRevenueCents,
    insufficientEvidence: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parsePeriod
// ─────────────────────────────────────────────────────────────────────────────

describe("parsePeriod", () => {
  it("defaults to '30' for undefined", () => {
    expect(parsePeriod(undefined)).toBe("30");
  });

  it("defaults to '30' for unknown values", () => {
    expect(parsePeriod("7")).toBe("30");
    expect(parsePeriod("")).toBe("30");
    expect(parsePeriod("lifetime")).toBe("30");
  });

  it("accepts '30'", () => {
    expect(parsePeriod("30")).toBe("30");
  });

  it("accepts '90'", () => {
    expect(parsePeriod("90")).toBe("90");
  });

  it("accepts 'all'", () => {
    expect(parsePeriod("all")).toBe("all");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computePeriodStats — empty data
// ─────────────────────────────────────────────────────────────────────────────

describe("computePeriodStats — empty data", () => {
  it("returns all zeros and hasData=false when no campaigns", () => {
    const result = computePeriodStats([], "30", NOW);
    expect(result.totalIncrementalCents).toBe(0);
    expect(result.campaignCount).toBe(0);
    expect(result.hasData).toBe(false);
    expect(result.ciLowCents).toBeNull();
    expect(result.ciHighCents).toBeNull();
    expect(result.vsPreviousPeriodPct).toBeNull();
  });

  it("returns hasData=false when no campaigns in period (all are older)", () => {
    const old = makeCampaign("2025-01-01", 50000); // >90 days before NOW
    const result = computePeriodStats([old], "30", NOW);
    expect(result.hasData).toBe(false);
    expect(result.totalIncrementalCents).toBe(0);
    expect(result.campaignCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computePeriodStats — period filtering
// ─────────────────────────────────────────────────────────────────────────────

describe("computePeriodStats — period filtering", () => {
  it("period=30: includes campaign 10 days ago, excludes 45 days ago", () => {
    const recent = makeCampaign("2026-05-08", 10000); // 10 days before NOW
    const older = makeCampaign("2026-04-03", 20000);  // 45 days before NOW
    const result = computePeriodStats([recent, older], "30", NOW);
    expect(result.campaignCount).toBe(1);
    expect(result.totalIncrementalCents).toBe(10000);
  });

  it("period=90: includes campaign 45 days ago, excludes 100 days ago", () => {
    const mid = makeCampaign("2026-04-03", 20000);   // 45 days before NOW
    const old = makeCampaign("2026-02-07", 5000);    // 100 days before NOW
    const result = computePeriodStats([mid, old], "90", NOW);
    expect(result.campaignCount).toBe(1);
    expect(result.totalIncrementalCents).toBe(20000);
  });

  it("period=all: includes all campaigns regardless of date", () => {
    const c1 = makeCampaign("2026-05-08", 10000);
    const c2 = makeCampaign("2025-01-01", 99000); // very old
    const result = computePeriodStats([c1, c2], "all", NOW);
    expect(result.campaignCount).toBe(2);
    expect(result.totalIncrementalCents).toBe(109000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computePeriodStats — vs previous period
// ─────────────────────────────────────────────────────────────────────────────

describe("computePeriodStats — vs previous period", () => {
  it("computes positive % when current > previous", () => {
    // current period (0-30 days): 20000
    const current = makeCampaign("2026-05-08", 20000); // 10 days ago
    // previous period (30-60 days): 10000
    const prev = makeCampaign("2026-04-18", 10000);    // 30 days ago exactly
    const result = computePeriodStats([current, prev], "30", NOW);
    // current=20000, previous=10000 → +100%
    expect(result.vsPreviousPeriodPct).toBe(100);
  });

  it("computes negative % when current < previous", () => {
    const current = makeCampaign("2026-05-08", 5000);  // current period
    const prev = makeCampaign("2026-04-08", 10000);    // previous 30d window
    const result = computePeriodStats([current, prev], "30", NOW);
    expect(result.vsPreviousPeriodPct).toBe(-50);
  });

  it("returns null vsPercent when no previous-period data", () => {
    const current = makeCampaign("2026-05-08", 20000);
    const result = computePeriodStats([current], "30", NOW);
    expect(result.vsPreviousPeriodPct).toBeNull();
  });

  it("returns null vsPercent for 'all' period", () => {
    const c = makeCampaign("2026-05-08", 20000);
    const result = computePeriodStats([c], "all", NOW);
    expect(result.vsPreviousPeriodPct).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computePeriodStats — CI aggregation
// ─────────────────────────────────────────────────────────────────────────────

describe("computePeriodStats — CI aggregation", () => {
  it("aggregates CI bounds when all campaigns have CI data", () => {
    const c1 = makeCampaign("2026-05-08", 10000, { ciLowCents: 8000, ciHighCents: 12000 });
    const c2 = makeCampaign("2026-05-10", 5000,  { ciLowCents: 4000, ciHighCents: 6000 });
    const result = computePeriodStats([c1, c2], "30", NOW);
    expect(result.ciLowCents).toBe(12000);
    expect(result.ciHighCents).toBe(18000);
  });

  it("returns null CI when any campaign has missing CI", () => {
    const c1 = makeCampaign("2026-05-08", 10000, { ciLowCents: 8000, ciHighCents: 12000 });
    const c2 = makeCampaign("2026-05-10", 5000); // no CI
    const result = computePeriodStats([c1, c2], "30", NOW);
    expect(result.ciLowCents).toBeNull();
    expect(result.ciHighCents).toBeNull();
  });

  it("returns null CI for empty result set", () => {
    const result = computePeriodStats([], "30", NOW);
    expect(result.ciLowCents).toBeNull();
    expect(result.ciHighCents).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeForecast
// ─────────────────────────────────────────────────────────────────────────────

describe("computeForecast", () => {
  it("returns hasData=false when no campaigns", () => {
    const result = computeForecast([], NOW);
    expect(result.hasData).toBe(false);
    expect(result.projectedNextMonthCents).toBeNull();
  });

  it("returns hasData=false when no campaign in the last 30 days", () => {
    const old = makeCampaign("2025-01-01", 50000);
    const result = computeForecast([old], NOW);
    expect(result.hasData).toBe(false);
  });

  it("returns the current-period total as the projection", () => {
    const c = makeCampaign("2026-05-08", 40000); // 10 days ago
    const result = computeForecast([c], NOW);
    expect(result.hasData).toBe(true);
    expect(result.projectedNextMonthCents).toBe(40000);
  });

  it("sums multiple current-period campaigns", () => {
    const c1 = makeCampaign("2026-05-08", 20000);
    const c2 = makeCampaign("2026-05-10", 15000);
    const result = computeForecast([c1, c2], NOW);
    expect(result.projectedNextMonthCents).toBe(35000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deriveCampaignHealthRows
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveCampaignHealthRows", () => {
  const label = (slug: string) => slug.replace(/_/g, " ");

  it("returns empty array for empty input", () => {
    expect(deriveCampaignHealthRows([], label, NOW)).toEqual([]);
  });

  it("computes days running from approvedAt", () => {
    const rows = deriveCampaignHealthRows(
      [{ proposalId: "p1", groupSlug: "lapsed_vips", approvedAt: "2026-05-08T12:00:00Z", variantCount: 2 }],
      label,
      NOW,
    );
    expect(rows[0]!.daysRunning).toBe(10);
  });

  it("sets daysRunning=0 when approvedAt is null", () => {
    const rows = deriveCampaignHealthRows(
      [{ proposalId: "p1", groupSlug: "lapsed_vips", approvedAt: null, variantCount: 1 }],
      label,
      NOW,
    );
    expect(rows[0]!.daysRunning).toBe(0);
  });

  it("applies groupLabel via the injected function", () => {
    const rows = deriveCampaignHealthRows(
      [{ proposalId: "p1", groupSlug: "at_risk_regulars", approvedAt: null, variantCount: 1 }],
      (slug) => `LABEL:${slug}`,
      NOW,
    );
    expect(rows[0]!.name).toBe("LABEL:at_risk_regulars");
  });

  it("includes variantCount in the output", () => {
    const rows = deriveCampaignHealthRows(
      [{ proposalId: "p1", groupSlug: "lapsed_vips", approvedAt: null, variantCount: 3 }],
      label,
      NOW,
    );
    expect(rows[0]!.variantCount).toBe(3);
  });

  it("handles multiple rows independently", () => {
    const input = [
      { proposalId: "p1", groupSlug: "a", approvedAt: "2026-05-08T12:00:00Z", variantCount: 2 },
      { proposalId: "p2", groupSlug: "b", approvedAt: "2026-05-13T12:00:00Z", variantCount: 1 },
    ];
    const rows = deriveCampaignHealthRows(input, label, NOW);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.daysRunning).toBe(10);
    expect(rows[1]!.daysRunning).toBe(5);
  });
});
