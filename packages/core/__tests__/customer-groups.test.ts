import { describe, expect, it } from "vitest";
import { assignGroups } from "../src/customer-groups";
import type { CustomerForGrouping, MerchantContext } from "../src/customer-groups";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT: MerchantContext = {
  ltvP90Cents: 50000,   // $500
  ltvP75Cents: 30000,   // $300
  medianLtvCents: 15000, // $150
  medianAovCents: 8000,  // $80
};

function base(overrides: Partial<CustomerForGrouping> = {}): CustomerForGrouping {
  return {
    totalOrderCount: 2,
    totalLtvCents: 12000,
    lastOrderDaysAgo: 90,
    firstOrderDaysAgo: 200,
    lifecycle: "lapsed",
    engagementEventsInPast30Days: 0,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// lapsed_vips
// ─────────────────────────────────────────────────────────────────────────────

describe("lapsed_vips", () => {
  it("assigns lapsed_vips when lapsed and LTV at exactly P90", () => {
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalLtvCents: 50000 }),
      MERCHANT,
    );
    expect(result).toContain("lapsed_vips");
  });

  it("assigns lapsed_vips when lapsed and LTV above P90", () => {
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalLtvCents: 75000 }),
      MERCHANT,
    );
    expect(result).toContain("lapsed_vips");
  });

  it("does NOT assign lapsed_vips when LTV is below P90", () => {
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalLtvCents: 49999 }),
      MERCHANT,
    );
    expect(result).not.toContain("lapsed_vips");
  });

  it("does NOT assign lapsed_vips when lifecycle is not lapsed (even if high LTV)", () => {
    const result = assignGroups(
      base({ lifecycle: "at_risk", totalLtvCents: 60000 }),
      MERCHANT,
    );
    expect(result).not.toContain("lapsed_vips");
  });

  it("does NOT assign lapsed_vips for churned customers even with high LTV", () => {
    const result = assignGroups(
      base({ lifecycle: "churned", totalLtvCents: 60000 }),
      MERCHANT,
    );
    expect(result).not.toContain("lapsed_vips");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// at_risk_regulars
// ─────────────────────────────────────────────────────────────────────────────

describe("at_risk_regulars", () => {
  it("assigns at_risk_regulars when at_risk and exactly 3 orders", () => {
    const result = assignGroups(
      base({ lifecycle: "at_risk", totalOrderCount: 3 }),
      MERCHANT,
    );
    expect(result).toContain("at_risk_regulars");
  });

  it("assigns at_risk_regulars when at_risk and more than 3 orders", () => {
    const result = assignGroups(
      base({ lifecycle: "at_risk", totalOrderCount: 10 }),
      MERCHANT,
    );
    expect(result).toContain("at_risk_regulars");
  });

  it("does NOT assign at_risk_regulars when at_risk but only 2 orders", () => {
    const result = assignGroups(
      base({ lifecycle: "at_risk", totalOrderCount: 2 }),
      MERCHANT,
    );
    expect(result).not.toContain("at_risk_regulars");
  });

  it("does NOT assign at_risk_regulars when lifecycle is not at_risk", () => {
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalOrderCount: 5 }),
      MERCHANT,
    );
    expect(result).not.toContain("at_risk_regulars");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// single_purchase_converters
// ─────────────────────────────────────────────────────────────────────────────

describe("single_purchase_converters", () => {
  it("assigns single_purchase_converters when 1 order, >60 days, LTV above median AOV", () => {
    const result = assignGroups(
      base({
        totalOrderCount: 1,
        lastOrderDaysAgo: 61,
        totalLtvCents: 9000,  // above medianAovCents (8000)
        lifecycle: "lapsed",
      }),
      MERCHANT,
    );
    expect(result).toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters when order is ≤ 60 days ago", () => {
    const result = assignGroups(
      base({
        totalOrderCount: 1,
        lastOrderDaysAgo: 60,
        totalLtvCents: 9000,
        lifecycle: "lapsed",
      }),
      MERCHANT,
    );
    expect(result).not.toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters when 2+ orders", () => {
    const result = assignGroups(
      base({ totalOrderCount: 2, lastOrderDaysAgo: 90, totalLtvCents: 9000 }),
      MERCHANT,
    );
    expect(result).not.toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters when LTV is at or below median AOV", () => {
    const result = assignGroups(
      base({
        totalOrderCount: 1,
        lastOrderDaysAgo: 90,
        totalLtvCents: 8000,  // equal to medianAovCents — not strictly greater
        lifecycle: "lapsed",
      }),
      MERCHANT,
    );
    expect(result).not.toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters when lastOrderDaysAgo is null", () => {
    const result = assignGroups(
      base({ totalOrderCount: 1, lastOrderDaysAgo: null, totalLtvCents: 9000 }),
      MERCHANT,
    );
    expect(result).not.toContain("single_purchase_converters");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// price_sensitive_lapsed
// ─────────────────────────────────────────────────────────────────────────────

describe("price_sensitive_lapsed", () => {
  it("assigns price_sensitive_lapsed when lapsed, ≥2 orders, avg AOV < median", () => {
    // 2 orders, totalLtv = 12000 → avg = 6000 < medianAovCents 8000
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalOrderCount: 2, totalLtvCents: 12000 }),
      MERCHANT,
    );
    expect(result).toContain("price_sensitive_lapsed");
  });

  it("assigns price_sensitive_lapsed with high order count but low avg", () => {
    // 5 orders, totalLtv = 15000 → avg = 3000 < 8000
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalOrderCount: 5, totalLtvCents: 15000 }),
      MERCHANT,
    );
    expect(result).toContain("price_sensitive_lapsed");
  });

  it("does NOT assign price_sensitive_lapsed when avg AOV equals median AOV", () => {
    // avg == medianAovCents (8000) — not strictly less
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalOrderCount: 2, totalLtvCents: 16000 }),
      MERCHANT,
    );
    expect(result).not.toContain("price_sensitive_lapsed");
  });

  it("does NOT assign price_sensitive_lapsed when avg AOV is above median", () => {
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalOrderCount: 2, totalLtvCents: 20000 }),
      MERCHANT,
    );
    expect(result).not.toContain("price_sensitive_lapsed");
  });

  it("does NOT assign price_sensitive_lapsed when only 1 order", () => {
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalOrderCount: 1, totalLtvCents: 5000 }),
      MERCHANT,
    );
    expect(result).not.toContain("price_sensitive_lapsed");
  });

  it("does NOT assign price_sensitive_lapsed when lifecycle is not lapsed", () => {
    const result = assignGroups(
      base({ lifecycle: "churned", totalOrderCount: 3, totalLtvCents: 9000 }),
      MERCHANT,
    );
    expect(result).not.toContain("price_sensitive_lapsed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recent_first_purchasers
// ─────────────────────────────────────────────────────────────────────────────

describe("recent_first_purchasers", () => {
  it("assigns recent_first_purchasers when new and firstOrderDaysAgo exactly 14", () => {
    const result = assignGroups(
      base({ lifecycle: "new", firstOrderDaysAgo: 14 }),
      MERCHANT,
    );
    expect(result).toContain("recent_first_purchasers");
  });

  it("assigns recent_first_purchasers when new and firstOrderDaysAgo > 14", () => {
    const result = assignGroups(
      base({ lifecycle: "new", firstOrderDaysAgo: 28 }),
      MERCHANT,
    );
    expect(result).toContain("recent_first_purchasers");
  });

  it("does NOT assign recent_first_purchasers when firstOrderDaysAgo < 14 (too fresh)", () => {
    const result = assignGroups(
      base({ lifecycle: "new", firstOrderDaysAgo: 13 }),
      MERCHANT,
    );
    expect(result).not.toContain("recent_first_purchasers");
  });

  it("does NOT assign recent_first_purchasers when firstOrderDaysAgo is null", () => {
    const result = assignGroups(
      base({ lifecycle: "new", firstOrderDaysAgo: null }),
      MERCHANT,
    );
    expect(result).not.toContain("recent_first_purchasers");
  });

  it("does NOT assign recent_first_purchasers when lifecycle is not new", () => {
    const result = assignGroups(
      base({ lifecycle: "engaged", firstOrderDaysAgo: 20 }),
      MERCHANT,
    );
    expect(result).not.toContain("recent_first_purchasers");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// win_backs_at_risk
// ─────────────────────────────────────────────────────────────────────────────

describe("win_backs_at_risk", () => {
  it("assigns win_backs_at_risk when won_back and no engagement in past 30 days", () => {
    const result = assignGroups(
      base({ lifecycle: "won_back", engagementEventsInPast30Days: 0 }),
      MERCHANT,
    );
    expect(result).toContain("win_backs_at_risk");
  });

  it("does NOT assign win_backs_at_risk when won_back but has recent engagement", () => {
    const result = assignGroups(
      base({ lifecycle: "won_back", engagementEventsInPast30Days: 1 }),
      MERCHANT,
    );
    expect(result).not.toContain("win_backs_at_risk");
  });

  it("does NOT assign win_backs_at_risk when lifecycle is not won_back", () => {
    const result = assignGroups(
      base({ lifecycle: "at_risk", engagementEventsInPast30Days: 0 }),
      MERCHANT,
    );
    expect(result).not.toContain("win_backs_at_risk");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-group membership
// ─────────────────────────────────────────────────────────────────────────────

describe("multi-group membership", () => {
  it("can belong to both lapsed_vips and price_sensitive_lapsed simultaneously", () => {
    // High LTV but low avg order (many small orders)
    const result = assignGroups(
      base({
        lifecycle: "lapsed",
        totalOrderCount: 20,
        totalLtvCents: 60000,   // above P90 (50000)
        lastOrderDaysAgo: 200,
      }),
      MERCHANT,
    );
    // avg = 60000/20 = 3000 < 8000 → price_sensitive
    // 60000 >= 50000 → lapsed_vip
    expect(result).toContain("lapsed_vips");
    expect(result).toContain("price_sensitive_lapsed");
  });

  it("returns empty array when customer matches no templates", () => {
    const result = assignGroups(
      base({
        lifecycle: "engaged",
        totalOrderCount: 2,
        totalLtvCents: 10000,
        lastOrderDaysAgo: 30,
        firstOrderDaysAgo: 60,
        engagementEventsInPast30Days: 5,
      }),
      MERCHANT,
    );
    expect(result).toHaveLength(0);
  });

  it("returns only matching groups (no false positives in full customer profile)", () => {
    // A churned high-LTV customer should match nothing
    const result = assignGroups(
      base({
        lifecycle: "churned",
        totalOrderCount: 10,
        totalLtvCents: 80000,
        lastOrderDaysAgo: 400,
        engagementEventsInPast30Days: 0,
      }),
      MERCHANT,
    );
    expect(result).toHaveLength(0);
  });

  it("is idempotent — same inputs produce same output array", () => {
    const customer = base({ lifecycle: "lapsed", totalLtvCents: 55000 });
    const first = assignGroups(customer, MERCHANT);
    const second = assignGroups(customer, MERCHANT);
    expect(first).toEqual(second);
  });
});
