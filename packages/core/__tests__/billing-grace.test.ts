// Failed-payment grace sweep tests — Sprint 09 chunk 9 (decision 31).

import { describe, expect, it } from "vitest";
import { runBillingGraceSweep } from "../src/billing-grace";
import { makeFakeSupabase, type FakeRow } from "./_fake-supabase";

const M1 = "550e8400-e29b-41d4-a716-446655440000";
const M2 = "660e8400-e29b-41d4-a716-446655440000";

const DAY = 86_400_000;
const NOW = new Date("2026-05-20T07:00:00Z");
const now = () => NOW;

/** A merchant_subscriptions row in past_due with grace started `daysAgo` ago. */
function pastDueSub(merchantId: string, daysAgo: number | null): FakeRow {
  return {
    merchant_id: merchantId,
    stripe_subscription_id: `sub_${merchantId}`,
    tier: "growth",
    status: "past_due",
    current_period_start: "2026-05-01T00:00:00.000Z",
    current_period_end: "2026-06-01T00:00:00.000Z",
    grace_period_started_at:
      daysAgo === null ? null : new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
    cancel_at: null,
    canceled_at: null,
  };
}

function merchant(id: string, status: string): FakeRow {
  return { id, shopify_shop_domain: `shop-${id}.myshopify.com`, subscription_status: status };
}

function seed(subs: FakeRow[], merchants: FakeRow[]) {
  return makeFakeSupabase({
    merchant_subscriptions: subs,
    merchants,
    subscription_events: [],
  });
}

describe("runBillingGraceSweep", () => {
  it("suspends a merchant whose 7-day grace window has elapsed", async () => {
    const { client, tables } = seed(
      [pastDueSub(M1, 8)], // grace started 8 days ago — past the 7-day window
      [merchant(M1, "past_due")],
    );
    const result = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });

    expect(result.scanned).toBe(1);
    expect(result.suspended).toBe(1);
    expect(result.withinGrace).toBe(0);

    expect(tables.merchant_subscriptions![0]!.status).toBe("suspended");
    expect(tables.merchants![0]!.subscription_status).toBe("suspended");

    // The grace_period_expired event is recorded (audit + next-login flag).
    const events = tables.subscription_events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("grace_period_expired");
    expect(events[0]!.merchant_id).toBe(M1);
    expect(events[0]!.stripe_event_id).toBeNull();
  });

  it("leaves a merchant still inside the grace window untouched", async () => {
    const { client, tables } = seed(
      [pastDueSub(M1, 3)], // only 3 days into a 7-day window
      [merchant(M1, "past_due")],
    );
    const result = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });

    expect(result.withinGrace).toBe(1);
    expect(result.suspended).toBe(0);
    expect(tables.merchant_subscriptions![0]!.status).toBe("past_due");
    expect(tables.merchants![0]!.subscription_status).toBe("past_due");
    expect(tables.subscription_events ?? []).toHaveLength(0);
  });

  it("is idempotent — a re-run finds no past_due rows and suspends nothing again", async () => {
    const { client, tables } = seed([pastDueSub(M1, 9)], [merchant(M1, "past_due")]);
    const first = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });
    expect(first.suspended).toBe(1);

    const second = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });
    // The row is now `suspended`, so the past_due sweep no longer matches it.
    expect(second.scanned).toBe(0);
    expect(second.suspended).toBe(0);
    expect(tables.subscription_events).toHaveLength(1); // no second event
  });

  it("skips a past_due row with no grace anchor rather than suspending it", async () => {
    const { client, tables } = seed([pastDueSub(M1, null)], [merchant(M1, "past_due")]);
    const result = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });
    expect(result.skipped).toBe(1);
    expect(result.suspended).toBe(0);
    expect(tables.merchant_subscriptions![0]!.status).toBe("past_due");
  });

  it("processes a mixed batch — suspends the expired, spares the in-window", async () => {
    const { client, tables } = seed(
      [pastDueSub(M1, 10), pastDueSub(M2, 2)],
      [merchant(M1, "past_due"), merchant(M2, "past_due")],
    );
    const result = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });

    expect(result.scanned).toBe(2);
    expect(result.suspended).toBe(1);
    expect(result.withinGrace).toBe(1);

    const m1Sub = tables.merchant_subscriptions!.find((s) => s.merchant_id === M1)!;
    const m2Sub = tables.merchant_subscriptions!.find((s) => s.merchant_id === M2)!;
    expect(m1Sub.status).toBe("suspended");
    expect(m2Sub.status).toBe("past_due");
  });

  it("honours a configurable grace window — a 14-day window spares a 10-day grace", async () => {
    const { client, tables } = seed([pastDueSub(M1, 10)], [merchant(M1, "past_due")]);
    const result = await runBillingGraceSweep(client, { gracePeriodDays: 14, now });
    expect(result.withinGrace).toBe(1);
    expect(result.suspended).toBe(0);
    expect(tables.merchant_subscriptions![0]!.status).toBe("past_due");
  });

  it("spares a merchant at exactly the grace boundary (suspend only STRICTLY after)", async () => {
    // Grace started exactly 7 days ago, 7-day window — not yet past the window.
    const { client, tables } = seed([pastDueSub(M1, 7)], [merchant(M1, "past_due")]);
    const result = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });
    expect(result.withinGrace).toBe(1);
    expect(result.suspended).toBe(0);
    expect(tables.merchant_subscriptions![0]!.status).toBe("past_due");
  });

  it("skips a past_due row with a malformed (unparseable) grace anchor", async () => {
    const badRow = pastDueSub(M1, 8);
    badRow.grace_period_started_at = "not-a-timestamp";
    const { client, tables } = seed([badRow], [merchant(M1, "past_due")]);
    const result = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });
    expect(result.skipped).toBe(1);
    expect(result.suspended).toBe(0);
    expect(tables.merchant_subscriptions![0]!.status).toBe("past_due");
  });

  it("isolates a per-merchant write failure — counts it and continues the batch", async () => {
    const { client, tables } = makeFakeSupabase(
      {
        merchant_subscriptions: [pastDueSub(M1, 9), pastDueSub(M2, 9)],
        merchants: [merchant(M1, "past_due"), merchant(M2, "past_due")],
        subscription_events: [],
      },
      // The merchants update fails for every merchant — both transitions throw.
      { failOn: [{ table: "merchants", op: "update" }] },
    );
    const result = await runBillingGraceSweep(client, { gracePeriodDays: 7, now });
    expect(result.scanned).toBe(2);
    expect(result.failed).toBe(2); // both counted, neither aborted the sweep
    expect(result.suspended).toBe(0);
    // The mirror status flip is LAST — a failure earlier leaves rows past_due
    // (re-processable on the next run), never stranded half-suspended.
    for (const sub of tables.merchant_subscriptions!) {
      expect(sub.status).toBe("past_due");
    }
  });

  it("rejects a non-positive grace window rather than mass-suspending merchants", async () => {
    const { client } = seed([pastDueSub(M1, 100)], [merchant(M1, "past_due")]);
    await expect(
      runBillingGraceSweep(client, { gracePeriodDays: 0, now }),
    ).rejects.toThrow(/positive number/);
    await expect(
      runBillingGraceSweep(client, { gracePeriodDays: Number.NaN, now }),
    ).rejects.toThrow(/positive number/);
  });
});
