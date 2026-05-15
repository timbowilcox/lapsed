import { describe, expect, it } from "vitest";
import { assignGroups } from "../src/customer-groups";
import type { CustomerForGrouping, MerchantContext } from "../src/customer-groups";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures + helpers
// ─────────────────────────────────────────────────────────────────────────────

const MERCHANT: MerchantContext = {
  ltvP90Cents: 50000,  // $500
  medianAovCents: 8000, // $80
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

/** Extract group slugs from the GroupAssignment[] result for readable assertions. */
function slugs(result: ReturnType<typeof assignGroups>): string[] {
  return result.map((g) => g.slug);
}

// ─────────────────────────────────────────────────────────────────────────────
// lapsed_vips
// ─────────────────────────────────────────────────────────────────────────────

describe("lapsed_vips", () => {
  it("assigns lapsed_vips when lapsed and LTV at exactly P90", () => {
    expect(slugs(assignGroups(base({ lifecycle: "lapsed", totalLtvCents: 50000 }), MERCHANT)))
      .toContain("lapsed_vips");
  });

  it("assigns lapsed_vips when lapsed and LTV above P90", () => {
    expect(slugs(assignGroups(base({ lifecycle: "lapsed", totalLtvCents: 75000 }), MERCHANT)))
      .toContain("lapsed_vips");
  });

  it("does NOT assign lapsed_vips when LTV is below P90", () => {
    expect(slugs(assignGroups(base({ lifecycle: "lapsed", totalLtvCents: 49999 }), MERCHANT)))
      .not.toContain("lapsed_vips");
  });

  it("does NOT assign lapsed_vips when lifecycle is at_risk (even if high LTV)", () => {
    expect(slugs(assignGroups(base({ lifecycle: "at_risk", totalLtvCents: 60000 }), MERCHANT)))
      .not.toContain("lapsed_vips");
  });

  it("does NOT assign lapsed_vips for churned customers even with high LTV", () => {
    expect(slugs(assignGroups(base({ lifecycle: "churned", totalLtvCents: 60000 }), MERCHANT)))
      .not.toContain("lapsed_vips");
  });

  it("does NOT assign lapsed_vips for won_back customers even with high LTV", () => {
    expect(slugs(assignGroups(base({ lifecycle: "won_back", totalLtvCents: 60000 }), MERCHANT)))
      .not.toContain("lapsed_vips");
  });

  it("does NOT assign lapsed_vips for new customers even with high LTV", () => {
    expect(slugs(assignGroups(base({ lifecycle: "new", totalLtvCents: 60000 }), MERCHANT)))
      .not.toContain("lapsed_vips");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// at_risk_regulars
// ─────────────────────────────────────────────────────────────────────────────

describe("at_risk_regulars", () => {
  it("assigns at_risk_regulars when at_risk and exactly 3 orders", () => {
    expect(slugs(assignGroups(base({ lifecycle: "at_risk", totalOrderCount: 3 }), MERCHANT)))
      .toContain("at_risk_regulars");
  });

  it("assigns at_risk_regulars when at_risk and more than 3 orders", () => {
    expect(slugs(assignGroups(base({ lifecycle: "at_risk", totalOrderCount: 10 }), MERCHANT)))
      .toContain("at_risk_regulars");
  });

  it("does NOT assign at_risk_regulars when at_risk but only 2 orders", () => {
    expect(slugs(assignGroups(base({ lifecycle: "at_risk", totalOrderCount: 2 }), MERCHANT)))
      .not.toContain("at_risk_regulars");
  });

  it("does NOT assign at_risk_regulars when lifecycle is not at_risk", () => {
    expect(slugs(assignGroups(base({ lifecycle: "lapsed", totalOrderCount: 5 }), MERCHANT)))
      .not.toContain("at_risk_regulars");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// single_purchase_converters
// ─────────────────────────────────────────────────────────────────────────────

describe("single_purchase_converters", () => {
  it("assigns single_purchase_converters when 1 order, >60 days, LTV above median AOV", () => {
    expect(
      slugs(assignGroups(
        base({ totalOrderCount: 1, lastOrderDaysAgo: 61, totalLtvCents: 9000, lifecycle: "lapsed" }),
        MERCHANT,
      )),
    ).toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters when order is exactly 60 days ago", () => {
    expect(
      slugs(assignGroups(
        base({ totalOrderCount: 1, lastOrderDaysAgo: 60, totalLtvCents: 9000, lifecycle: "lapsed" }),
        MERCHANT,
      )),
    ).not.toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters when 2+ orders", () => {
    expect(
      slugs(assignGroups(base({ totalOrderCount: 2, lastOrderDaysAgo: 90, totalLtvCents: 9000 }), MERCHANT)),
    ).not.toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters when LTV is at or below median AOV", () => {
    expect(
      slugs(assignGroups(
        base({ totalOrderCount: 1, lastOrderDaysAgo: 90, totalLtvCents: 8000, lifecycle: "lapsed" }),
        MERCHANT,
      )),
    ).not.toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters when lastOrderDaysAgo is null", () => {
    expect(
      slugs(assignGroups(
        base({ totalOrderCount: 1, lastOrderDaysAgo: null, totalLtvCents: 9000 }),
        MERCHANT,
      )),
    ).not.toContain("single_purchase_converters");
  });

  it("does NOT assign single_purchase_converters for churned customers (unreachable for nudge)", () => {
    expect(
      slugs(assignGroups(
        base({ totalOrderCount: 1, lastOrderDaysAgo: 400, totalLtvCents: 9000, lifecycle: "churned" }),
        MERCHANT,
      )),
    ).not.toContain("single_purchase_converters");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// price_sensitive_lapsed
// ─────────────────────────────────────────────────────────────────────────────

describe("price_sensitive_lapsed", () => {
  it("assigns price_sensitive_lapsed when lapsed, ≥2 orders, avg AOV < median", () => {
    // 2 orders, totalLtv = 12000 → avg = 6000 < medianAovCents 8000
    expect(
      slugs(assignGroups(base({ lifecycle: "lapsed", totalOrderCount: 2, totalLtvCents: 12000 }), MERCHANT)),
    ).toContain("price_sensitive_lapsed");
  });

  it("assigns price_sensitive_lapsed with high order count but low avg", () => {
    // 5 orders, totalLtv = 15000 → avg = 3000 < 8000
    expect(
      slugs(assignGroups(base({ lifecycle: "lapsed", totalOrderCount: 5, totalLtvCents: 15000 }), MERCHANT)),
    ).toContain("price_sensitive_lapsed");
  });

  it("does NOT assign price_sensitive_lapsed when avg AOV equals median AOV (not strictly less)", () => {
    // avg == medianAovCents (8000) — not strictly less
    expect(
      slugs(assignGroups(base({ lifecycle: "lapsed", totalOrderCount: 2, totalLtvCents: 16000 }), MERCHANT)),
    ).not.toContain("price_sensitive_lapsed");
  });

  it("does NOT assign price_sensitive_lapsed when avg AOV is above median", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "lapsed", totalOrderCount: 2, totalLtvCents: 20000 }), MERCHANT)),
    ).not.toContain("price_sensitive_lapsed");
  });

  it("does NOT assign price_sensitive_lapsed when only 1 order", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "lapsed", totalOrderCount: 1, totalLtvCents: 5000 }), MERCHANT)),
    ).not.toContain("price_sensitive_lapsed");
  });

  it("does NOT assign price_sensitive_lapsed when lifecycle is not lapsed", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "churned", totalOrderCount: 3, totalLtvCents: 9000 }), MERCHANT)),
    ).not.toContain("price_sensitive_lapsed");
  });

  it("does NOT assign when avg rounds up to exactly median AOV via Math.round", () => {
    // 23999 / 3 = 7999.666... → Math.round → 8000 = medianAovCents → NOT < median
    expect(
      slugs(assignGroups(base({ lifecycle: "lapsed", totalOrderCount: 3, totalLtvCents: 23999 }), MERCHANT)),
    ).not.toContain("price_sensitive_lapsed");
  });

  it("assigns when avg rounds down below median AOV via Math.round", () => {
    // 23998 / 3 = 7999.333... → Math.round → 7999 < 8000 → assigns
    expect(
      slugs(assignGroups(base({ lifecycle: "lapsed", totalOrderCount: 3, totalLtvCents: 23998 }), MERCHANT)),
    ).toContain("price_sensitive_lapsed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recent_first_purchasers
// ─────────────────────────────────────────────────────────────────────────────

describe("recent_first_purchasers", () => {
  it("assigns recent_first_purchasers when new and firstOrderDaysAgo exactly 14", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "new", firstOrderDaysAgo: 14 }), MERCHANT)),
    ).toContain("recent_first_purchasers");
  });

  it("assigns recent_first_purchasers when new and firstOrderDaysAgo > 14", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "new", firstOrderDaysAgo: 28 }), MERCHANT)),
    ).toContain("recent_first_purchasers");
  });

  it("does NOT assign recent_first_purchasers when firstOrderDaysAgo < 14 (too fresh)", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "new", firstOrderDaysAgo: 13 }), MERCHANT)),
    ).not.toContain("recent_first_purchasers");
  });

  it("does NOT assign recent_first_purchasers when firstOrderDaysAgo is null", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "new", firstOrderDaysAgo: null }), MERCHANT)),
    ).not.toContain("recent_first_purchasers");
  });

  it("does NOT assign recent_first_purchasers when lifecycle is not new", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "engaged", firstOrderDaysAgo: 20 }), MERCHANT)),
    ).not.toContain("recent_first_purchasers");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// win_backs_at_risk
