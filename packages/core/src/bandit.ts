// Bandit state — Thompson-sampling Beta posteriors per campaign arm.
// Implements architectural decision 4 (bandit state is a first-class data
// structure). Campaign generation reads from and writes to bandit state;
// A/B logic that bypasses it is a violation.
//
// Each campaign arm carries a Beta(alpha, beta) posterior over its response
// rate. Arms are initialized at the neutral Beta(1,1) prior when a proposal
// is approved (decision 14 — the arm's identity is fixed at that point; only
// its posterior statistics move thereafter). Thompson sampling draws one
// sample from each arm's posterior and selects the arm with the highest draw,
// balancing exploration and exploitation without a hand-tuned epsilon.
//
// `updatePosterior` is the writer Sprint 07 calls when real responses land.
// It is NOT exercised during Sprint 06 (no sends yet) but is implemented and
// tested here so Sprint 07 can wire it in without touching this module.
//
// All sampling is deterministic given a `seed`, so campaign-selection runs
// are reproducible and unit-testable.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";

// ─────────────────────────────────────────────────────────────────────────────
// Bandit state shape
// ─────────────────────────────────────────────────────────────────────────────

export interface BanditState {
  /** bandit_arm_id from campaign_arms — the stable arm identity. */
  armId: string;
  merchantId: string;
  proposalId: string;
  /** Beta posterior alpha (successes + 1). Starts at 1. */
  alpha: number;
  /** Beta posterior beta (failures + 1). Starts at 1. */
  beta: number;
  /** Number of real observations folded into the posterior. Starts at 0. */
  observationCount: number;
  lastUpdatedAt: string;
}

