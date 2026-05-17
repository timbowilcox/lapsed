// Failed-payment grace sweep — Sprint 09 chunk 9 (decision 31).
//
// A failed payment moves a subscription to `past_due` and stamps
// `grace_period_started_at` (the chunk-8 webhook handler). This sweep runs
// daily: any merchant whose grace window has elapsed transitions to
// `suspended` — entitlements then drop to read-only (chunk 11).
//
// Grace expiry is `now > grace_period_started_at + gracePeriodDays`. The
// transition is recorded as a `grace_period_expired` event in
// `subscription_events` — that append-only row IS the next-login-banner flag
// (no separate column; chunk 11 reads `merchants.subscription_status =
// 'suspended'` as the entitlements gate).
//
// CRASH-SAFE WITHOUT A TRANSACTION. The three per-merchant writes are not in a
// DB transaction, so they are ordered for safe partial failure:
//   1. dedup-check the grace event   2. update `merchants` (cached status)
//   3. insert the `grace_period_expired` event (skipped if step 1 found it)
//   4. flip `merchant_subscriptions.status` to `suspended` — LAST.
// Step 4 is the idempotency filter key (the sweep selects `past_due` rows).
// Flipping it last means ANY earlier failure leaves the row `past_due`, so the
// next day's sweep re-processes it cleanly. The step-1 dedup keeps the retry
// from emitting a second event. A merchant can therefore never end up stranded
// half-transitioned and un-reprocessable.
//
// PER-MERCHANT ISOLATION. Each merchant's work is wrapped in try/catch — one
// merchant's DB error is counted in `failed` and the sweep continues.

import type { LapsedSupabaseClient } from "@lapsed/db";

const DAY_MS = 86_400_000;

export interface RunBillingGraceSweepOptions {
  /** Grace window length in days before suspension (decision 31, default 7). */
  gracePeriodDays: number;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

export interface BillingGraceSweepResult {
  /** past_due subscriptions examined. */
  scanned: number;
  /** Merchants transitioned to `suspended` this run. */
  suspended: number;
  /** past_due rows still inside the grace window — left untouched. */
  withinGrace: number;
  /** Rows skipped because grace_period_started_at was absent/malformed. */
  skipped: number;
  /** Merchants whose transition threw — counted, skipped, sweep continues. */
  failed: number;
}

interface PastDueRow {
  merchant_id: string;
  grace_period_started_at: string | null;
}

/**
 * Suspends every merchant whose failed-payment grace window has elapsed
 * (decision 31). Per-merchant work is best-effort: a single merchant's failure
 * is counted in `failed` and does not abort the sweep.
 *
 * Throws only on an invalid `gracePeriodDays` (a misconfigured window could
 * mass-suspend paying merchants) or a failure of the initial batch query.
 */
export async function runBillingGraceSweep(
  client: LapsedSupabaseClient,
  opts: RunBillingGraceSweepOptions,
): Promise<BillingGraceSweepResult> {
  // A non-finite or non-positive window would suspend every past_due merchant
  // immediately — fail loud rather than mass-suspend.
  if (!Number.isFinite(opts.gracePeriodDays) || opts.gracePeriodDays <= 0) {
    throw new Error(
      `runBillingGraceSweep: gracePeriodDays must be a positive number, got ${opts.gracePeriodDays}`,
    );
  }

  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const graceMs = opts.gracePeriodDays * DAY_MS;

  const result: BillingGraceSweepResult = {
    scanned: 0,
    suspended: 0,
    withinGrace: 0,
    skipped: 0,
    failed: 0,
  };

  // Only past_due subscriptions can expire into suspension. A suspended row no
  // longer matches this filter, so the sweep is naturally idempotent.
  const { data, error } = await client
    .from("merchant_subscriptions")
    .select("merchant_id, grace_period_started_at")
    .eq("status", "past_due");
  if (error) throw error;

  for (const row of (data ?? []) as PastDueRow[]) {
    result.scanned += 1;
    try {
      const startedAt = row.grace_period_started_at;
      if (!startedAt) {
        result.skipped += 1;
        console.warn(
          JSON.stringify({
            event: "billing_grace_missing_anchor",
            level: "warning",
            merchant_id: row.merchant_id,
          }),
        );
        continue;
      }
      const startedMs = new Date(startedAt).getTime();
      if (!Number.isFinite(startedMs)) {
        result.skipped += 1;
        console.warn(
          JSON.stringify({
            event: "billing_grace_bad_anchor",
            level: "warning",
            merchant_id: row.merchant_id,
          }),
        );
        continue;
      }

      const daysInGrace = (nowMs - startedMs) / DAY_MS;
      // Suspend only when STRICTLY more than the window has elapsed — matches
      // `grace_period_started_at < now() - interval 'N days'`.
      if (nowMs - startedMs <= graceMs) {
        result.withinGrace += 1;
        continue;
      }

      const nowIso = new Date(nowMs).toISOString();

      // (1) Dedup: a prior partial-failure run may already have emitted this
      // grace cycle's event. Match on the grace_started_at carried in `data`.
      const { data: priorEvents, error: priorErr } = await client
        .from("subscription_events")
        .select("data")
        .eq("merchant_id", row.merchant_id)
        .eq("event_type", "grace_period_expired");
      if (priorErr) throw priorErr;
      const alreadyEmitted = ((priorEvents ?? []) as Array<{ data: unknown }>).some(
        (e) => (e.data as { grace_started_at?: unknown } | null)?.grace_started_at === startedAt,
      );

      // (2) Cached merchants status — idempotent.
      const { error: merchErr } = await client
        .from("merchants")
        .update({ subscription_status: "suspended" })
        .eq("id", row.merchant_id);
      if (merchErr) throw merchErr;

      // (3) The grace_period_expired event — audit record + next-login flag.
      if (!alreadyEmitted) {
        const { error: evErr } = await client.from("subscription_events").insert({
          merchant_id: row.merchant_id,
          stripe_event_id: null,
          event_type: "grace_period_expired",
          data: {
            grace_started_at: startedAt,
            suspended_at: nowIso,
            days_in_grace: Math.round(daysInGrace * 100) / 100,
          },
        });
        if (evErr) throw evErr;
      }

      // (4) Flip the mirror status LAST — the idempotency filter key. Any
      // failure above leaves the row past_due, so the next sweep retries.
      const { error: subErr } = await client
        .from("merchant_subscriptions")
        .update({ status: "suspended", updated_at: nowIso })
        .eq("merchant_id", row.merchant_id);
      if (subErr) throw subErr;

      result.suspended += 1;
      console.info(
        JSON.stringify({
          event: "billing_grace_suspended",
          merchant_id: row.merchant_id,
          grace_started_at: startedAt,
          days_in_grace: Math.round(daysInGrace * 100) / 100,
          suspended_at: nowIso,
        }),
      );
    } catch (err) {
      result.failed += 1;
      console.error(
        JSON.stringify({
          event: "billing_grace_merchant_error",
          level: "critical",
          merchant_id: row.merchant_id,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return result;
}
