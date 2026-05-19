// Tests for the AI Insights / Recommendations engine (decision 36).
//
// Coverage:
//   - Each signal category fires when its threshold is crossed.
//   - Each signal category does NOT fire when threshold is not crossed.
//   - Idempotency: no duplicate row inserted while an active non-expired row exists.
//   - Dismissed insight: next evaluation re-activates (dismissed row is not "active").
//   - getActive returns only active, non-expired rows (DISTINCT ON per key).
//   - markDismissed / markActed / markSnoozed write the correct state row.
//   - InsightNotFoundError thrown when insight id does not exist.

import { describe, expect, it } from "vitest";
import {
  generateRecommendations,
  getActive as getActiveInsights,
  markDismissed,
  markActed,
  markSnoozed,
  InsightNotFoundError,
} from "../src/insights-engine";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const MERCHANT = "550e8400-e29b-41d4-a716-446655440000";
const OTHER_MERCHANT = "660e8400-e29b-41d4-a716-446655440000";

// Fixed reference time — all test "now" values anchor to this.
const NOW = new Date("2026-05-18T10:00:00.000Z");
// An insight that expires well in the future (non-expired).
const EXPIRES_FUTURE = new Date(NOW.getTime() + 20 * 60 * 60 * 1000).toISOString(); // +20h
// An insight that expired in the past.
const EXPIRES_PAST = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(); // -1h