// ─────────────────────────────────────────────────────────────────────────────

describe("win_backs_at_risk", () => {
  it("assigns win_backs_at_risk when won_back and no engagement in past 30 days", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "won_back", engagementEventsInPast30Days: 0 }), MERCHANT)),
    ).toContain("win_backs_at_risk");
  });

  it("does NOT assign win_backs_at_risk when won_back but has recent engagement", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "won_back", engagementEventsInPast30Days: 1 }), MERCHANT)),
    ).not.toContain("win_backs_at_risk");
  });

  it("does NOT assign win_backs_at_risk when lifecycle is not won_back", () => {
    expect(
      slugs(assignGroups(base({ lifecycle: "at_risk", engagementEventsInPast30Days: 0 }), MERCHANT)),
    ).not.toContain("win_backs_at_risk");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-group membership and edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("multi-group membership and edge cases", () => {
  it("can belong to both lapsed_vips and price_sensitive_lapsed simultaneously", () => {
    // High LTV but low avg order (many small orders)
    const result = slugs(assignGroups(
      base({ lifecycle: "lapsed", totalOrderCount: 20, totalLtvCents: 60000, lastOrderDaysAgo: 200 }),
      MERCHANT,
    ));
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

  it("churned high-LTV customer belongs to no groups", () => {
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
    const first = slugs(assignGroups(customer, MERCHANT));
    const second = slugs(assignGroups(customer, MERCHANT));
    expect(first).toEqual(second);
  });

  it("returns GroupAssignment objects with confidence: 1 for each match", () => {
    const result = assignGroups(
      base({ lifecycle: "lapsed", totalLtvCents: 55000 }),
      MERCHANT,
    );
    expect(result.length).toBeGreaterThan(0);
    for (const g of result) {
      expect(g.confidence).toBe(1);
      expect(typeof g.slug).toBe("string");
    }
  });

  it("customer with zero orders belongs to no groups and does not throw", () => {
    const result = assignGroups(
      base({ totalOrderCount: 0, totalLtvCents: 0, lifecycle: "lapsed" }),
      MERCHANT,
    );
    // avgOrderValueCents = 0, totalOrderCount = 0 → fails >= 2 guard on price_sensitive
    expect(result).toHaveLength(0);
  });
});
