import { describe, expect, it } from "vitest";
import {
  welchConfidenceInterval,
  studentTCdf,
  studentTQuantile,
} from "../src/stats/welch";

describe("studentTCdf", () => {
  it("is 0.5 at t = 0 for any df", () => {
    expect(studentTCdf(0, 1)).toBeCloseTo(0.5, 9);
    expect(studentTCdf(0, 8)).toBeCloseTo(0.5, 9);
    expect(studentTCdf(0, 1000)).toBeCloseTo(0.5, 9);
  });

  it("is symmetric: F(-t) = 1 - F(t)", () => {
    for (const [t, df] of [[1.5, 5], [2.3, 12], [0.7, 40]] as const) {
      expect(studentTCdf(-t, df)).toBeCloseTo(1 - studentTCdf(t, df), 9);
    }
  });

  it("matches known t-distribution CDF values", () => {
    // df=1 (Cauchy): F(1) = 0.75 exactly.
    expect(studentTCdf(1, 1)).toBeCloseTo(0.75, 6);
    // Large df → standard normal: F(1.96) ≈ 0.975.
    expect(studentTCdf(1.96, 1e6)).toBeCloseTo(0.975, 4);
  });

  it("rejects a non-finite t or a non-positive df", () => {
    expect(() => studentTCdf(NaN, 5)).toThrow(/invalid input/);
    expect(() => studentTCdf(1, 0)).toThrow(/invalid input/);
  });
});

describe("studentTQuantile", () => {
  it("matches textbook two-sided 97.5% critical values", () => {
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.706, 2);
    expect(studentTQuantile(0.975, 8)).toBeCloseTo(2.306, 2);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228, 2);
    expect(studentTQuantile(0.975, 100)).toBeCloseTo(1.984, 2);
  });

  it("converges to the normal quantile 1.96 as df grows", () => {
    expect(studentTQuantile(0.975, 1e7)).toBeCloseTo(1.96, 3);
  });

  it("is symmetric about 0", () => {
    expect(studentTQuantile(0.025, 9)).toBeCloseTo(-studentTQuantile(0.975, 9), 6);
  });

  it("rejects p outside (0,1)", () => {
    expect(() => studentTQuantile(0, 5)).toThrow(/p must be in/);
    expect(() => studentTQuantile(1, 5)).toThrow(/p must be in/);
  });

  it("rejects a non-positive df", () => {
    expect(() => studentTQuantile(0.975, 0)).toThrow(/df must be > 0/);
    expect(() => studentTQuantile(0.975, -2)).toThrow(/df must be > 0/);
  });
});

describe("welchConfidenceInterval", () => {
  it("throws when a sample has fewer than 2 observations", () => {
    expect(() => welchConfidenceInterval([1], [1, 2, 3])).toThrow(/at least 2/);
    expect(() => welchConfidenceInterval([1, 2, 3], [])).toThrow(/at least 2/);
  });

  it("rejects an alpha outside (0,1)", () => {
    expect(() => welchConfidenceInterval([1, 2, 3], [4, 5, 6], 0)).toThrow(/alpha must be in/);
    expect(() => welchConfidenceInterval([1, 2, 3], [4, 5, 6], 1)).toThrow(/alpha must be in/);
  });

  it("computes Welch–Satterthwaite df = 2(n-1) for two equal-variance equal-n samples", () => {
    // Two identical 5-element samples → equal variance, equal n.
    // Welch df reduces to 2(n-1) = 8.
    const sample = [10, 20, 30, 40, 50];
    const r = welchConfidenceInterval(sample, [...sample]);
    expect(r.degreesOfFreedom).toBeCloseTo(8, 6);
    expect(r.meanDifference).toBeCloseTo(0, 9);
    // Symmetric CI around 0.
    expect(r.ciLow).toBeCloseTo(-r.ciHigh, 6);
  });

  it("recovers a known mean difference and brackets it with the CI", () => {
    // a centred on 100, b centred on 50 → true difference 50.
    const a = [90, 95, 100, 105, 110, 100, 98, 102, 96, 104];
    const b = [40, 45, 50, 55, 60, 50, 48, 52, 46, 54];
    const r = welchConfidenceInterval(a, b);
    expect(r.meanDifference).toBeCloseTo(50, 6);
    expect(r.ciLow).toBeLessThan(50);
    expect(r.ciHigh).toBeGreaterThan(50);
    // Identical spread, equal n → df ≈ 2(n-1) = 18.
    expect(r.degreesOfFreedom).toBeCloseTo(18, 6);
  });

  it("uses unequal-variance df — NOT pooled — for samples of different spread and size", () => {
    // a: tight, large n. b: wide, small n. Welch df must lie strictly between
    // min(n1-1, n2-1) and n1+n2-2, and is not the pooled n1+n2-2.
    const a = [10, 11, 9, 10, 12, 8, 10, 11, 9, 10, 10, 10];
    const b = [0, 40, -20, 60, 5];
    const r = welchConfidenceInterval(a, b);
    expect(r.degreesOfFreedom).toBeGreaterThan(3); // > n2-1
    expect(r.degreesOfFreedom).toBeLessThan(a.length + b.length - 2); // < pooled df
  });

  it("collapses the CI to the point estimate when both samples are constant", () => {
    const r = welchConfidenceInterval([500, 500, 500], [200, 200, 200]);
    expect(r.standardError).toBe(0);
    expect(r.meanDifference).toBe(300);
    expect(r.ciLow).toBe(300);
    expect(r.ciHigh).toBe(300);
  });

  it("produces a negative interval when the second sample outperforms the first", () => {
    const a = [10, 12, 8, 11, 9];
    const b = [100, 110, 95, 105, 90];
    const r = welchConfidenceInterval(a, b);
    expect(r.meanDifference).toBeLessThan(0);
    expect(r.ciHigh).toBeLessThan(0); // whole interval below zero
  });

  it("90% interval is narrower than the 95% interval (higher alpha → tighter)", () => {
    const a = [12, 18, 9, 22, 14, 17, 11, 20];
    const b = [3, 8, 1, 12, 5, 9, 2, 10];
    const wide = welchConfidenceInterval(a, b, 0.05);
    const narrow = welchConfidenceInterval(a, b, 0.1);
    expect(narrow.ciHigh - narrow.ciLow).toBeLessThan(wide.ciHigh - wide.ciLow);
  });
});
