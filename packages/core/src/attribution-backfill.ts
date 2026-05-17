// Attribution results backfill — Sprint 09 chunk 4.
//
// One-shot migration. Sprint 08 materialised `attribution_results` rows under
// the as-attempted treatment cohort (treatment = customers who received an
// outbound; holdout = full ITT snapshot). Sprint 09 chunks 2-3 corrected that
// to symmetric ITT (decision 27): both cohorts are the frozen
// `campaign_group_snapshots`, measured over the campaign-calendar window. This
// backfill re-computes every existing `attribution_results` row under the new
// methodology so already-reported lift figures become consistent with what the
// nightly batch will produce going forward.
//
// IRREVERSIBLE. Once a row is re-written, the old numbers survive ONLY in the
// `attribution_methodology_migration` audit event. Decision 27 explicitly
// authorises this backfill ("The Sprint 08 attribution_results rows were
// backfilled under the new methodology with an audit trail preserving old vs
// new values"). This is the second authorised writer of `attribution_results`
// alongside the batch cron (decision 26) — both are cron-class, never
// request-time.
//
// IN-PLACE UPDATE, NOT DELETE+RECREATE. A changed row is UPDATEd by id; the
// (campaign_id, window_close_date) identity is preserved. No row is deleted.
//
// AUDIT-FIRST, CRASH-SAFE. The two writes (audit INSERT, row UPDATE) are not
// transactional, so the audit event is written FIRST. The failure modes are:
//   - audit INSERT fails        → row untouched, no audit → a re-run retries
//                                  cleanly (recompute still differs).
//   - audit INSERT ok, UPDATE fails → row holds the OLD (still-defensible)
//                                  values, audit event exists → a re-run takes
//                                  the SELF-HEAL path: it sees the audit key,
//                                  recomputes, and re-applies the UPDATE.
// The audit event is therefore never silently lost, and a re-run after any
// partial failure converges every row to the symmetric-ITT values. The audit
// event captures the FIRST migration's old vs new values.
//
// All currency is integer cents.

import type { LapsedSupabaseClient, Database, Json } from "@lapsed/db";
import { computeIncrementalRevenue, type IncrementalRevenueResult } from "./incremental-revenue";
import { computeLtvRestoration, type LtvRestorationResult } from "./ltv-restoration";

type AttributionResultRow = Database["public"]["Tables"]["attribution_results"]["Row"];

/** The numeric fields whose old vs new values are audited and compared. */
export interface AttributionResultSnapshot {
  treatment_cohort_size: number;
  holdout_cohort_size: number;
  treatment_revenue_cents: number;
  holdout_revenue_cents: number;
  incremental_revenue_cents: number;
  incremental_ci_low_cents: number | null;
  incremental_ci_high_cents: number | null;
  ltv_restored_cents: number;
  ltv_ci_low_cents: number | null;
  ltv_ci_high_cents: number | null;
}

export interface AttributionBackfillResult {
  /** attribution_results rows examined. */
  rowsScanned: number;
  /** Rows whose recomputed values differed and were re-written + audited. */
  rowsMigrated: number;
  /**
   * Rows that already had an audit event but whose stored values did not yet
   * match the recompute — re-applied (a partial-failure re-run heals them).
   */
  rowsHealed: number;
  /** Rows already migrated AND already holding the migrated values — skipped. */
  rowsAlreadyMigrated: number;
  /** Rows recomputed to identical values — left untouched, no audit event. */
  rowsUnchanged: number;
  /** Rows whose recompute threw — counted and skipped, batch still resolves. */
  errors: number;
}

