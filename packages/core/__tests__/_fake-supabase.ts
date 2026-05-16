// In-memory Supabase fake — a stateful test double that actually stores rows
// and applies filters, so multi-step orchestration (the approval state
// machine, the materializer, the bandit initializer) can be exercised
// end-to-end without a live database.
//
// Supports the subset of the PostgREST builder the Sprint 06 core modules
// use: select/insert/update/upsert with eq/in/contains/gte/order/limit and
// single/maybeSingle, plus upsert onConflict + ignoreDuplicates.

import { randomUUID } from "node:crypto";
import type { LapsedSupabaseClient } from "@lapsed/db";

export type FakeRow = Record<string, unknown>;

interface Filter {
  kind: "eq" | "in" | "contains" | "gte";
  col: string;
  value: unknown;
}

function applyDefaults(table: string, input: FakeRow): FakeRow {
  const r: FakeRow = { ...input };
  const nowIso = new Date().toISOString();
  if (r.id === undefined && table !== "campaign_group_snapshots" && table !== "bandit_state") {
    r.id = randomUUID();
  }
  if (table === "campaign_proposals") {
    r.status ??= "proposed";
    r.version_number ??= 1;
    r.generated_at ??= nowIso;
    r.created_at ??= nowIso;
    r.approved_at ??= null;
    r.approved_by_user_id ??= null;
    r.rejected_at ??= null;
    r.rejection_reason ??= null;
    r.supersedes_proposal_id ??= null;
  }
  if (table === "campaign_arms") {
    r.bandit_arm_id ??= randomUUID();
    r.expected_impact ??= {};
    r.created_at ??= nowIso;
  }
  if (table === "campaign_events") {
    r.ingested_at ??= nowIso;
    r.payload ??= {};
  }
  if (table === "bandit_state") {
    r.alpha ??= 1;
    r.beta ??= 1;
    r.observation_count ??= 0;
    r.last_updated_at ??= nowIso;
    r.created_at ??= nowIso;
  }
  if (table === "campaign_group_snapshots") {
    r.included_in_holdout ??= false;
    r.created_at ??= nowIso;
  }
  return r;
}

function matches(row: FakeRow, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = row[f.col];
    if (f.kind === "eq") return v === f.value;
    if (f.kind === "in") return (f.value as unknown[]).includes(v);
    if (f.kind === "gte") return (v as string) >= (f.value as string);
    if (f.kind === "contains") {
      return Array.isArray(v) && (f.value as unknown[]).every((x) => v.includes(x));
    }
    return true;
  });
}

export interface FakeSupabase {
  client: LapsedSupabaseClient;
  /** Direct access to the backing tables for assertions. */
  tables: Record<string, FakeRow[]>;
}

/**
 * Builds an in-memory Supabase fake. `seed` pre-populates tables; the returned
 * `tables` map can be inspected directly after running code under test.
 */
export function makeFakeSupabase(seed: Record<string, FakeRow[]> = {}): FakeSupabase {
  const tables: Record<string, FakeRow[]> = {};
  for (const [t, rows] of Object.entries(seed)) {
    tables[t] = rows.map((r) => ({ ...r }));
  }
  const tableOf = (t: string): FakeRow[] => (tables[t] ??= []);

  function makeBuilder(table: string, op: "select" | "insert" | "update" | "upsert", payload?: unknown) {
    const filters: Filter[] = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null;
    let wantSingle = false;
    let wantMaybeSingle = false;
    let countHead = false;

    function run(): { data: unknown; error: unknown; count?: number } {
      if (op === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = rows.map((r) => applyDefaults(table, r as FakeRow));
        tableOf(table).push(...inserted);
        if (wantSingle || wantMaybeSingle) return { data: inserted[0] ?? null, error: null };
        return { data: inserted, error: null };
      }
      if (op === "upsert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        for (const raw of rows as FakeRow[]) {
          const row = applyDefaults(table, raw);
          tableOf(table).push(row);
        }
        return { data: null, error: null };
      }
      if (op === "update") {
        const target = tableOf(table).filter((r) => matches(r, filters));
        for (const r of target) Object.assign(r, payload as FakeRow);
        if (wantSingle || wantMaybeSingle) return { data: target[0] ?? null, error: null };
        return { data: target, error: null };
      }
      // select
      let rows = tableOf(table).filter((r) => matches(r, filters));
      for (let i = orders.length - 1; i >= 0; i--) {
        const { col, asc } = orders[i]!;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return asc ? cmp : -cmp;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      if (countHead) return { data: null, error: null, count: rows.length };
      if (wantSingle || wantMaybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows.map((r) => ({ ...r })), error: null };
    }

    const builder: Record<string, unknown> = {};
    builder.eq = (col: string, value: unknown) => {
      filters.push({ kind: "eq", col, value });
      return builder;
    };
    builder.in = (col: string, value: unknown[]) => {
      filters.push({ kind: "in", col, value });
      return builder;
    };
    builder.contains = (col: string, value: unknown[]) => {
      filters.push({ kind: "contains", col, value });
      return builder;
    };
    builder.gte = (col: string, value: unknown) => {
      filters.push({ kind: "gte", col, value });
      return builder;
    };
    builder.order = (col: string, opts?: { ascending?: boolean }) => {
      orders.push({ col, asc: opts?.ascending ?? true });
      return builder;
    };
    builder.limit = (n: number) => {
      limitN = n;
      return builder;
    };
    builder.select = (_cols?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) countHead = true;
      return builder;
    };
    builder.single = () => {
      wantSingle = true;
      return builder;
    };
    builder.maybeSingle = () => {
      wantMaybeSingle = true;
      return builder;
    };
    builder.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(onFulfilled(run()));
    return builder;
  }

  const client = {
    from: (table: string) => ({
      select: (cols?: string, opts?: { count?: string; head?: boolean }) => {
        const b = makeBuilder(table, "select");
        (b.select as (c?: string, o?: unknown) => unknown)(cols, opts);
        return b;
      },
      insert: (rows: unknown) => makeBuilder(table, "insert", rows),
      update: (row: unknown) => makeBuilder(table, "update", row),
      upsert: (rows: unknown) => makeBuilder(table, "upsert", rows),
    }),
  } as unknown as LapsedSupabaseClient;

  return { client, tables };
}
