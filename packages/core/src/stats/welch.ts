// Welch's t-test — Sprint 08 chunk 6.
//
// Welch's unequal-variances t-test is the basis of the incremental-revenue
// confidence interval. Treatment and holdout cohorts have different sizes AND
// different revenue variances, so the pooled-variance Student's t-test is
// invalid here — Welch is the correct, standard tool.
//
// This is a hand-rolled implementation (no stats dependency). The two pieces
// that need care:
//   1. Welch–Satterthwaite degrees of freedom — the exact formula, NOT a
//      pooled-variance approximation and NOT an equal-n simplification.
//   2. The two-sided t critical value — the inverse Student-t CDF, obtained
//      from the regularized incomplete beta function (the t CDF expressed via
//      I_x, Abramowitz & Stegun 26.7.1) and bisection. Not a normal-quantile
//      shortcut — that would be wrong for the small-ish dfs this sees.
//
// Correctness is verified two ways: unit tests against textbook worked
// examples, and a Monte-Carlo coverage test in chunk 12 (the 95% CI must
// bracket the true mean difference in ≈ 95% of runs).

import { regularizedIncompleteBeta } from "../bandit";

export interface WelchResult {
  /** Sample mean of the first sample (treatment). */
  meanA: number;
  /** Sample mean of the second sample (holdout). */
  meanB: number;
  /** meanA − meanB — the point estimate of the difference. */
  meanDifference: number;
  /** Standard error of the difference: sqrt(s²₁/n₁ + s²₂/n₂). */
  standardError: number;
  /** Welch–Satterthwaite degrees of freedom. */
  degreesOfFreedom: number;
  /** Two-sided t critical value at the requested confidence level. */
  tCritical: number;
  /** Lower bound of the confidence interval for the mean difference. */
  ciLow: number;
  /** Upper bound of the confidence interval for the mean difference. */
  ciHigh: number;
  /** Confidence level, e.g. 0.95 for alpha = 0.05. */
  confidenceLevel: number;
}

/** Arithmetic mean. Caller guarantees a non-empty array. */
function mean(xs: readonly number[]): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Sample variance with the (n − 1) Bessel-corrected denominator. */
function sampleVariance(xs: readonly number[], m: number): number {
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return ss / (xs.length - 1);
}

/**
 * CDF of Student's t-distribution with `df` degrees of freedom, evaluated at
 * `t`. Uses the regularized incomplete beta identity:
 *   F(t) = 1 − ½·I_x(df/2, ½)  for t ≥ 0,   with x = df / (df + t²)
 * and the reflection F(−t) = 1 − F(t).
 */
export function studentTCdf(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) {
    throw new Error(`studentTCdf: invalid input t=${t} df=${df}`);
  }
  const x = df / (df + t * t);
  const halfIb = 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - halfIb : halfIb;
}

/**
 * Inverse CDF (quantile) of Student's t-distribution: the `t` such that
 * `studentTCdf(t, df) === p`. Found by bisection on the monotone CDF.
 * Symmetric: a left-tail probability reflects the right-tail quantile.
 */
export function studentTQuantile(p: number, df: number): number {
  if (p <= 0 || p >= 1) throw new Error(`studentTQuantile: p must be in (0,1), got ${p}`);
  if (df <= 0) throw new Error(`studentTQuantile: df must be > 0, got ${df}`);
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);

  // p > 0.5 → t > 0. The t-quantile is bounded well below 1e4 for any df ≥ 1
  // at the confidence levels used here (df = 1, p = 0.9995 → t ≈ 636).
  let lo = 0;
  let hi = 1e4;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

/**
 * Welch's t-test confidence interval for the difference in means between two
 * independent samples (`a` − `b`).
 *
 * @param a     first sample (treatment per-customer revenue)
 * @param b     second sample (holdout per-customer revenue)
 * @param alpha significance level; the CI is at the (1 − alpha) level. Default
 *              0.05 → a 95% interval.
 *
 * Throws if either sample has fewer than 2 observations (variance undefined).
 * Callers gate on the 30-per-cohort insufficient-evidence threshold before
 * reaching this function.
 */
export function welchConfidenceInterval(
  a: readonly number[],
  b: readonly number[],
  alpha = 0.05,
): WelchResult {
  if (a.length < 2 || b.length < 2) {
    throw new Error("welchConfidenceInterval: each sample needs at least 2 observations");
  }
  if (alpha <= 0 || alpha >= 1) {
    throw new Error(`welchConfidenceInterval: alpha must be in (0,1), got ${alpha}`);
  }

  const n1 = a.length;
  const n2 = b.length;
  const m1 = mean(a);
  const m2 = mean(b);
  const v1 = sampleVariance(a, m1);
  const v2 = sampleVariance(b, m2);
  const meanDifference = m1 - m2;

  // Standard error of the difference under unequal variances.
  const term1 = v1 / n1;
  const term2 = v2 / n2;
  const standardError = Math.sqrt(term1 + term2);
  const confidenceLevel = 1 - alpha;

  // Degenerate case: both samples are constant (zero variance). The difference
  // is then known exactly — the CI collapses to the point estimate.
  if (standardError === 0) {
    return {
      meanA: m1,
      meanB: m2,
      meanDifference,
      standardError: 0,
      degreesOfFreedom: Infinity,
      tCritical: 0,
      ciLow: meanDifference,
      ciHigh: meanDifference,
      confidenceLevel,
    };
  }

  // Welch–Satterthwaite degrees of freedom — the exact formula.
  const degreesOfFreedom =
    Math.pow(term1 + term2, 2) /
    (Math.pow(term1, 2) / (n1 - 1) + Math.pow(term2, 2) / (n2 - 1));

  const tCritical = studentTQuantile(1 - alpha / 2, degreesOfFreedom);
  const margin = tCritical * standardError;

  return {
    meanA: m1,
    meanB: m2,
    meanDifference,
    standardError,
    degreesOfFreedom,
    tCritical,
    ciLow: meanDifference - margin,
    ciHigh: meanDifference + margin,
    confidenceLevel,
  };
}