export interface RunAttributionBackfillOptions {
  /** Restrict the run to one merchant; omit to process every merchant. */
  merchantId?: string;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

const AUDIT_EVENT_TYPE = "attribution_methodology_migration";

/** Extracts a diagnosable message from any thrown value (incl. PostgREST objects). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** The audited fields, projected from an attribution_results row. */
function snapshotOf(row: AttributionResultRow): AttributionResultSnapshot {
  return {
    treatment_cohort_size: row.treatment_cohort_size,
    holdout_cohort_size: row.holdout_cohort_size,
    treatment_revenue_cents: row.treatment_revenue_cents,
    holdout_revenue_cents: row.holdout_revenue_cents,
    incremental_revenue_cents: row.incremental_revenue_cents,
    incremental_ci_low_cents: row.incremental_ci_low_cents,
    incremental_ci_high_cents: row.incremental_ci_high_cents,
    ltv_restored_cents: row.ltv_restored_cents,
    ltv_ci_low_cents: row.ltv_ci_low_cents,
    ltv_ci_high_cents: row.ltv_ci_high_cents,
  };
}

/** The audited fields, projected from a fresh symmetric-ITT recompute. */
function snapshotOfRecompute(
  inc: IncrementalRevenueResult,
  ltv: LtvRestorationResult,
): AttributionResultSnapshot {
  return {
    treatment_cohort_size: inc.treatmentCohortSize,
    holdout_cohort_size: inc.holdoutCohortSize,
    treatment_revenue_cents: inc.treatmentRevenueCents,
    holdout_revenue_cents: inc.holdoutRevenueCents,
    incremental_revenue_cents: inc.incrementalRevenueCents,
    incremental_ci_low_cents: inc.incrementalCiLowCents,
    incremental_ci_high_cents: inc.incrementalCiHighCents,
    ltv_restored_cents: ltv.ltvRestoredCents,
    ltv_ci_low_cents: ltv.ltvCiLowCents,
    ltv_ci_high_cents: ltv.ltvCiHighCents,
  };
}

/** True when two snapshots are field-for-field equal. */
function snapshotsEqual(a: AttributionResultSnapshot, b: AttributionResultSnapshot): boolean {
  return (
    a.treatment_cohort_size === b.treatment_cohort_size &&
    a.holdout_cohort_size === b.holdout_cohort_size &&
    a.treatment_revenue_cents === b.treatment_revenue_cents &&
    a.holdout_revenue_cents === b.holdout_revenue_cents &&
    a.incremental_revenue_cents === b.incremental_revenue_cents &&
    a.incremental_ci_low_cents === b.incremental_ci_low_cents &&
    a.incremental_ci_high_cents === b.incremental_ci_high_cents &&
    a.ltv_restored_cents === b.ltv_restored_cents &&
    a.ltv_ci_low_cents === b.ltv_ci_low_cents &&
    a.ltv_ci_high_cents === b.ltv_ci_high_cents
  );
}

/** Writes the recomputed snapshot onto an attribution_results row, in place. */
async function applyRow(
  client: LapsedSupabaseClient,
  rowId: string,
  snap: AttributionResultSnapshot,
  insufficientEvidence: boolean,
  nowIso: string,
): Promise<void> {
  const { error } = await client
    .from("attribution_results")
    .update({
      treatment_cohort_size: snap.treatment_cohort_size,
      holdout_cohort_size: snap.holdout_cohort_size,
      treatment_revenue_cents: snap.treatment_revenue_cents,
      holdout_revenue_cents: snap.holdout_revenue_cents,
      incremental_revenue_cents: snap.incremental_revenue_cents,
      incremental_ci_low_cents: snap.incremental_ci_low_cents,
      incremental_ci_high_cents: snap.incremental_ci_high_cents,
      ltv_restored_cents: snap.ltv_restored_cents,
      ltv_ci_low_cents: snap.ltv_ci_low_cents,
      ltv_ci_high_cents: snap.ltv_ci_high_cents,
      insufficient_evidence: insufficientEvidence,
      computed_at: nowIso,
    })
    .eq("id", rowId);
  if (error) throw error;
}

/**
 * Re-computes every `attribution_results` row under the symmetric-ITT
 * methodology (decision 27) and re-writes the rows whose values changed,
 * leaving an `attribution_methodology_migration` audit event per changed row.
 *
 * Idempotent + crash-safe: a re-run skips rows already migrated, and heals any
 * row whose audit event was written but whose UPDATE did not land.
 */
export async function runAttributionBackfill(
  client: LapsedSupabaseClient,
  opts: RunAttributionBackfillOptions = {},
): Promise<AttributionBackfillResult> {
  const now = opts.now ?? (() => new Date());

  const result: AttributionBackfillResult = {
    rowsScanned: 0,
    rowsMigrated: 0,
    rowsHealed: 0,
    rowsAlreadyMigrated: 0,
    rowsUnchanged: 0,
    errors: 0,
  };

  // Existing attribution_results rows (optionally merchant-scoped).
  let resultQuery = client.from("attribution_results").select("*");
  if (opts.merchantId) resultQuery = resultQuery.eq("merchant_id", opts.merchantId);
  const { data: resultRows, error: resultErr } = await resultQuery;
  if (resultErr) throw resultErr;
  const rows = (resultRows ?? []) as AttributionResultRow[];

  // The set of (campaign_id, window_close_date) keys already audited by a
  // prior run — read from the audit events. This is the idempotency ledger;
  // scoped to the same merchant when the run is merchant-scoped.
  let auditQuery = client
    .from("subscription_events")
    .select("merchant_id, data")
    .eq("event_type", AUDIT_EVENT_TYPE);
  if (opts.merchantId) auditQuery = auditQuery.eq("merchant_id", opts.merchantId);
  const { data: auditRows, error: auditErr } = await auditQuery;
  if (auditErr) throw auditErr;
  const migrated = new Set<string>();
  for (const ev of (auditRows ?? []) as Array<{ data: unknown }>) {
    const d = ev.data as { campaign_id?: string; window_close_date?: string } | null;
    if (d?.campaign_id && d?.window_close_date) {
      migrated.add(`${d.campaign_id}|${d.window_close_date}`);
    }
  }

  for (const row of rows) {
    result.rowsScanned += 1;
    const key = `${row.campaign_id}|${row.window_close_date}`;

    try {
      // Recompute under symmetric ITT (the chunk-2/3 engines).
      const inc = await computeIncrementalRevenue(client, row.campaign_id);
      const ltv = await computeLtvRestoration(client, row.campaign_id);
      const oldSnap = snapshotOf(row);
      const newSnap = snapshotOfRecompute(inc, ltv);

      if (migrated.has(key)) {
        // Already audited. If the row does not yet hold the recomputed values,
        // a prior run's UPDATE did not land — re-apply it (self-heal). If it
        // already matches, this is a clean no-op skip.
        if (snapshotsEqual(oldSnap, newSnap)) {
          result.rowsAlreadyMigrated += 1;
        } else {
          await applyRow(client, row.id, newSnap, inc.insufficientEvidence, now().toISOString());
          result.rowsHealed += 1;
          console.info(
            JSON.stringify({
              event: "attribution_backfill_healed",
              merchant_id: row.merchant_id,
              campaign_id: row.campaign_id,
              window_close_date: row.window_close_date,
            }),
          );
        }
        continue;
      }

      if (snapshotsEqual(oldSnap, newSnap)) {
        // The methodology change did not move this row — nothing to migrate,
        // no audit event. A re-run re-reaches this branch (still a no-op).
        result.rowsUnchanged += 1;
        continue;
      }

      // AUDIT FIRST — the audit event is the sole surviving record of the old
      // values, so it is written before the row is overwritten. If the UPDATE
      // below fails, a re-run finds this event and heals the row.
      const { error: auditInsertErr } = await client.from("subscription_events").insert({
        merchant_id: row.merchant_id,
        stripe_event_id: null,
        event_type: AUDIT_EVENT_TYPE,
        data: {
          campaign_id: row.campaign_id,
          window_close_date: row.window_close_date,
          migrated_at: now().toISOString(),
          old: oldSnap,
          new: newSnap,
          delta_incremental_cents:
            newSnap.incremental_revenue_cents - oldSnap.incremental_revenue_cents,
        } as unknown as Json,
      });
      if (auditInsertErr) throw auditInsertErr;

      // In-place UPDATE — the (campaign_id, window_close_date) identity and the
      // row id are preserved; the row is never deleted and re-created.
      await applyRow(client, row.id, newSnap, inc.insufficientEvidence, now().toISOString());

      result.rowsMigrated += 1;
      console.info(
        JSON.stringify({
          event: "attribution_backfill_migrated",
          merchant_id: row.merchant_id,
          campaign_id: row.campaign_id,
          window_close_date: row.window_close_date,
          old_incremental_cents: oldSnap.incremental_revenue_cents,
          new_incremental_cents: newSnap.incremental_revenue_cents,
          delta_cents: newSnap.incremental_revenue_cents - oldSnap.incremental_revenue_cents,
        }),
      );
    } catch (err) {
      result.errors += 1;
      console.error(
        JSON.stringify({
          event: "attribution_backfill_row_error",
          merchant_id: row.merchant_id,
          campaign_id: row.campaign_id,
          window_close_date: row.window_close_date,
          error: errorMessage(err),
        }),
      );
    }
  }

  return result;
}
