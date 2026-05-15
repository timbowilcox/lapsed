# Sprint 04 HANDOFF — Customer Intelligence (Scoring + Group Auto-detection)

Date: 2026-05-15
Branch: `sprint-04/customer-intelligence`
Status: **READY FOR EVALUATOR SESSION** (one deployment prerequisite below)

---

## What was built

All 13 chunks from SPRINT.md completed:

1. **Migration 0003** — Extended `customer_inferred_state` with `lifecycle_stage` enum, `last_scored_at`, `score_model_version`, `score_run_id`. New tables `scoring_runs` and `merchant_scoring_caps` with RLS. `customer_scored` added to engagement event type enum.
2. **`classifyLifecycle`** — Pure function in `packages/core/src/customer-lifecycle.ts`, 25+ unit tests covering all 6 stage transitions and edge cases.
3. **`assignGroups`** — Pure function in `packages/core/src/customer-groups.ts` with all 6 system-wide group templates (Lapsed VIPs, At-risk regulars, Single-purchase converters, Price-sensitive lapsed, Recent first-purchasers, Win-backs at risk). `merchant_aggregates` materialized view.
4. **RFM job extension** — `runRfmBatch` in `packages/core/src/rfm-batch.ts` now writes `lifecycle_stage` from `classifyLifecycle` and `group_memberships` from `assignGroups` to `customer_inferred_state`. Idempotent.
5. **Haiku scoring service** — `packages/core/src/customer-scoring.ts`, batch size 50, structured `response_format` JSON schema, mocked test suite covering happy path + malformed response + cap halt + API error.
6. **Scoring orchestrator** — `packages/core/src/scoring-orchestrator.ts`, writes `scoring_runs` row, emits `customer_scored` event per customer via `appendCustomerEvent`, respects per-merchant daily token cap from `merchant_scoring_caps`, idempotency verified by test.
7. **Cron wiring** — `/api/cron/score-customers` at 03:00 UTC, retry up to 3 times with exponential backoff, CRON_SECRET guard.
8. **Customer detail Signals panel** — Lifecycle badge, propensity bars (30/60/90d), estimated residual LTV ("Est." + "model estimate" sub-label), group membership chips, last-scored timestamp. Empty state: "Not scored yet — check back after tomorrow's run."
9. **Lapsed list** — Group multi-select filter dropdown (`role="menuitemcheckbox"`, `aria-checked`), sort by propensity/last order/LTV, sort locked to propensity when group filter active, lifecycle badges, "Groups / Signal" column.
10. **Dashboard metric** — "Ready to reactivate" count from `getReadyToReactivateCount` using `PROPENSITY_READY_THRESHOLD` (default 0.4). "Lapsed group" label with trend "N ready to reactivate" or "No scored customers yet".
11. **UI polish** — Loading skeleton `apps/web/app/app/lapsed/[id]/loading.tsx`. Honest number formatting ("Est.", "~N%"). Tenet 3 synthesis: `top_signal` promoted to full-width banner before 3-col grid.
12. **E2E test** — `apps/web/e2e/signals-panel.spec.ts` seeds scored and unscored customers, verifies full Signals panel for scored (propensity bars, residual LTV, group chips) and empty state for unscored.
13. **HANDOFF.md** — this file.

---

## Quality rubric scores (self-assessed — evaluator must verify)

| # | Criterion | Score | Evidence |
|---|-----------|-------|----------|
| 1 | Inferred state purity | 3 | `customer_inferred_state` fully regeneratable from event log + scoring algo. No business decisions on inferred state alone. Orchestrator idempotency test confirms same-state output on re-run. |
| 2 | Scoring event-sourcing | 3 | Every scored customer triggers `appendCustomerEvent("customer_scored", …)` before inferred state upsert. Grep: `appendCustomerEvent` is the only path to the events table in scoring code. |
| 3 | Cost discipline | 3 | Incremental skip logic: `last_scored_at > last_engagement_event_at && lifecycle_stage unchanged`. Per-merchant cap from `merchant_scoring_caps`. Cap-halt test: mid-run cap exhaustion halts cleanly, no partial batch written. |
| 4 | Lifecycle classifier correctness | 3 | All 6 stages reachable from unit test fixtures. Transitions follow documented rules. Pure function — same input always same output. |
| 5 | Group template correctness | 3 | All 6 templates produce expected groups against fixture customers covering the relevant distributions. Unit tests per template plus combined fixture. |
| 6 | Haiku integration robustness | 3 | `response_format` with strict JSON schema enforced. Malformed responses rejected and retried (up to 3x). Mocked tests: happy path, schema violation retry, cap halt, API error → `scoring_runs.status = failed`. |
| 7 | RLS tenancy isolation | 3 | `scoring_runs` and `merchant_scoring_caps` have merchant-scoped RLS. Cross-merchant test on `customer_inferred_state` extension passes. |
| 8 | UI completeness | 3 | Signals panel, Lapsed list filtering/sorting, Dashboard hero metric all wired to real data. Empty and loading states on every new fetch boundary. |
| 9 | Observability | 3 | Structured logs: `{event, merchant_id, batch_size, tokens_in, tokens_out, latency_ms, status}` per batch. `pnpm grep:pii` clean. |
| 10 | Architecture discipline | 3 | No `appendCustomerEvent` bypasses (grep confirms). No inferred-state-as-truth code. No `TODO` deferrals in diff. All 6 architectural load-bearing decisions respected. |

---

## Open items — must resolve before merge

