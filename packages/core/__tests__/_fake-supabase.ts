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

interface SimpleCondition {
  kind: string;
  col: string;
  value: unknown;
}

interface Filter {
  kind: "eq" | "in" | "contains" | "gte" | "gt" | "lt" | "lte" | "is" | "not_is" | "or";
  col: string;
  value: unknown;
  /** Populated for kind="or": each element is an OR branch. */
  conditions?: SimpleCondition[];
}

/**
 * Parses the PostgREST `.or("col.op.val,col2.op2.val2")` string format into
 * an array of simple conditions. Values after the second dot are taken literally
 * (handles ISO 8601 timestamps which contain dots).
 */
function parseOrString(query: string): SimpleCondition[] {
  return query.split(",").map((part) => {
    const firstDot = part.indexOf(".");
    const col = part.slice(0, firstDot);
    const rest = part.slice(firstDot + 1);
    const secondDot = rest.indexOf(".");
    const op = rest.slice(0, secondDot);
    const rawVal = rest.slice(secondDot + 1);
    const value = rawVal === "null" ? null : rawVal;
    return { kind: op, col, value };
  });
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
    r.sentiment_alpha ??= 1;
    r.sentiment_beta ??= 1;
    r.observation_count ??= 0;
    r.last_updated_at ??= nowIso;
    r.order_alpha ??= 1;
    r.order_beta ??= 1;
    r.order_observation_count ??= 0;
    r.order_last_updated_at ??= null;
    r.created_at ??= nowIso;
  }
  if (table === "campaign_group_snapshots") {
    r.included_in_holdout ??= false;
    r.created_at ??= nowIso;
  }
  if (table === "insights") {
    r.state ??= "active";
    r.created_at ??= nowIso;
    r.expires_at ??= null;
  }
  return r;
}

function applyCondition(row: FakeRow, kind: string, col: string, value: unknown): boolean {
  const v = row[col];
  if (kind === "eq") return v === value;
  if (kind === "in") return (value as unknown[]).includes(v);
  if (kind === "gte") return (v as string) >= (value as string);
  if (kind === "gt") return (v as string) > (value as string);
  if (kind === "lt") return (v as string) < (value as string);
  if (kind === "lte") return (v as string) <= (value as string);
  if (kind === "is") return value === null ? v === null || v === undefined : v === value;
  if (kind === "not_is") return value === null ? v !== null && v !== undefined : v !== value;
  if (kind === "contains") return Array.isArray(v) && (value as unknown[]).every((x) => v.includes(x));
  return true;
}

function matches(row: FakeRow, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "or") {
      return (f.conditions ?? []).some((c) => applyCondition(row, c.kind, c.col, c.value));
    }
    return applyCondition(row, f.kind, f.col, f.value);
  });
}

export interface FakeSupabase {
  client: LapsedSupabaseClient;
  /** Direct access to the backing tables for assertions. */
  tables: Record<string, FakeRow[]>;
}

export interface FakeSupabaseOptions {
  /**
   * Inject a failure for a specific table + operation. An optional `code`
   * is attached to the returned error (e.g. "23505" for a unique violation).
   */
  failOn?: Array<{
    table: string;
    op: "select" | "insert" | "update" | "upsert";
    code?: string;
  }>;
}

/**
 * Builds an in-memory Supabase fake. `seed` pre-populates tables; the returned
 * `tables` map can be inspected directly after running code under test.
 * `opts.failOn` injects an error for a given table + operation.
 */
export function makeFakeSupabase(
  seed: Record<string, FakeRow[]> = {},
  opts: FakeSupabaseOptions = {},
): FakeSupabase {
  const tables: Record<string, FakeRow[]> = {};
  for (const [t, rows] of Object.entries(seed)) {
    tables[t] = rows.map((r) => ({ ...r }));
  }
  const tableOf = (t: string): FakeRow[] => (tables[t] ??= []);
  const failOn = opts.failOn ?? [];
  const failureFor = (table: string, op: string): { message: string; code?: string } | null => {
    const f = failOn.find((x) => x.table === table && x.op === op);
    if (!f) return null;
    return { message: `fake error: ${op} on ${table}`, code: f.code };
  };

  function makeBuilder(table: string, op: "select" | "insert" | "update" | "upsert", payload?: unknown) {
    const filters: Filter[] = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let wantSingle = false;
    let wantMaybeSingle = false;
    let countHead = false;

    function run(): { data: unknown; error: unknown; count?: number } {
      const failure = failureFor(table, op);
      if (failure) return { data: null, error: failure };
      if (op === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = rows.map((r) => applyDefaults(table, r as FakeRow));
        tableOf(table).push(...inserted);
        if (wantSingle || wantMaybeSingle) return { data: inserted[0] ?? null, error: null };
        return { data: inserted, error: null };
      }
      if (op === "upsert") {
        const { rows, opts: upsertOpts } = payload as {
          rows: FakeRow | FakeRow[];
          opts?: { onConflict?: string; ignoreDuplicates?: boolean };
        };
        const rowsArr = Array.isArray(rows) ? rows : [rows];
        const conflictCols = upsertOpts?.onConflict
          ? upsertOpts.onConflict.split(",").map((c) => c.trim())
          : [];
        const ignoreDuplicates = upsertOpts?.ignoreDuplicates === true;
        for (const raw of rowsArr) {
          const row = applyDefaults(table, raw);
          if (conflictCols.length > 0) {
            const existing = tableOf(table).find((r) =>
              conflictCols.every((col) => r[col] === row[col]),
            );
            if (existing) {
              // ON CONFLICT: DO NOTHING when ignoreDuplicates, else DO UPDATE.
              if (!ignoreDuplicates) Object.assign(existing, row);
              continue;
            }
          }
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
      // .range(from, to) — Supabase semantics: inclusive both ends.
      if (rangeFrom !== null) {
        rows = rows.slice(rangeFrom, (rangeTo ?? rows.length) + 1);
      }
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
    builder.gt = (col: string, value: unknown) => {
      filters.push({ kind: "gt", col, value });
      return builder;
    };
    builder.lt = (col: string, value: unknown) => {
      filters.push({ kind: "lt", col, value });
      return builder;
    };
    builder.not = (col: string, op: string, value: unknown) => {
      // Only the `.not(col, "is", null)` form is used by the codebase.
      if (op === "is") filters.push({ kind: "not_is", col, value });
      return builder;
    };
    builder.lte = (col: string, value: unknown) => {
      filters.push({ kind: "lte", col, value });
      return builder;
    };
    builder.is = (col: string, value: unknown) => {
      filters.push({ kind: "is", col, value });
      return builder;
    };
    builder.or = (query: string) => {
      filters.push({ kind: "or", col: "", value: null, conditions: parseOrString(query) });
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
    builder.range = (from: number, to: number) => {
      rangeFrom = from;
      rangeTo = to;
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
      upsert: (rows: unknown, upsertOpts?: unknown) =>
        makeBuilder(table, "upsert", { rows, opts: upsertOpts }),
    }),
  } as unknown as LapsedSupabaseClient;

  return { client, tables };
}
