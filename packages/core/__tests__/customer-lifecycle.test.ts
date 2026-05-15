/**
 * Unit tests for classifyLifecycle.
 *
 * Verifies that all six lifecycle stages are reachable from realistic inputs,
 * that stage transitions follow the documented rules, and that the function
 * is idempotent (same input → same output).
 *
 * NOTE: test descriptions are not subject to vocabulary rules — "segment",
 * "cohort", etc. are acceptable in test strings (PRODUCT.md code exception).
 */

import { describe, expect, it } from "vitest";
import { classifyLifecycle } from "../src/customer-lifecycle";
import type { CustomerSnapshot } from "../src/customer-lifecycle";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const base: CustomerSnapshot = {
  totalOrderCount: 1,
  lastOrderDaysAgo: 100,
  firstOrderDaysAgo: 100,
  ordersInPast12Months: 1,
  previousLifecycleStage: null,
  daysSinceLastScoredAsLapsed: null,
  engagementEventsInPast180Days: 0,
};

function snap(overrides: Partial<CustomerSnapshot>): CustomerSnapshot {
  return { ...base, ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage: new
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyLifecycle — new", () => {
  it("classifies as new when first order ≤ 30 days ago and exactly 1 order", () => {
    expect(
      classifyLifecycle(snap({ totalOrderCount: 1, lastOrderDaysAgo: 10, firstOrderDaysAgo: 10 })),
    ).toBe("new");
  });

  it("classifies as new at the 30-day boundary (exactly 30)", () => {
    expect(
      classifyLifecycle(snap({ totalOrderCount: 1, lastOrderDaysAgo: 30, firstOrderDaysAgo: 30 })),
    ).toBe("new");
  });

  it("does NOT classify as new when first order is 31 days ago", () => {
    const result = classifyLifecycle(
      snap({ totalOrderCount: 1, lastOrderDaysAgo: 31, firstOrderDaysAgo: 31 }),
    );
    expect(result).not.toBe("new");
  });

  it("does NOT classify as new when there are 2+ orders (even if recent)", () => {
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 2,
        lastOrderDaysAgo: 10,
        firstOrderDaysAgo: 10,
        ordersInPast12Months: 2,
      }),
    );
    expect(result).not.toBe("new");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage: engaged
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyLifecycle — engaged", () => {
  it("classifies as engaged when last order ≤ 60 days and ≥ 2 orders in past 12 months", () => {
    expect(
      classifyLifecycle(
        snap({ totalOrderCount: 3, lastOrderDaysAgo: 30, firstOrderDaysAgo: 120, ordersInPast12Months: 3 }),
      ),
    ).toBe("engaged");
  });

  it("classifies as engaged at the 60-day boundary (exactly 60)", () => {
    expect(
      classifyLifecycle(
        snap({ totalOrderCount: 2, lastOrderDaysAgo: 60, firstOrderDaysAgo: 200, ordersInPast12Months: 2 }),
      ),
    ).toBe("engaged");
  });

  it("does NOT classify as engaged when last order is 61 days ago", () => {
    const result = classifyLifecycle(
      snap({ totalOrderCount: 5, lastOrderDaysAgo: 61, firstOrderDaysAgo: 300, ordersInPast12Months: 5 }),
    );
    expect(result).not.toBe("engaged");
  });

  it("does NOT classify as engaged when fewer than 2 orders in past 12 months", () => {
    const result = classifyLifecycle(
      snap({ totalOrderCount: 5, lastOrderDaysAgo: 30, firstOrderDaysAgo: 500, ordersInPast12Months: 1 }),
    );
    expect(result).not.toBe("engaged");
  });

  it("returns engaged for a high-frequency recent buyer", () => {
    expect(
      classifyLifecycle(
        snap({ totalOrderCount: 12, lastOrderDaysAgo: 5, firstOrderDaysAgo: 365, ordersInPast12Months: 12 }),
      ),
    ).toBe("engaged");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage: at_risk
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyLifecycle — at_risk", () => {
  it("classifies as at_risk when 60–180 days since last order and previously engaged", () => {
    expect(
      classifyLifecycle(
        snap({
          totalOrderCount: 4,
          lastOrderDaysAgo: 90,
          firstOrderDaysAgo: 400,
          ordersInPast12Months: 4,
          previousLifecycleStage: "engaged",
        }),
      ),
    ).toBe("at_risk");
  });

  it("classifies as at_risk at the 61-day lower boundary", () => {
    expect(
      classifyLifecycle(
        snap({
          totalOrderCount: 3,
          lastOrderDaysAgo: 61,
          firstOrderDaysAgo: 300,
          ordersInPast12Months: 3,
          previousLifecycleStage: "engaged",
        }),
      ),
    ).toBe("at_risk");
  });

  it("classifies as at_risk at the 180-day upper boundary", () => {
    expect(
      classifyLifecycle(
        snap({
          totalOrderCount: 3,
          lastOrderDaysAgo: 180,
          firstOrderDaysAgo: 400,
          ordersInPast12Months: 2,
          previousLifecycleStage: "engaged",
        }),
      ),
    ).toBe("at_risk");
  });

  it("does NOT classify as at_risk without prior engaged stage (falls through to lapsed)", () => {
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 3,
        lastOrderDaysAgo: 90,
        firstOrderDaysAgo: 300,
        ordersInPast12Months: 3,
        previousLifecycleStage: null,
      }),
    );
    expect(result).not.toBe("at_risk");
  });

  it("does NOT classify as at_risk when lastOrderDaysAgo > 180", () => {
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 3,
        lastOrderDaysAgo: 181,
        firstOrderDaysAgo: 400,
        ordersInPast12Months: 2,
        previousLifecycleStage: "engaged",
      }),
    );
    expect(result).not.toBe("at_risk");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage: lapsed
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyLifecycle — lapsed", () => {
  it("classifies as lapsed when last order > 180 days ago", () => {
    expect(
      classifyLifecycle(snap({ totalOrderCount: 2, lastOrderDaysAgo: 200, firstOrderDaysAgo: 400 })),
    ).toBe("lapsed");
  });

  it("classifies as lapsed at exactly 181 days", () => {
    expect(
      classifyLifecycle(snap({ totalOrderCount: 1, lastOrderDaysAgo: 181, firstOrderDaysAgo: 181 })),
    ).toBe("lapsed");
  });

  it("classifies as lapsed for single-purchase customer > 30 days ago (fallback rule)", () => {
    expect(
      classifyLifecycle(
        snap({ totalOrderCount: 1, lastOrderDaysAgo: 90, firstOrderDaysAgo: 90, ordersInPast12Months: 1 }),
      ),
    ).toBe("lapsed");
  });

  it("classifies as lapsed when no orders", () => {
    expect(
      classifyLifecycle(
        snap({ totalOrderCount: 0, lastOrderDaysAgo: null, firstOrderDaysAgo: null, ordersInPast12Months: 0 }),
      ),
    ).toBe("lapsed");
  });

  it("classifies as lapsed when lastOrderDaysAgo is null", () => {
    expect(
      classifyLifecycle(snap({ lastOrderDaysAgo: null, firstOrderDaysAgo: null, totalOrderCount: 0 })),
    ).toBe("lapsed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage: churned
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyLifecycle — churned", () => {
  it("classifies as churned when last order > 365 days ago and no engagement events in 180 days", () => {
    expect(
      classifyLifecycle(
        snap({
          totalOrderCount: 2,
          lastOrderDaysAgo: 400,
          firstOrderDaysAgo: 600,
          ordersInPast12Months: 0,
          engagementEventsInPast180Days: 0,
        }),
      ),
    ).toBe("churned");
  });

  it("classifies as churned at exactly 366 days with no engagement", () => {
    expect(
      classifyLifecycle(
        snap({
          totalOrderCount: 1,
          lastOrderDaysAgo: 366,
          firstOrderDaysAgo: 366,
          ordersInPast12Months: 0,
          engagementEventsInPast180Days: 0,
        }),
      ),
    ).toBe("churned");
  });

  it("does NOT classify as churned when 365 days (exactly on boundary — use lapsed)", () => {
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 2,
        lastOrderDaysAgo: 365,
        firstOrderDaysAgo: 600,
        ordersInPast12Months: 0,
        engagementEventsInPast180Days: 0,
      }),
    );
    expect(result).not.toBe("churned");
    expect(result).toBe("lapsed");
  });

  it("does NOT classify as churned when last order > 365 but engagement events exist", () => {
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 2,
        lastOrderDaysAgo: 400,
        firstOrderDaysAgo: 600,
        ordersInPast12Months: 0,
        engagementEventsInPast180Days: 3,
      }),
    );
    expect(result).not.toBe("churned");
    expect(result).toBe("lapsed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stage: won_back
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyLifecycle — won_back", () => {
  it("classifies as won_back when currently engaged AND was lapsed within past 90 days", () => {
    expect(
      classifyLifecycle(
        snap({
          totalOrderCount: 3,
          lastOrderDaysAgo: 20,
          firstOrderDaysAgo: 300,
          ordersInPast12Months: 3,
          previousLifecycleStage: "lapsed",
          daysSinceLastScoredAsLapsed: 30,
        }),
      ),
    ).toBe("won_back");
  });

  it("classifies as won_back at the 90-day boundary", () => {
    expect(
      classifyLifecycle(
        snap({
          totalOrderCount: 2,
          lastOrderDaysAgo: 10,
          firstOrderDaysAgo: 400,
          ordersInPast12Months: 2,
          previousLifecycleStage: "lapsed",
          daysSinceLastScoredAsLapsed: 90,
        }),
      ),
    ).toBe("won_back");
  });

  it("does NOT classify as won_back when lapsed classification was > 90 days ago", () => {
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 2,
        lastOrderDaysAgo: 10,
        firstOrderDaysAgo: 400,
        ordersInPast12Months: 2,
        previousLifecycleStage: "lapsed",
        daysSinceLastScoredAsLapsed: 91,
      }),
    );
    expect(result).not.toBe("won_back");
    expect(result).toBe("engaged");
  });

  it("does NOT classify as won_back when daysSinceLastScoredAsLapsed is null", () => {
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 2,
        lastOrderDaysAgo: 10,
        firstOrderDaysAgo: 400,
        ordersInPast12Months: 2,
        previousLifecycleStage: "lapsed",
        daysSinceLastScoredAsLapsed: null,
      }),
    );
    expect(result).not.toBe("won_back");
    expect(result).toBe("engaged");
  });

  it("does NOT classify as won_back when base stage is not engaged (re-ordered but still at_risk)", () => {
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 2,
        lastOrderDaysAgo: 90,
        firstOrderDaysAgo: 400,
        ordersInPast12Months: 1,
        previousLifecycleStage: "lapsed",
        daysSinceLastScoredAsLapsed: 30,
      }),
    );
    expect(result).not.toBe("won_back");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyLifecycle — idempotency", () => {
  const testCases: CustomerSnapshot[] = [
    snap({ totalOrderCount: 1, lastOrderDaysAgo: 10, firstOrderDaysAgo: 10 }),
    snap({ totalOrderCount: 3, lastOrderDaysAgo: 30, firstOrderDaysAgo: 200, ordersInPast12Months: 3 }),
    snap({ totalOrderCount: 2, lastOrderDaysAgo: 200, firstOrderDaysAgo: 400 }),
    snap({ totalOrderCount: 2, lastOrderDaysAgo: 400, firstOrderDaysAgo: 600, engagementEventsInPast180Days: 0 }),
    snap({
      totalOrderCount: 3,
      lastOrderDaysAgo: 20,
      firstOrderDaysAgo: 300,
      ordersInPast12Months: 3,
      previousLifecycleStage: "lapsed",
      daysSinceLastScoredAsLapsed: 30,
    }),
  ];

  for (const tc of testCases) {
    it(`produces the same result on second call for snapshot with lastOrderDaysAgo=${tc.lastOrderDaysAgo ?? "null"}`, () => {
      const first = classifyLifecycle(tc);
      const second = classifyLifecycle(tc);
      expect(first).toBe(second);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyLifecycle — edge cases", () => {
  it("handles a customer with 0 orders (null dates)", () => {
    expect(
      classifyLifecycle(
        snap({ totalOrderCount: 0, lastOrderDaysAgo: null, firstOrderDaysAgo: null, ordersInPast12Months: 0 }),
      ),
    ).toBe("lapsed");
  });

  it("handles a customer whose first order is today (0 days ago)", () => {
    expect(
      classifyLifecycle(snap({ totalOrderCount: 1, lastOrderDaysAgo: 0, firstOrderDaysAgo: 0 })),
    ).toBe("new");
  });

  it("does not churn a customer who had a purchase 364 days ago with no engagement", () => {
    expect(
      classifyLifecycle(
        snap({
          totalOrderCount: 1,
          lastOrderDaysAgo: 364,
          firstOrderDaysAgo: 364,
          engagementEventsInPast180Days: 0,
        }),
      ),
    ).toBe("lapsed");
  });

  it("at_risk customer with won_back check short-circuits correctly", () => {
    // previousLifecycleStage = engaged (for at_risk), not lapsed → no won_back
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 3,
        lastOrderDaysAgo: 90,
        firstOrderDaysAgo: 300,
        ordersInPast12Months: 3,
        previousLifecycleStage: "engaged",
        daysSinceLastScoredAsLapsed: 30,
      }),
    );
    expect(result).toBe("at_risk");
  });

  it("won_back customer cannot be churned — churned check evaluates first but won_back wins", () => {
    // lastOrderDaysAgo 400 > 365 + engagement = 0 → would churn, but now they just ordered
    // Scenario: they ordered again at 10 days ago → churned check fails because lastOrderDaysAgo = 10
    const result = classifyLifecycle(
      snap({
        totalOrderCount: 2,
        lastOrderDaysAgo: 10,
        firstOrderDaysAgo: 400,
        ordersInPast12Months: 2,
        engagementEventsInPast180Days: 1,
        previousLifecycleStage: "lapsed",
        daysSinceLastScoredAsLapsed: 15,
      }),
    );
    expect(result).toBe("won_back");
  });
});
