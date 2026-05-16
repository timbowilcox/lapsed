import { describe, expect, it, vi } from "vitest";
import type { LapsedSupabaseClient } from "@lapsed/db";
import {
  mulberry32,
  sampleBeta,
  thompsonSample,
  betaMean,
  betaVariance,
  regularizedIncompleteBeta,
  betaQuantile,
  posteriorStats,
  initializeBanditArm,
  updatePosterior,
  NEUTRAL_PRIOR,
  type BanditState,
} from "../src/bandit";

const MERCHANT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";
const ARM_A = "aaaaaaaa-1111-4111-8111-111111111111";
const ARM_B = "bbbbbbbb-2222-4222-8222-222222222222";
const ARM_C = "cccccccc-3333-4333-8333-333333333333";

function arm(armId: string, alpha: number, beta: number, observationCount = 0): BanditState {
  return {
    armId,
    merchantId: MERCHANT_ID,
    proposalId: PROPOSAL_ID,
    alpha,
    beta,
    observationCount,
    lastUpdatedAt: "2026-05-16T00:00:00.000Z",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// mulberry32
// ─────────────────────────────────────────────────────────────────────────────

describe("mulberry32", () => {
  it("produces the same stream for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 50; i++) expect(a()).toBe(b());
  });

  it("produces different streams for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const aVals = Array.from({ length: 10 }, () => a());
    const bVals = Array.from({ length: 10 }, () => b());
    expect(aVals).not.toEqual(bVals);
  });

  it("emits values within [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sampleBeta
// ─────────────────────────────────────────────────────────────────────────────

describe("sampleBeta", () => {
  it("returns values within [0, 1]", () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 1000; i++) {
      const v = sampleBeta(3, 5, rng);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic given a seeded rng", () => {
    const a = sampleBeta(2, 3, mulberry32(99));
    const b = sampleBeta(2, 3, mulberry32(99));
    expect(a).toBe(b);
  });

  it("Beta(1,1) has an empirical mean near 0.5 (uniform)", () => {
    const rng = mulberry32(123);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += sampleBeta(1, 1, rng);
    expect(sum / n).toBeGreaterThan(0.47);
    expect(sum / n).toBeLessThan(0.53);
  });

  it("Beta(20,2) concentrates near its mean of ~0.91", () => {
    const rng = mulberry32(456);
    let sum = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) sum += sampleBeta(20, 2, rng);
    expect(sum / n).toBeGreaterThan(0.86);
    expect(sum / n).toBeLessThan(0.96);
  });

  it("Beta(2,20) concentrates near its mean of ~0.09", () => {
    const rng = mulberry32(789);
    let sum = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) sum += sampleBeta(2, 20, rng);
    expect(sum / n).toBeGreaterThan(0.04);
    expect(sum / n).toBeLessThan(0.14);
  });

  it("empirical variance of Beta(2,2) matches the analytic variance", () => {
    const rng = mulberry32(321);
    const n = 40000;
    const samples: number[] = [];
    for (let i = 0; i < n; i++) samples.push(sampleBeta(2, 2, rng));
    const mean = samples.reduce((s, v) => s + v, 0) / n;
    const variance = samples.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    expect(variance).toBeGreaterThan(betaVariance(2, 2) - 0.01);
    expect(variance).toBeLessThan(betaVariance(2, 2) + 0.01);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// thompsonSample
// ─────────────────────────────────────────────────────────────────────────────

describe("thompsonSample", () => {
  it("throws on an empty arm set", () => {
    expect(() => thompsonSample([])).toThrow(/empty arm set/);
  });

  it("returns the only arm when there is exactly one", () => {
    expect(thompsonSample([arm(ARM_A, 1, 1)], { seed: 1 })).toBe(ARM_A);
  });

  it("always returns an armId that exists in the input set", () => {
    const arms = [arm(ARM_A, 3, 4), arm(ARM_B, 5, 2), arm(ARM_C, 1, 1)];
    const ids = new Set(arms.map((a) => a.armId));
    for (let seed = 0; seed < 100; seed++) {
      expect(ids.has(thompsonSample(arms, { seed }))).toBe(true);
    }
  });

  it("is deterministic — the same seed selects the same arm", () => {
    const arms = [arm(ARM_A, 4, 6), arm(ARM_B, 6, 4), arm(ARM_C, 5, 5)];
    for (const seed of [0, 1, 7, 42, 999]) {
      expect(thompsonSample(arms, { seed })).toBe(thompsonSample(arms, { seed }));
    }
  });

  it("different seeds can select different arms", () => {
    const arms = [arm(ARM_A, 5, 5), arm(ARM_B, 5, 5), arm(ARM_C, 5, 5)];
    const picks = new Set<string>();
    for (let seed = 0; seed < 60; seed++) picks.add(thompsonSample(arms, { seed }));
    expect(picks.size).toBeGreaterThan(1);
  });

  it("strongly favours the arm with the dominant posterior", () => {
    // ARM_A posterior mean ~0.91, ARM_B ~0.09 — A should win nearly always.
    const arms = [arm(ARM_A, 20, 2), arm(ARM_B, 2, 20)];
    let aWins = 0;
    for (let seed = 0; seed < 200; seed++) {
      if (thompsonSample(arms, { seed }) === ARM_A) aWins++;
    }
    expect(aWins).toBeGreaterThan(190);
  });

  it("splits roughly evenly between two equal Beta(1,1) posteriors", () => {
    const arms = [arm(ARM_A, 1, 1), arm(ARM_B, 1, 1)];
    let aWins = 0;
    const trials = 600;
    for (let seed = 0; seed < trials; seed++) {
      if (thompsonSample(arms, { seed }) === ARM_A) aWins++;
    }
    const fraction = aWins / trials;
    expect(fraction).toBeGreaterThan(0.42);
    expect(fraction).toBeLessThan(0.58);
  });

  it("still explores a weaker arm sometimes when posteriors only mildly differ", () => {
    // ARM_A mean ~0.6, ARM_B mean ~0.4 — B should still win a meaningful share.
    const arms = [arm(ARM_A, 6, 4), arm(ARM_B, 4, 6)];
    let bWins = 0;
    for (let seed = 0; seed < 400; seed++) {
      if (thompsonSample(arms, { seed }) === ARM_B) bWins++;
    }
    expect(bWins).toBeGreaterThan(40);
    expect(bWins).toBeLessThan(360);
  });

  it("uses Math.random when no seed is given (returns a valid arm)", () => {
    const arms = [arm(ARM_A, 1, 1), arm(ARM_B, 1, 1)];
    const ids = new Set([ARM_A, ARM_B]);
    for (let i = 0; i < 50; i++) expect(ids.has(thompsonSample(arms))).toBe(true);
  });

  it("treats every 0-observation arm as Beta(1,1) — selection is unbiased", () => {
    // Three freshly-initialized arms; over many seeds each should win a share.
    const arms = [arm(ARM_A, 1, 1), arm(ARM_B, 1, 1), arm(ARM_C, 1, 1)];
    const wins: Record<string, number> = { [ARM_A]: 0, [ARM_B]: 0, [ARM_C]: 0 };
    for (let seed = 0; seed < 600; seed++) wins[thompsonSample(arms, { seed })]! += 1;
    expect(wins[ARM_A]!).toBeGreaterThan(120);
    expect(wins[ARM_B]!).toBeGreaterThan(120);
    expect(wins[ARM_C]!).toBeGreaterThan(120);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// posterior statistics
// ─────────────────────────────────────────────────────────────────────────────

describe("betaMean", () => {
  it("Beta(1,1) mean is 0.5", () => {
    expect(betaMean(1, 1)).toBe(0.5);
  });
  it("Beta(3,1) mean is 0.75", () => {
    expect(betaMean(3, 1)).toBe(0.75);
  });
  it("Beta(10,2) mean is ~0.833", () => {
    expect(betaMean(10, 2)).toBeCloseTo(0.8333, 3);
  });
});

describe("betaVariance", () => {
  it("Beta(1,1) variance is 1/12", () => {
    expect(betaVariance(1, 1)).toBeCloseTo(1 / 12, 6);
  });
  it("variance shrinks as observations accumulate", () => {
    expect(betaVariance(50, 50)).toBeLessThan(betaVariance(5, 5));
  });
});

describe("regularizedIncompleteBeta", () => {
  it("is 0 at x = 0 and 1 at x = 1", () => {
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
  });

  it("Beta(1,1) CDF is the identity (I_x = x)", () => {
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(regularizedIncompleteBeta(x, 1, 1)).toBeCloseTo(x, 6);
    }
  });

  it("is symmetric: I_x(a,b) = 1 - I_(1-x)(b,a)", () => {
    expect(regularizedIncompleteBeta(0.3, 2, 5)).toBeCloseTo(
      1 - regularizedIncompleteBeta(0.7, 5, 2),
      6,
    );
  });

  it("is monotonically increasing in x", () => {
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.05) {
      const v = regularizedIncompleteBeta(x, 4, 7);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("betaQuantile", () => {
  it("the median of Beta(1,1) is 0.5", () => {
    expect(betaQuantile(0.5, 1, 1)).toBeCloseTo(0.5, 4);
  });

  it("Beta(1,1) quantiles equal their probabilities", () => {
    for (const p of [0.025, 0.1, 0.5, 0.9, 0.975]) {
      expect(betaQuantile(p, 1, 1)).toBeCloseTo(p, 4);
    }
  });

  it("round-trips with regularizedIncompleteBeta", () => {
    for (const p of [0.05, 0.5, 0.95]) {
      const x = betaQuantile(p, 6, 3);
      expect(regularizedIncompleteBeta(x, 6, 3)).toBeCloseTo(p, 4);
    }
  });

  it("clamps to 0 / 1 at the probability extremes", () => {
    expect(betaQuantile(0, 2, 2)).toBe(0);
    expect(betaQuantile(1, 2, 2)).toBe(1);
  });
});

describe("posteriorStats", () => {
  it("Beta(1,1) — mean 0.5, 95% CI ~[0.025, 0.975]", () => {
    const s = posteriorStats(1, 1);
    expect(s.mean).toBe(0.5);
    expect(s.ciLower).toBeCloseTo(0.025, 3);
    expect(s.ciUpper).toBeCloseTo(0.975, 3);
  });

  it("the credible interval brackets the mean", () => {
    const s = posteriorStats(10, 4);
    expect(s.ciLower).toBeLessThan(s.mean);
    expect(s.ciUpper).toBeGreaterThan(s.mean);
  });

  it("the interval narrows as observations accumulate", () => {
    const few = posteriorStats(3, 3);
    const many = posteriorStats(150, 150);
    expect(many.ciUpper - many.ciLower).toBeLessThan(few.ciUpper - few.ciLower);
  });

  it("supports a custom credibility level", () => {
    const ci95 = posteriorStats(8, 5, 0.95);
    const ci50 = posteriorStats(8, 5, 0.5);
    expect(ci50.ciUpper - ci50.ciLower).toBeLessThan(ci95.ciUpper - ci95.ciLower);
  });

  it("stays finite and ordered for a high-observation posterior (Beta(400,12))", () => {
    // The state an arm reaches after hundreds of Sprint 07 observations — the
    // lnGamma/exp path must not underflow to NaN in the inspector UI.
    const s = posteriorStats(400, 12);
    expect(Number.isFinite(s.mean)).toBe(true);
    expect(Number.isFinite(s.ciLower)).toBe(true);
    expect(Number.isFinite(s.ciUpper)).toBe(true);
    expect(s.ciLower).toBeLessThan(s.mean);
    expect(s.mean).toBeLessThan(s.ciUpper);
    expect(s.mean).toBeCloseTo(400 / 412, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// initializeBanditArm / updatePosterior — DB writers
// ─────────────────────────────────────────────────────────────────────────────

interface MockConfig {
  /** Row returned by the first SELECT ... maybeSingle. */
  existingRow?: Record<string, unknown> | null;
  /** Row returned by the SECOND SELECT (the post-unique-violation re-read). */
  secondReadRow?: Record<string, unknown> | null;
  /** Row returned by INSERT ... select().maybeSingle(). */
  insertedRow?: Record<string, unknown> | null;
  /** Row returned by UPDATE ... select().maybeSingle(). */
  updatedRow?: Record<string, unknown> | null;
  insertError?: { message: string; code?: string };
  selectError?: { message: string };
  updateError?: { message: string };
}

interface InsertCall {
  table: string;
  row: Record<string, unknown>;
}
interface UpdateCall {
  table: string;
  row: Record<string, unknown>;
}

function makeMockClient(config: MockConfig = {}) {
  const inserts: InsertCall[] = [];
  const updates: UpdateCall[] = [];
  let selectCalls = 0;

  function selectBuilder() {
    const call = ++selectCalls;
    const qb: Record<string, unknown> = {};
    qb.eq = () => qb;
    qb.maybeSingle = () => {
      if (config.selectError) return Promise.resolve({ data: null, error: config.selectError });
      const row = call >= 2 ? (config.secondReadRow ?? null) : (config.existingRow ?? null);
      return Promise.resolve({ data: row, error: null });
    };
    return qb;
  }

  function insertBuilder() {
    const qb: Record<string, unknown> = {};
    qb.select = () => qb;
    qb.maybeSingle = () =>
      Promise.resolve(
        config.insertError
          ? { data: null, error: config.insertError }
          : { data: config.insertedRow ?? null, error: null },
      );
    return qb;
  }

  function updateBuilder() {
    const qb: Record<string, unknown> = {};
    qb.eq = () => qb;
    qb.select = () => qb;
    qb.maybeSingle = () =>
      Promise.resolve(
        config.updateError
          ? { data: null, error: config.updateError }
          : { data: config.updatedRow ?? null, error: null },
      );
    return qb;
  }

  const client = {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => selectBuilder()),
      insert: vi.fn((row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return insertBuilder();
      }),
      update: vi.fn((row: Record<string, unknown>) => {
        updates.push({ table, row });
        return updateBuilder();
      }),
    })),
  } as unknown as LapsedSupabaseClient;

  return { client, inserts, updates };
}

function banditRow(overrides: Record<string, unknown> = {}) {
  return {
    arm_id: ARM_A,
    merchant_id: MERCHANT_ID,
    proposal_id: PROPOSAL_ID,
    alpha: 1,
    beta: 1,
    observation_count: 0,
    last_updated_at: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("NEUTRAL_PRIOR", () => {
  it("is Beta(1,1)", () => {
    expect(NEUTRAL_PRIOR).toEqual({ alpha: 1, beta: 1 });
  });
});

describe("initializeBanditArm", () => {
  it("inserts the neutral Beta(1,1) prior when the arm has no row yet", async () => {
    const { client, inserts } = makeMockClient({
      existingRow: null,
      insertedRow: banditRow(),
    });
    await initializeBanditArm(client, {
      armId: ARM_A,
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe("bandit_state");
    expect(inserts[0]!.row).toEqual({
      arm_id: ARM_A,
      merchant_id: MERCHANT_ID,
      proposal_id: PROPOSAL_ID,
      alpha: 1,
      beta: 1,
      observation_count: 0,
    });
  });

  it("returns the bandit state from the inserted row", async () => {
    const { client } = makeMockClient({ existingRow: null, insertedRow: banditRow() });
    const state = await initializeBanditArm(client, {
      armId: ARM_A,
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
    });
    expect(state).toEqual({
      armId: ARM_A,
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
      alpha: 1,
      beta: 1,
      observationCount: 0,
      lastUpdatedAt: "2026-05-16T00:00:00.000Z",
    });
  });

  it("returns an already-initialized arm untouched — never re-sends the prior (decision 14)", async () => {
    // Sprint 07 has folded in observations: the existing posterior is (12,4).
    // No insert must happen, and the live posterior must be returned as-is.
    const { client, inserts } = makeMockClient({
      existingRow: banditRow({ alpha: 12, beta: 4, observation_count: 14 }),
    });
    const state = await initializeBanditArm(client, {
      armId: ARM_A,
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
    });
    expect(inserts).toHaveLength(0);
    expect(state.alpha).toBe(12);
    expect(state.beta).toBe(4);
    expect(state.observationCount).toBe(14);
  });

  it("re-reads and returns the live row when a concurrent insert wins the race", async () => {
    // First read: no row. Insert: unique violation (23505). Re-read: the row
    // the racing caller inserted.
    const { client, inserts } = makeMockClient({
      existingRow: null,
      insertError: { message: "duplicate key", code: "23505" },
      secondReadRow: banditRow({ alpha: 1, beta: 1 }),
    });
    const state = await initializeBanditArm(client, {
      armId: ARM_A,
      merchantId: MERCHANT_ID,
      proposalId: PROPOSAL_ID,
    });
    expect(inserts).toHaveLength(1);
    expect(state.armId).toBe(ARM_A);
  });

  it("throws a tenancy error when the arm already belongs to another merchant", async () => {
    const { client } = makeMockClient({
      existingRow: banditRow({ merchant_id: "999e8400-e29b-41d4-a716-446655440000" }),
    });
    await expect(
      initializeBanditArm(client, {
        armId: ARM_A,
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
      }),
    ).rejects.toThrow(/different merchant/);
  });

  it("rejects a non-UUID armId", async () => {
    const { client } = makeMockClient();
    await expect(
      initializeBanditArm(client, {
        armId: "nope",
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
      }),
    ).rejects.toThrow(/armId/);
  });

  it("rejects a non-UUID merchantId", async () => {
    const { client } = makeMockClient();
    await expect(
      initializeBanditArm(client, {
        armId: ARM_A,
        merchantId: "nope",
        proposalId: PROPOSAL_ID,
      }),
    ).rejects.toThrow(/merchantId/);
  });

  it("rejects a non-UUID proposalId", async () => {
    const { client } = makeMockClient();
    await expect(
      initializeBanditArm(client, {
        armId: ARM_A,
        merchantId: MERCHANT_ID,
        proposalId: "nope",
      }),
    ).rejects.toThrow(/proposalId/);
  });

  it("throws when the insert returns no row", async () => {
    const { client } = makeMockClient({ existingRow: null, insertedRow: null });
    await expect(
      initializeBanditArm(client, {
        armId: ARM_A,
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
      }),
    ).rejects.toThrow(/returned no row/);
  });

  it("propagates a non-unique insert error", async () => {
    const { client } = makeMockClient({
      existingRow: null,
      insertError: { message: "disk full", code: "53100" },
    });
    await expect(
      initializeBanditArm(client, {
        armId: ARM_A,
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
      }),
    ).rejects.toThrow(/disk full/);
  });

  it("propagates a read error", async () => {
    const { client } = makeMockClient({ selectError: { message: "read failed" } });
    await expect(
      initializeBanditArm(client, {
        armId: ARM_A,
        merchantId: MERCHANT_ID,
        proposalId: PROPOSAL_ID,
      }),
    ).rejects.toThrow(/read failed/);
  });
});

describe("updatePosterior", () => {
  it("increments alpha on a success and bumps observation_count", async () => {
    const { client, updates } = makeMockClient({
      existingRow: banditRow({ alpha: 3, beta: 5, observation_count: 6 }),
      updatedRow: banditRow({ alpha: 4, beta: 5, observation_count: 7 }),
    });
    const state = await updatePosterior(client, ARM_A, true, {
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.row).toEqual({
      alpha: 4,
      beta: 5,
      observation_count: 7,
      last_updated_at: "2026-05-16T12:00:00.000Z",
    });
    expect(state.alpha).toBe(4);
  });

  it("increments beta on a failure and bumps observation_count", async () => {
    const { client, updates } = makeMockClient({
      existingRow: banditRow({ alpha: 3, beta: 5, observation_count: 6 }),
      updatedRow: banditRow({ alpha: 3, beta: 6, observation_count: 7 }),
    });
    await updatePosterior(client, ARM_A, false, {
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    });
    expect(updates[0]!.row).toMatchObject({ alpha: 3, beta: 6, observation_count: 7 });
  });

  it("starts from the neutral prior — first success yields Beta(2,1)", async () => {
    const { client, updates } = makeMockClient({
      existingRow: banditRow({ alpha: 1, beta: 1, observation_count: 0 }),
      updatedRow: banditRow({ alpha: 2, beta: 1, observation_count: 1 }),
    });
    await updatePosterior(client, ARM_A, true);
    expect(updates[0]!.row).toMatchObject({ alpha: 2, beta: 1, observation_count: 1 });
  });

  it("the update payload never includes an identity column (decision 14)", async () => {
    const { client, updates } = makeMockClient({
      existingRow: banditRow(),
      updatedRow: banditRow({ alpha: 2 }),
    });
    await updatePosterior(client, ARM_A, true, {
      now: () => new Date("2026-05-16T12:00:00.000Z"),
    });
    expect(Object.keys(updates[0]!.row).sort()).toEqual([
      "alpha",
      "beta",
      "last_updated_at",
      "observation_count",
    ]);
  });

  it("throws when the arm has no bandit_state row", async () => {
    const { client } = makeMockClient({ existingRow: null });
    await expect(updatePosterior(client, ARM_A, true)).rejects.toThrow(/no bandit_state row/);
  });

  it("throws when the row vanishes between the read and the update", async () => {
    const { client } = makeMockClient({ existingRow: banditRow(), updatedRow: null });
    await expect(updatePosterior(client, ARM_A, true)).rejects.toThrow(/vanished mid-update/);
  });

  it("rejects a non-UUID armId", async () => {
    const { client } = makeMockClient();
    await expect(updatePosterior(client, "nope", true)).rejects.toThrow(/armId/);
  });

  it("propagates a read error", async () => {
    const { client } = makeMockClient({ selectError: { message: "read failed" } });
    await expect(updatePosterior(client, ARM_A, true)).rejects.toThrow(/read failed/);
  });

  it("propagates an update error", async () => {
    const { client } = makeMockClient({
      existingRow: banditRow(),
      updateError: { message: "write failed" },
    });
    await expect(updatePosterior(client, ARM_A, true)).rejects.toThrow(/write failed/);
  });

  it("is not idempotent — two successes advance alpha twice", async () => {
    const first = makeMockClient({
      existingRow: banditRow({ alpha: 1, beta: 1, observation_count: 0 }),
      updatedRow: banditRow({ alpha: 2, beta: 1, observation_count: 1 }),
    });
    const s1 = await updatePosterior(first.client, ARM_A, true);
    expect(s1.alpha).toBe(2);

    const second = makeMockClient({
      existingRow: banditRow({ alpha: 2, beta: 1, observation_count: 1 }),
      updatedRow: banditRow({ alpha: 3, beta: 1, observation_count: 2 }),
    });
    const s2 = await updatePosterior(second.client, ARM_A, true);
    expect(s2.alpha).toBe(3);
    expect(s2.observationCount).toBe(2);
  });
});