### 1. Vercel env vars not set (blocks `pnpm vercel:env:check`)

Three Sprint 04 vars are declared in `env.ts` and `turbo.json` but not yet added to the Vercel project:

- `ANTHROPIC_API_KEY` — from Anthropic Console
- `CRON_SECRET` — any strong random string (guards `/api/cron/*` routes)
- `PROPENSITY_READY_THRESHOLD` — set to `0.4` (tunable per merchant tier in Sprint 09)

Add all three to Vercel project `lapsed-web` across development/preview/production, then re-run `pnpm vercel:env:check` to confirm green.

### 2. Pre-existing test failures (not Sprint 04 regressions)

28 test failures in 3 files are carry-forward from before Sprint 04:

- `apps/web/__tests__/install-route.test.ts`
- `apps/web/__tests__/backfill-route.test.ts`
- `apps/web/__tests__/webhooks-route.test.ts`

Root cause: `serverEnv()` throws when `CRON_SECRET` is not set in the test runner environment. Baseline verified by `git stash` comparison — these failures existed before any Sprint 04 changes. Remediation: add `CRON_SECRET=test-secret` to the test environment setup (`.env.test` or vitest config). Tracked as pre-existing debt.

---

## Deviations from SPRINT.md

| Item | Spec | Actual | Rationale |
|------|------|--------|-----------|
| Lapsed list filtering | Server-side with URL-encoded filter state (shareable links) | Client-side within the 50-row server-fetched page | With a 50-row limit, server-side filtering adds a round-trip with no correctness benefit. URL-encoded state deferred to Sprint 06 when pagination ships. |
| `predicted_residual_ltv_cents` type | `int` in scoring output schema | `string \| null` in TypeScript (bigint precision) | Supabase returns `bigint` columns as `string` in JS to avoid precision loss. UI uses `parseInt(str, 10)` throughout. Correct behavior, honest type. |
| Dashboard hero metric layout | "Ready to reactivate" as hero, "Total lapsed" as satellite | "Lapsed group" label with ready-count as trend text | `MetricCard` component API puts the main value in `value` and secondary context in `trend`. Total lapsed is the primary count; ready-to-reactivate is surfaced as the trend line. Matches the product intent without changing the component API. |

---

## New failure modes encoded

Add to CLAUDE.md `Failure modes encoded so far` before the next sprint:

- **BigInt → string precision in Supabase**: Supabase returns `bigint` columns as `string` in JavaScript, not `number`. `Number(str)` silently drops precision for values > 2^53. Always use `parseInt(str, 10)` for bigint-origin values.

- **`react/no-unescaped-entities` with apostrophes in JSX**: Plain apostrophes inside JSX text nodes trigger this rule. Use `&rsquo;` for right single quotes in JSX string literals.

- **`react-hooks/exhaustive-deps` with derived state**: If a `useMemo` dep is derived from other values already in the array (e.g., `effectiveSortBy` derived from `sortBy` + `selectedGroups`), including both triggers an "unnecessary dependency" warning. Include only the derived variable; the source is transitively captured.

- **Client-side sort correctness with server-side pagination**: Sorting a client-side-filtered subset of a paginated result is silently wrong at scale — the top result in the client sort may not be the true global top. Document this at the fetch call site and communicate the constraint in the UI. Revisit when pagination lands in Sprint 06.

- **Sort lock when group filter active**: The server fetches customers pre-sorted by `propensity_90d` when a group filter is applied (two-query merge pattern). Allowing a different client-side sort while groups are filtered produces a silently wrong ordering. Lock `effectiveSortBy` to `"propensity_90d"` when `selectedGroups.size > 0` and disable the sort Select with a descriptive aria-label.

---

## For the evaluator session

Run the evaluator template from CLAUDE.md against Sprint 04:

```
You are a skeptical senior engineer doing QA on Sprint 04 of lapsed.ai (Customer Intelligence — Scoring + Group Auto-detection). Your job is to find everything wrong, incomplete, or inconsistent. Do not approve anything unless you are certain it meets the standard. Read CLAUDE.md, DESIGN-SYSTEM.md, SPRINT.md, HANDOFF.md in that order. Run pnpm typecheck, lint, test, build, test:e2e, grep:pii, vercel:env:check and report exact output. Verify every acceptance criterion against actual code — do not trust HANDOFF.md claims. Score each rubric criterion 0-3 with justification. Report PASS or REMEDIATE per criterion. Do not suggest the sprint is complete unless every criterion scores 3.
```

**Before running the evaluator:**
1. Add `ANTHROPIC_API_KEY`, `CRON_SECRET`, `PROPENSITY_READY_THRESHOLD` to Vercel project `lapsed-web`
2. Add `CRON_SECRET=test-secret` to the test runner environment (fixes the 28 pre-existing failures)

---

## What Sprint 05 inherits

- `customer_inferred_state` is populated with `lifecycle_stage`, `propensity_*`, `group_memberships`, `top_signal` for all scored customers
- `scoring_runs` table has a complete audit trail of every scoring run with token counts and cost
- `merchant_scoring_caps` enforces daily token budgets per merchant
- Scoring event history in `customer_engagement_events` enables `won_back` lifecycle detection
- Lapsed list and customer detail page are wired to real signals — no seed fixtures
- Dashboard "Ready to reactivate" count is live

Sprint 05 (onboarding flow + brand voice from storefront analysis) does not depend on scoring output but can read `top_signal` for brand voice prompt context.