/** The neutral prior every arm is initialized with: Beta(1,1) = Uniform(0,1). */
export const NEUTRAL_PRIOR = { alpha: 1, beta: 1 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG (mulberry32) + variate generators
// ─────────────────────────────────────────────────────────────────────────────

/** A function returning a float in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32 — a fast, well-distributed seedable PRNG. Given the same seed it
 * produces the same stream, which is what makes thompsonSample reproducible.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal variate via the Box-Muller transform. */
function sampleNormal(rng: Rng): number {
  // u1 is kept strictly > 0 so log(u1) is finite.
  let u1 = rng();
  while (u1 <= 0) u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Samples from Gamma(shape, 1) via the Marsaglia-Tsang method. Handles
 * shape >= 1 directly and shape < 1 via the standard boost
 * Gamma(a) = Gamma(a+1) * U^(1/a). In this system shape is always a positive
 * integer (alpha/beta start at 1 and increment by 1 per observation), so the
 * shape < 1 branch is defensive only.
 */
function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    let u = rng();
    while (u <= 0) u = rng();
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded-iteration rejection loop. Acceptance probability is high
  // (> 95% per iteration for shape >= 1); the cap is a paranoia backstop.
  for (let i = 0; i < 1000; i++) {
    let x = 0;
    let v = 0;
    do {
      x = sampleNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    // 0.0331 is the Marsaglia-Tsang (2000) squeeze constant — accepts the
    // common case without evaluating the costlier log test below.
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  // Unreachable for shape >= 1 in practice. Throwing (rather than returning a
  // plausible-but-wrong fallback) ensures a statistical-engine fault surfaces
  // loudly instead of silently corrupting an arm selection.
  throw new Error(`sampleGamma: rejection loop exhausted for shape=${shape}`);
}

/**
 * Samples from Beta(alpha, beta) using the ratio of two Gamma variates:
 * X ~ Gamma(alpha), Y ~ Gamma(beta), Beta = X / (X + Y). Pure given `rng`.
 */
export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const sum = x + y;
  // sum is > 0 with probability 1 for alpha, beta >= 1; guard the degenerate
  // floating-point case rather than emit NaN.
  return sum > 0 ? x / sum : 0.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// Thompson sampling
// ─────────────────────────────────────────────────────────────────────────────

export interface ThompsonSampleOptions {
  /** Seed for reproducible selection. Omit to use Math.random. */
  seed?: number;
}

/** FNV-1a hash of a string to a 32-bit unsigned integer. */
function hashArmId(armId: string): number {
  let h = 2166136261;
  for (let i = 0; i < armId.length; i++) {
    h ^= armId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Draws one sample from each arm's Beta posterior and returns the `armId` of
 * the arm with the highest draw — the Thompson-sampling arm-selection rule.
 *
 * Deterministic given `opts.seed`: each arm is sampled from its own PRNG
 * stream seeded by `seed XOR hash(armId)`, so a selection is reproducible
 * from `(seed, each arm's armId + alpha + beta)` ALONE — it does not depend
 * on arm array order, and changing one arm's posterior does not perturb the
 * draws of the others. Arms are scanned in array order, so an exact
 * floating-point tie (vanishingly improbable) resolves to the earlier arm.
 *
 * Throws if `arms` is empty — a campaign with no arms cannot be sampled.
 */
export function thompsonSample(
  arms: readonly BanditState[],
  opts: ThompsonSampleOptions = {},
): string {
  if (arms.length === 0) {
    throw new Error("thompsonSample: cannot sample from an empty arm set");
  }

  let bestArmId = arms[0]!.armId;
  let bestSample = -Infinity;
  for (const arm of arms) {
    const rng: Rng =
      opts.seed !== undefined
        ? mulberry32((opts.seed ^ hashArmId(arm.armId)) >>> 0)
        : Math.random;
    const draw = sampleBeta(arm.alpha, arm.beta, rng);
    if (draw > bestSample) {
      bestSample = draw;
      bestArmId = arm.armId;
    }
  }
  return bestArmId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Posterior statistics — mean + credible interval (consumed by the chunk-11
// bandit inspector; pure functions kept here with the rest of the bandit math)
// ─────────────────────────────────────────────────────────────────────────────

/** Beta(alpha, beta) posterior mean = alpha / (alpha + beta). */
export function betaMean(alpha: number, beta: number): number {
  return alpha / (alpha + beta);
}

/** Beta(alpha, beta) posterior variance. */
export function betaVariance(alpha: number, beta: number): number {
  const s = alpha + beta;
  return (alpha * beta) / (s * s * (s + 1));
}

// Lanczos approximation of ln(Γ(x)) — used by the regularized incomplete
// beta function for the credible-interval quantile.
const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lnGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const z = x - 1;
  let a = LANCZOS_C[0]!;
  const t = z + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) {
    a += LANCZOS_C[i]! / (z + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued-fraction expansion for the incomplete beta function (Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    result *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 1e-12) break;
  }
  return result;
}

/**
 * Regularized incomplete beta function I_x(a, b) — the CDF of Beta(a, b).
 * Pure. Returns a probability in [0, 1].
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront =
    lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lnFront);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Inverse CDF (quantile) of Beta(a, b) at probability `p`, found by bisection
 * on the regularized incomplete beta function. Accurate to ~1e-9.
 */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(mid, a, b) < p) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-9) break;
  }
  return (lo + hi) / 2;
}

export interface PosteriorStats {
  mean: number;
  /** Lower bound of the central credible interval. */
  ciLower: number;
  /** Upper bound of the central credible interval. */
  ciUpper: number;
}

/**
 * Posterior summary for a Beta(alpha, beta) arm: the mean response rate and a
 * central credible interval (default 95%). Consumed by the bandit-state
 * inspector so merchants see the actual posterior, not a marketing number.
 */
export function posteriorStats(
  alpha: number,
  beta: number,
  level = 0.95,
): PosteriorStats {
  const tail = (1 - level) / 2;
  return {
    mean: betaMean(alpha, beta),
    ciLower: betaQuantile(tail, alpha, beta),
    ciUpper: betaQuantile(1 - tail, alpha, beta),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// bandit_state persistence
// ─────────────────────────────────────────────────────────────────────────────

const InitializeBanditArmInputSchema = z.object({
  armId: z.string().uuid("armId must be a UUID"),
  merchantId: z.string().uuid("merchantId must be a UUID"),
  proposalId: z.string().uuid("proposalId must be a UUID"),
});

export type InitializeBanditArmInput = z.infer<typeof InitializeBanditArmInputSchema>;

interface BanditStateRow {
  arm_id: string;
  merchant_id: string;
  proposal_id: string;
  alpha: number;
  beta: number;
  observation_count: number;
  last_updated_at: string;
}

const BANDIT_STATE_COLUMNS =
  "arm_id, merchant_id, proposal_id, alpha, beta, observation_count, last_updated_at";

function toBanditState(row: BanditStateRow): BanditState {
  return {
    armId: row.arm_id,
    merchantId: row.merchant_id,
    proposalId: row.proposal_id,
    alpha: row.alpha,
    beta: row.beta,
    observationCount: row.observation_count,
    lastUpdatedAt: row.last_updated_at,
  };
}

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

/**
 * Converts a row to BanditState after asserting it belongs to the expected
 * merchant + proposal. A divergence means the arm_id was re-used across
 * tenants/proposals — a caller bug that must fail loudly, not silently return
 * another tenant's posterior.
 */
function assertTenancyAndConvert(row: BanditStateRow, v: InitializeBanditArmInput): BanditState {
  if (row.merchant_id !== v.merchantId || row.proposal_id !== v.proposalId) {
    throw new Error(
      `initializeBanditArm: arm ${v.armId} already belongs to a different merchant/proposal`,
    );
  }
  return toBanditState(row);
}

async function readBanditRow(
  serviceClient: LapsedSupabaseClient,
  armId: string,
): Promise<BanditStateRow | null> {
  const { data, error } = await serviceClient
    .from("bandit_state")
    .select(BANDIT_STATE_COLUMNS)
    .eq("arm_id", armId)
    .maybeSingle();
  if (error) throw error;
  return (data as BanditStateRow | null) ?? null;
}

/**
 * Writes the neutral Beta(1,1) prior for a campaign arm to `bandit_state`.
 * Called at proposal approval (decision 14 — arms are initialized in
 * bandit_state once the proposal is approved).
 *
 * Read-first: if the arm already has a row, it is returned UNTOUCHED — the
 * neutral prior is never sent over a live posterior, so this function cannot
 * reset an arm Sprint 07 has already updated (decision 14). Only when no row
 * exists is the prior inserted. A concurrent insert that races between the
 * read and the insert is detected via the arm_id PK unique violation and
 * resolved by re-reading. Idempotent across every ordering.
 *
 * Throws a ZodError on invalid input, on a tenancy mismatch (the arm_id
 * already belongs to a different merchant/proposal), and the Postgres error
 * on an unexpected write failure.
 */
export async function initializeBanditArm(
  serviceClient: LapsedSupabaseClient,
  input: InitializeBanditArmInput,
): Promise<BanditState> {
  const v = InitializeBanditArmInputSchema.parse(input);

  const existing = await readBanditRow(serviceClient, v.armId);
  if (existing) return assertTenancyAndConvert(existing, v);

  const { data: inserted, error } = await serviceClient
    .from("bandit_state")
    .insert({
      arm_id: v.armId,
      merchant_id: v.merchantId,
      proposal_id: v.proposalId,
      alpha: NEUTRAL_PRIOR.alpha,
      beta: NEUTRAL_PRIOR.beta,
      observation_count: 0,
    })
    .select(BANDIT_STATE_COLUMNS)
    .maybeSingle();

  if (error) {
    // A concurrent caller inserted the arm between our read and this insert;
    // the arm_id PK rejects the duplicate. Re-read and return the live row.
    if (isUniqueViolation(error)) {
      const raced = await readBanditRow(serviceClient, v.armId);
      if (raced) return assertTenancyAndConvert(raced, v);
    }
    throw error;
  }
  if (!inserted) {
    throw new Error(`initializeBanditArm: insert for arm ${v.armId} returned no row`);
  }
  return assertTenancyAndConvert(inserted as BanditStateRow, v);
}

/**
 * Folds a single real observation into an arm's Beta posterior:
 *   success → alpha + 1   (a converted send)
 *   failure → beta + 1    (a non-converting send)
 * and increments observation_count.
 *
 * This is the Sprint 07 writer — it is NOT called anywhere in Sprint 06 (no
 * sends happen yet). It updates the posterior STATISTICS on the existing row;
 * it never changes the arm's identity or contract, so it does not violate
 * decision 14 (arm immutability covers identity, not statistics).
 *
 * Not idempotent by design — each call represents one new observation.
 *
 * Throws if the arm has no bandit_state row (it must be initialized first).
 */
export async function updatePosterior(
  serviceClient: LapsedSupabaseClient,
  armId: string,
  success: boolean,
  opts: { now?: () => Date } = {},
): Promise<BanditState> {
  z.string().uuid("armId must be a UUID").parse(armId);
  const now = opts.now ?? (() => new Date());

  const { data: current, error: readErr } = await serviceClient
    .from("bandit_state")
    .select("arm_id, merchant_id, proposal_id, alpha, beta, observation_count, last_updated_at")
    .eq("arm_id", armId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!current) {
    throw new Error(`updatePosterior: arm ${armId} has no bandit_state row — initialize it first`);
  }

  const row = current as BanditStateRow;
  const nextAlpha = row.alpha + (success ? 1 : 0);
  const nextBeta = row.beta + (success ? 0 : 1);
  const nextObservationCount = row.observation_count + 1;
  const lastUpdatedAt = now().toISOString();

  const { data: updated, error: upErr } = await serviceClient
    .from("bandit_state")
    .update({
      alpha: nextAlpha,
      beta: nextBeta,
      observation_count: nextObservationCount,
      last_updated_at: lastUpdatedAt,
    })
    .eq("arm_id", armId)
    .select("arm_id, merchant_id, proposal_id, alpha, beta, observation_count, last_updated_at")
    .maybeSingle();
  if (upErr) throw upErr;
  if (!updated) {
    throw new Error(`updatePosterior: bandit_state row for arm ${armId} vanished mid-update`);
  }
  return toBanditState(updated as BanditStateRow);
}
