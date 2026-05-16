// Unit tests for the campaign display helpers (apps/web/app/app/campaigns/_labels.ts):
// label maps and the pure expected-impact formatting used by the approval
// surface, campaign list, and bandit inspector.

import { describe, it, expect } from "vitest";
import {
  groupLabel,
  offerTypeLabel,
  sendWindowLabel,
  toneLabel,
  readImpact,
  money,
  projectedRange,
  signaturePhrasesUsed,
} from "../app/app/campaigns/_labels";

describe("groupLabel", () => {
  it("maps every known group slug to a merchant-facing label", () => {
    expect(groupLabel("lapsed_vips")).toBe("Lapsed VIPs");
    expect(groupLabel("at_risk_regulars")).toBe("At-risk regulars");
    expect(groupLabel("win_backs_at_risk")).toBe("Win-backs going quiet");
  });

  it("humanizes an unknown slug as a fallback", () => {
    expect(groupLabel("brand_new_group")).toBe("Brand new group");
  });
});

describe("offerTypeLabel / sendWindowLabel / toneLabel", () => {
  it("labels offer types", () => {
    expect(offerTypeLabel("percent_discount")).toBe("Percentage discount");
    expect(offerTypeLabel("free_shipping")).toBe("Free shipping");
  });

  it("labels send-time windows", () => {
    expect(sendWindowLabel("weekend_morning")).toBe("Weekend morning");
    expect(sendWindowLabel("evening")).toBe("Evening");
  });

  it("humanizes tone descriptors", () => {
    expect(toneLabel("warm")).toBe("Warm");
    expect(toneLabel("down_to_earth")).toBe("Down to earth");
  });
});

describe("readImpact", () => {
  it("reads a well-formed expected_impact object", () => {
    expect(readImpact({ estimated_response_rate: 0.12, estimated_recovered_revenue: 900 })).toEqual(
      { rate: 0.12, revenue: 900 },
    );
  });

  it("returns zeros for null, an array, or a non-object", () => {
    expect(readImpact(null)).toEqual({ rate: 0, revenue: 0 });
    expect(readImpact([1, 2])).toEqual({ rate: 0, revenue: 0 });
    expect(readImpact("nope")).toEqual({ rate: 0, revenue: 0 });
  });

  it("returns zeros for non-numeric fields", () => {
    expect(readImpact({ estimated_response_rate: "high", estimated_recovered_revenue: null })).toEqual(
      { rate: 0, revenue: 0 },
    );
  });
});

describe("money", () => {
  it("formats whole currency units with thousands separators", () => {
    expect(money(900)).toBe("$900");
    expect(money(2400)).toBe("$2,400");
  });

  it("rounds fractional input", () => {
    expect(money(1234.7)).toBe("$1,235");
  });
});

describe("projectedRange", () => {
  it("shows a single value when every variant agrees", () => {
    expect(
      projectedRange([
        { estimated_recovered_revenue: 900 },
        { estimated_recovered_revenue: 900 },
        { estimated_recovered_revenue: 900 },
      ]),
    ).toBe("$900");
  });

  it("shows a low–high range when variants differ", () => {
    expect(
      projectedRange([
        { estimated_recovered_revenue: 900 },
        { estimated_recovered_revenue: 2400 },
        { estimated_recovered_revenue: 1500 },
      ]),
    ).toBe("$900–$2,400");
  });

  it("coerces a malformed impact entry to 0", () => {
    expect(
      projectedRange([{ wrong: 1 }, { estimated_recovered_revenue: 500 }]),
    ).toBe("$0–$500");
  });

  it("returns $0 for an empty variant list", () => {
    expect(projectedRange([])).toBe("$0");
  });
});

describe("signaturePhrasesUsed", () => {
  it("returns the brand phrases that appear in the draft (case-insensitive)", () => {
    expect(
      signaturePhrasesUsed("Come back for our SMALL BATCH roast", ["small batch", "hand-poured"]),
    ).toEqual(["small batch"]);
  });

  it("returns an empty array when no brand phrase is used", () => {
    expect(signaturePhrasesUsed("Here is 10% off", ["small batch"])).toEqual([]);
  });

  it("ignores blank phrases", () => {
    expect(signaturePhrasesUsed("anything", ["   ", ""])).toEqual([]);
  });
});