// ─────────────────────────────────────────────────────────────────────────────
// Cohort signal
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateCohortSignal", () => {
  function makeLapsedVips(count: number): FakeRow[] {
    return Array.from({ length: count }, (_, i) => ({
      merchant_id: MERCHANT,
      shopify_customer_gid: `gid://shopify/Customer/${i + 1}`,
      lifecycle_stage: "lapsed",
      group_memberships: ["lapsed_vips"],
    }));
  }

  it("fires when lapsed VIP count >= threshold (10)", async () => {
    const { client } = makeFakeSupabase({
      customer_inferred_state: makeLapsedVips(12),
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("does NOT fire when lapsed VIP count < threshold (9)", async () => {
    const { client } = makeFakeSupabase({
      customer_inferred_state: makeLapsedVips(9),
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it("inserts the correct signal_metric and insight_key", async () => {
    const { client, tables } = makeFakeSupabase({
      customer_inferred_state: makeLapsedVips(15),
    });
    await generateRecommendations(client, MERCHANT, NOW);
    const row = tables.insights?.[0];
    expect(row?.insight_key).toBe("cohort:lapsed_vip_dormancy");
    expect(row?.signal_metric).toBe("lapsed_vip_count");
    expect(row?.signal_value).toBe(15);
    expect(row?.category).toBe("cohort");
    expect(row?.priority).toBe("HIGH");
    expect(row?.state).toBe("active");
    expect(row?.merchant_id).toBe(MERCHANT);
  });

  it("does not cross-contaminate another merchant's customers", async () => {
    const mine = makeLapsedVips(5); // below threshold
    const theirs = Array.from({ length: 20 }, (_, i) => ({
      merchant_id: OTHER_MERCHANT,
      shopify_customer_gid: `gid://shopify/Customer/${i + 100}`,
      lifecycle_stage: "lapsed",
      group_memberships: ["lapsed_vips"],
    }));
    const { client } = makeFakeSupabase({
      customer_inferred_state: [...mine, ...theirs],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Arm signal
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateArmSignal", () => {
  const PROPOSAL_1 = "11111111-1111-4111-8111-111111111111";

  function armRow(armId: string, alpha: number, beta: number, obs: number): FakeRow {
    return {
      merchant_id: MERCHANT,
      proposal_id: PROPOSAL_1,
      arm_id: armId,
      sentiment_alpha: alpha,
      sentiment_beta: beta,
      observation_count: obs,
    };
  }

  it("fires when two arms with >= 10 observations differ by >= 0.20", async () => {
    // arm A: rate ≈ 9/11 ≈ 0.818, arm B: rate = 5/10 = 0.5 → gap = 0.318
    const { client } = makeFakeSupabase({
      bandit_state: [
        armRow("arm-a", 9, 2, 11),
        armRow("arm-b", 5, 5, 10),
      ],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(1);
  });

  it("does NOT fire when gap < 0.20", async () => {
    // arm A: 7/11 ≈ 0.636, arm B: 6/11 ≈ 0.545 → gap ≈ 0.091
    const { client } = makeFakeSupabase({
      bandit_state: [
        armRow("arm-a", 7, 4, 11),
        armRow("arm-b", 6, 5, 11),
      ],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });

  it("does NOT fire when arm has fewer than 10 observations", async () => {
    const { client } = makeFakeSupabase({
      bandit_state: [
        armRow("arm-a", 9, 2, 9), // filtered — <10 obs
        armRow("arm-b", 2, 9, 9), // filtered — <10 obs
      ],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });

  it("does NOT fire when only one arm has enough observations", async () => {
    const { client } = makeFakeSupabase({
      bandit_state: [
        armRow("arm-a", 9, 2, 11), // qualifies
        armRow("arm-b", 1, 9, 5),  // filtered — <10 obs; only 1 arm left
      ],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });

  it("uses proposal_id in insight_key", async () => {
    const { client, tables } = makeFakeSupabase({
      bandit_state: [
        armRow("arm-a", 9, 2, 11),
        armRow("arm-b", 2, 9, 11),
      ],
    });
    await generateRecommendations(client, MERCHANT, NOW);
    const row = tables.insights?.[0];
    expect(row?.insight_key).toBe(`arm:performance_gap:${PROPOSAL_1}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Opt-out signal
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateOptOutSignal", () => {
  function optOut(createdAt: string): FakeRow {
    return { id: Math.random().toString(), merchant_id: MERCHANT, created_at: createdAt };
  }

  it("fires when >= 5 opt-outs in last 30 days", async () => {
    // 6 opt-outs within 30 days of NOW
    const recentDate = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const rows = Array.from({ length: 6 }, () => optOut(recentDate));
    const { client } = makeFakeSupabase({ customer_opt_outs: rows });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(1);
  });

  it("does NOT fire when < 5 opt-outs", async () => {
    const recentDate = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const rows = Array.from({ length: 4 }, () => optOut(recentDate));
    const { client } = makeFakeSupabase({ customer_opt_outs: rows });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });

  it("does NOT count opt-outs older than 30 days", async () => {
    // 6 opt-outs that are 31 days old
    const oldDate = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const rows = Array.from({ length: 6 }, () => optOut(oldDate));
    const { client } = makeFakeSupabase({ customer_opt_outs: rows });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation signal
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluateConversationSignal", () => {
  const RECENT = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(); // 3d ago
  const OLD_INBOUND = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10d ago

  function conv(lastMessageAt: string, lastInboundAt: string | null): FakeRow {
    return {
      id: Math.random().toString(),
      merchant_id: MERCHANT,
      last_message_at: lastMessageAt,
      last_inbound_at: lastInboundAt,
    };
  }

  it("fires when >= 5 stale conversations (recent outbound, no inbound)", async () => {
    const rows = Array.from({ length: 6 }, () => conv(RECENT, null));
    const { client } = makeFakeSupabase({ conversations: rows });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(1);
  });

  it("also fires when inbound is older than 7 days", async () => {
    const rows = Array.from({ length: 6 }, () => conv(RECENT, OLD_INBOUND));
    const { client } = makeFakeSupabase({ conversations: rows });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(1);
  });

  it("does NOT fire when < 5 stale conversations", async () => {
    const rows = Array.from({ length: 4 }, () => conv(RECENT, null));
    const { client } = makeFakeSupabase({ conversations: rows });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });

  it("does NOT count conversations where last_message_at is before the 7-day cutoff", async () => {
    // 6 conversations where last_message_at is 10 days ago (outside the window)
    const oldOutbound = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const rows = Array.from({ length: 6 }, () => conv(oldOutbound, null));
    const { client } = makeFakeSupabase({ conversations: rows });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payment signal
// ─────────────────────────────────────────────────────────────────────────────

describe("evaluatePaymentSignal", () => {
  function sub(currentPeriodEnd: string, status = "active"): FakeRow {
    return { merchant_id: MERCHANT, status, current_period_end: currentPeriodEnd };
  }

  it("fires when subscription renews within 7 days", async () => {
    const fiveDaysOut = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const { client } = makeFakeSupabase({
      merchant_subscriptions: [sub(fiveDaysOut)],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(1);
  });

  it("does NOT fire when subscription renews more than 7 days out", async () => {
    const tenDaysOut = new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const { client } = makeFakeSupabase({
      merchant_subscriptions: [sub(tenDaysOut)],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });

  it("does NOT fire when subscription is not active", async () => {
    const fiveDaysOut = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const { client } = makeFakeSupabase({
      merchant_subscriptions: [sub(fiveDaysOut, "canceled")],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
  });

  it("includes the correct days_until_renewal in signal_value", async () => {
    const threeDaysOut = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const { client, tables } = makeFakeSupabase({
      merchant_subscriptions: [sub(threeDaysOut)],
    });
    await generateRecommendations(client, MERCHANT, NOW);
    const row = tables.insights?.[0];
    expect(row?.signal_metric).toBe("days_until_renewal");
    expect(Number(row?.signal_value)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — no duplicate rows within the 18-hour expiry window
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotency", () => {
  function makeLapsedVips(count: number): FakeRow[] {
    return Array.from({ length: count }, (_, i) => ({
      merchant_id: MERCHANT,
      shopify_customer_gid: `gid://shopify/Customer/${i + 1}`,
      lifecycle_stage: "lapsed",
      group_memberships: ["lapsed_vips"],
    }));
  }

  it("skips insertion when active non-expired row exists for the same key", async () => {
    const existingRow: FakeRow = {
      id: "existing-id",
      merchant_id: MERCHANT,
      insight_key: "cohort:lapsed_vip_dormancy",
      state: "active",
      expires_at: EXPIRES_FUTURE,
      created_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
    };
    const { client, tables } = makeFakeSupabase({
      customer_inferred_state: makeLapsedVips(15),
      insights: [existingRow],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(0);
    expect(result.skipped).toBe(1);
    // No new rows inserted
    expect(tables.insights?.length).toBe(1);
  });

  it("re-inserts when the existing row has expired", async () => {
    const expiredRow: FakeRow = {
      id: "expired-id",
      merchant_id: MERCHANT,
      insight_key: "cohort:lapsed_vip_dormancy",
      state: "active",
      expires_at: EXPIRES_PAST,
      created_at: new Date(NOW.getTime() - 20 * 60 * 60 * 1000).toISOString(),
    };
    const { client, tables } = makeFakeSupabase({
      customer_inferred_state: makeLapsedVips(15),
      insights: [expiredRow],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    expect(result.generated).toBe(1);
    expect(result.skipped).toBe(0);
    expect(tables.insights?.length).toBe(2);
  });

  it("re-inserts after dismissal (dismissed row is not 'active')", async () => {
    // Dismissed row — getActive skips it, hasActiveInsight finds no active row
    const dismissedRow: FakeRow = {
      id: "dismissed-id",
      merchant_id: MERCHANT,
      insight_key: "cohort:lapsed_vip_dormancy",
      state: "dismissed",
      expires_at: null,
      created_at: new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(),
    };
    const { client, tables } = makeFakeSupabase({
      customer_inferred_state: makeLapsedVips(15),
      insights: [dismissedRow],
    });
    const result = await generateRecommendations(client, MERCHANT, NOW);
    // Signal still crossed → generates a new active row
    expect(result.generated).toBe(1);
    expect(tables.insights?.length).toBe(2);
    const newRow = tables.insights?.[1];
    expect(newRow?.state).toBe("active");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getActive — returns active, non-expired, DISTINCT ON insight_key
// ─────────────────────────────────────────────────────────────────────────────

describe("getActive", () => {
  function insightRow(
    key: string,
    state: string,
    expiresAt: string | null,
    createdAt: string,
  ): FakeRow {
    return {
      id: Math.random().toString(),
      merchant_id: MERCHANT,
      insight_key: key,
      priority: "MEDIUM",
      category: "cohort",
      signal_metric: "test_metric",
      signal_value: 10,
      threshold: 5,
      merchant_copy: "Test copy",
      cta_action: { route: "/app" },
      state,
      created_at: createdAt,
      expires_at: expiresAt,
    };
  }

  it("returns only active, non-expired rows", async () => {
    const t1 = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    const t2 = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const { client } = makeFakeSupabase({
      insights: [
        insightRow("key:a", "active", EXPIRES_FUTURE, t1),
        insightRow("key:b", "dismissed", EXPIRES_FUTURE, t2), // excluded (dismissed)
        insightRow("key:c", "active", EXPIRES_PAST, t1),      // excluded (expired)
      ],
    });
    const rows = await getActiveInsights(client, MERCHANT, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.insightKey).toBe("key:a");
  });

  it("returns the latest row per insight_key (DISTINCT ON behavior)", async () => {
    const older = new Date(NOW.getTime() - 5 * 60 * 60 * 1000).toISOString();
    const newer = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const { client } = makeFakeSupabase({
      insights: [
        insightRow("key:a", "active", EXPIRES_FUTURE, older), // older row
        insightRow("key:a", "dismissed", null, newer),         // newer — supersedes
      ],
    });
    // The newer row for key:a is dismissed, so nothing returned
    const rows = await getActiveInsights(client, MERCHANT, NOW);
    expect(rows).toHaveLength(0);
  });

  it("does not return rows from another merchant", async () => {
    const t = new Date(NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const { client } = makeFakeSupabase({
      insights: [
        { ...insightRow("key:a", "active", EXPIRES_FUTURE, t), merchant_id: OTHER_MERCHANT },
      ],
    });
    const rows = await getActiveInsights(client, MERCHANT, NOW);
    expect(rows).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State transitions — markDismissed, markActed, markSnoozed
// ─────────────────────────────────────────────────────────────────────────────

describe("state transitions", () => {
  const INSIGHT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  function activeInsight(overrides: Partial<FakeRow> = {}): FakeRow {
    return {
      id: INSIGHT_ID,
      merchant_id: MERCHANT,
      insight_key: "cohort:lapsed_vip_dormancy",
      priority: "HIGH",
      category: "cohort",
      signal_metric: "lapsed_vip_count",
      signal_value: 15,
      threshold: 10,
      merchant_copy: "15 dormant VIP customers...",
      cta_action: { route: "/app/campaigns/new" },
      state: "active",
      created_at: new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(),
      expires_at: EXPIRES_FUTURE,
      ...overrides,
    };
  }

  it("markDismissed inserts a new row with state='dismissed'", async () => {
    const { client, tables } = makeFakeSupabase({
      insights: [activeInsight()],
    });
    await markDismissed(client, MERCHANT, INSIGHT_ID);
    expect(tables.insights).toHaveLength(2);
    const newRow = tables.insights?.[1];
    expect(newRow?.state).toBe("dismissed");
    expect(newRow?.insight_key).toBe("cohort:lapsed_vip_dormancy");
    expect(newRow?.expires_at).toBeNull();
  });

  it("markActed inserts a new row with state='acted'", async () => {
    const { client, tables } = makeFakeSupabase({
      insights: [activeInsight()],
    });
    await markActed(client, MERCHANT, INSIGHT_ID);
    const newRow = tables.insights?.[1];
    expect(newRow?.state).toBe("acted");
  });

  it("markSnoozed inserts a new row with state='snoozed'", async () => {
    const { client, tables } = makeFakeSupabase({
      insights: [activeInsight()],
    });
    await markSnoozed(client, MERCHANT, INSIGHT_ID);
    const newRow = tables.insights?.[1];
    expect(newRow?.state).toBe("snoozed");
  });

  it("throws InsightNotFoundError when insight id does not exist", async () => {
    const { client } = makeFakeSupabase({ insights: [] });
    await expect(markDismissed(client, MERCHANT, "nonexistent-id")).rejects.toThrow(
      InsightNotFoundError,
    );
  });

  it("throws InsightNotFoundError when insight belongs to another merchant", async () => {
    const { client } = makeFakeSupabase({
      insights: [activeInsight({ merchant_id: OTHER_MERCHANT })],
    });
    await expect(markDismissed(client, MERCHANT, INSIGHT_ID)).rejects.toThrow(
      InsightNotFoundError,
    );
  });

  it("dismissed insight does not block next evaluation cycle from re-activating", async () => {
    // After dismissal, signal still crossed → new active row should be generated
    const { client } = makeFakeSupabase({
      insights: [activeInsight()],
    });
    await markDismissed(client, MERCHANT, INSIGHT_ID);
    // Now: [active_original, dismissed_new]
    // getActiveInsights should return nothing (dismissed is the latest row per key)
    const beforeGen = await getActiveInsights(client, MERCHANT, NOW);
    expect(beforeGen).toHaveLength(0);
    // Verify the dismissed state took effect (hasActiveInsight would return false)
    // The next generateRecommendations call (with seeded vips) would re-insert.
    // This is already covered in the idempotency "re-inserts after dismissal" test.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signal isolation — individual failures don't abort the entire run
// ─────────────────────────────────────────────────────────────────────────────

describe("signal isolation (error handling)", () => {
  it("continues processing other signals when one evaluator fails", async () => {
    // customer_opt_outs query will fail (inject failure)
    const { client } = makeFakeSupabase(
      {
        // No cohort / arm / conversation / payment triggers
        customer_opt_outs: [],
      },
      { failOn: [{ table: "customer_inferred_state", op: "select" }] },
    );
    // Even though cohort signal fails, the overall call should not throw
    // (it catches per-evaluator errors). With no other signals crossing threshold,
    // we expect 0 generated and the run to complete.
    await expect(generateRecommendations(client, MERCHANT, NOW)).resolves.toMatchObject({
      generated: 0,
      skipped: 0,
    });
  });
});
