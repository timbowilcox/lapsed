# Sprint 04 â€” Customer Intelligence (Scoring + Group Auto-detection)

Date: 2026-05-15
Repo: timbowilcox/lapsed
Branch: `sprint-04/customer-intelligence`
Estimated effort: 5â€“7 days (multiple sessions, suitable for overnight runs)

## Required reading before starting

In order â€” not optional:

1. **CLAUDE.md** â€” architectural load-bearing decisions, sprint sequence, evaluator template
2. **PRODUCT.md** â€” Module 2 (Customer intelligence) is the spec this sprint implements. Pay particular attention to the principle "inferred state is derived, never canonical â€” regeneratable from the event log + the scoring algorithm"
3. **DESIGN-SYSTEM.md** â€” for the UI surfaces in chunks 9â€“11
4. **Sprint 03 HANDOFF.md** (on main after Sprint 03 merge) â€” to understand the canonical event helpers, materializeCustomer pattern, and the architectural commitments already made
5. **`.claude/agents/architecture-guardian.md`** â€” dispatch after every chunk, verdicts binding

## Scope

Build the customer intelligence layer on top of Sprint 03's memory graph. Score every customer's reactivation propensity (30/60/90-day) using Haiku 4.5. Detect customer groups algorithmically from RFM + engagement patterns. Classify lifecycle stage. Surface all three on the Lapsed list, customer detail, and dashboard. Idempotent, batched, cost-capped per merchant.

Sprint 03 built the *what* (customer data, events). Sprint 04 builds the *who's worth reaching out to* (propensity + groups + lifecycle). Sprint 06 will use this output to build campaigns. Sprint 07 will use it to prioritize the conversation queue.

## Architectural commitments (from CLAUDE.md, restated for this sprint)

These are still in force from Sprint 03. No deferrals.

- **Inferred state is derived, never canonical.** `customer_inferred_state` is a cache that can be fully regenerated from the event log + the scoring algorithm. Never make a business decision on inferred state alone â€” always cross-reference the event log when the decision matters.
- **Scoring decisions are themselves events.** Each scoring run writes a `customer_scored` event to `customer_engagement_events`. This gives historical traceability of how scores changed and feeds the bandit's outcome learning loop in Sprint 06.
- **Canonical event helpers.** All event writes go through `appendCustomerEvent` from `@lapsed/core`. No direct table inserts.
- **RLS enforcement.** Every new table has merchant-scoped RLS. Cross-merchant tests required.
- **Cost discipline.** Per-merchant daily token cap on Haiku spend. Default cap configurable. Skip customers with no engagement changes since last score (incremental scoring is the default; full re-score is opt-in).

## In scope

### 1. Schema additions

Migration `0003_customer_intelligence.sql`:

- Extend `customer_inferred_state` with: `score_model_version` text, `score_run_id` uuid (links to the scoring run that produced this row), `lifecycle_stage` enum, `last_scored_at` timestamptz
- Add enum `lifecycle_stage`: `new`, `engaged`, `at_risk`, `lapsed`, `won_back`, `churned`
- Add `customer_engagement_events.event_type` enum value: `customer_scored`
- New table `scoring_runs` â€” id, merchant_id, started_at, finished_at, model_version, customers_scored int, tokens_input int, tokens_output int, cost_cents int, status (running/succeeded/failed), error_message text
- New table `merchant_scoring_caps` â€” merchant_id, daily_token_cap int (default 10000000), period_start date, tokens_used_today int. Reset daily by the scoring job.

All new tables have RLS policies. `customer_inferred_state` extension keeps the existing RLS.

### 2. Lifecycle stage classifier

Pure function in `packages/core/src/customer-lifecycle.ts`:

```ts
function classifyLifecycle(customer: MaterializedCustomer): LifecycleStage
```

Deterministic rules (no LLM):
- `new` â€” first order â‰¤ 30 days ago, exactly 1 order
- `engaged` â€” last order â‰¤ 60 days ago AND â‰¥ 2 orders in past 12 months
- `at_risk` â€” last order 60â€“180 days ago AND previously classified as `engaged`
- `lapsed` â€” last order > 180 days ago
- `won_back` â€” current lifecycle is `engaged` AND was `lapsed` at any point in past 90 days (requires looking at the customer_scored event history)
- `churned` â€” last order > 365 days AND no engagement events in past 180 days

Unit-tested across all edge cases. Idempotent (same input â†’ same output).

### 3. Group auto-detection

Pure function in `packages/core/src/customer-groups.ts`:

```ts
function assignGroups(customer: MaterializedCustomer, merchantContext: MerchantContext): GroupAssignment[]
```

System-wide group templates applied per-merchant. Sprint 04 ships these templates:

- **Lapsed VIPs** â€” top 10% of merchant's LTV distribution AND `lapsed` lifecycle
- **At-risk regulars** â€” `at_risk` lifecycle AND â‰¥ 3 prior orders
- **Single-purchase converters** â€” exactly 1 order ever AND order > 60 days ago AND order value > merchant median AOV
- **Price-sensitive lapsed** â€” `lapsed` AND avg order value < merchant median AOV AND â‰¥ 2 orders
- **Recent first-purchasers** â€” `new` lifecycle AND first order â‰¥ 14 days ago (warming up for a second purchase nudge)
- **Win-backs at risk** â€” `won_back` lifecycle with no engagement event in past 30 days

Merchant context comes from a materialized view computed nightly: `merchant_aggregates` (median AOV, LTV deciles, total customers, etc.).

Returns array of group memberships with confidence (deterministic 0/1 for Sprint 04 â€” fuzzy memberships defer to Sprint 06 if useful).

### 4. RFM refresh extension

Sprint 03's `customer_rfm` table needs the lifecycle stage written to it. Extend the nightly RFM job to call `classifyLifecycle` and persist. This is materialized state â€” full regeneration is supported.

### 5. Haiku propensity scoring service

Module: `packages/core/src/customer-scoring.ts`

Approach:
- Batched scoring â€” 50 customers per Haiku call to amortize prompt overhead
- Structured output via `response_format` with strict JSON schema (no free-form parsing)
- Schema per customer in output: `propensity_30d` (0â€“1), `propensity_60d` (0â€“1), `propensity_90d` (0â€“1), `predicted_residual_ltv_cents` int, `top_signal` text (â‰¤ 100 chars for debugging)
- Input per customer (compressed): RFM (R/F/M scores), order history summary (count, AOV, last_order_days_ago, lifecycle_stage), engagement event counts past 90 days (opens, clicks, web_views), top categories from order line items
- Merchant context in system prompt (once per batch, not per customer): industry, AOV distribution, typical reactivation patterns

Cost-control rules:
- Skip customers whose `last_scored_at` is more recent than their `last_engagement_event_at` AND whose `lifecycle_stage` hasn't changed (incremental scoring)
- Force full re-score on model version change
- Per-merchant daily token cap consulted before each batch â€” if cap reached, halt scoring for that merchant, log, retry tomorrow

Tests use a mock Anthropic client. Determinism: given the same input bytes, the prompt is identical and the structured output schema is enforced.

### 6. Scoring job orchestrator

Module: `apps/web/src/jobs/score-customers.ts` (or wherever Sprint 03 put its background jobs).

Per merchant:
1. Open a `scoring_runs` row with status `running`
2. Find scorable customers (filter: lifecycle â‰  `churned`, eligibility per cost-control rules above)
3. Batch into chunks of 50
4. For each batch: call Haiku â†’ parse â†’ write `customer_scored` event per customer â†’ update `customer_inferred_state`
5. Track tokens and cost; halt if cap reached
6. Close `scoring_runs` row with status `succeeded` or `failed` + counts

Idempotent: re-running for the same merchant in the same window produces consistent state (events are written, but state ends up the same). Run boundaries clean â€” never leave a half-scored merchant.

### 7. Nightly cron wiring

Vercel cron at 03:00 merchant timezone (one hour after the Sprint 03 materialized profile job at 02:00). Order matters â€” scoring reads from the freshly materialized customer profile.

If a merchant's cron run fails, it's retried up to 3 times with exponential backoff. After 3 failures, mark `scoring_runs.status = failed` and surface in the Settings page sync status (Sprint 03 already has the sync surface).

### 8. UI â€” Customer detail page

`apps/web/app/app/lapsed/[id]/page.tsx`:

Add a "Signals" panel displaying:
- Lifecycle stage badge (`new` / `engaged` / `at_risk` / `lapsed` / `won_back` / `churned`)
- Propensity scores (30/60/90-day bars, calm visual treatment per design tenet 7)
- Predicted residual LTV (formatted currency)
- Group memberships (badge list)
- Last scored timestamp (small text)

Empty state: "Not scored yet â€” check back after tomorrow's run."
Error state: "Scoring failed for this customer â€” retry?"

### 9. UI â€” Lapsed list

`apps/web/app/app/lapsed/page.tsx`:

Add:
- Group filter dropdown at top â€” multi-select, defaults to all
- Sort options: by propensity_90d desc (default), by last order date desc, by LTV desc
- New column: top signal (one-line text from scoring output, truncated)
- Lifecycle badge on each row

Filtering happens server-side via the DB read helper. URL-encoded filter state so links are shareable.

### 10. UI â€” Dashboard hero metric

`apps/web/app/app/page.tsx`:

Replace the existing "Lapsed customers" count with two metrics:
- **Ready to reactivate** â€” count of customers with `propensity_30d â‰¥ 0.4` (calibrate the threshold conservatively; expose in env var for tuning)
- **Total lapsed** â€” existing count

Hero number is "Ready to reactivate." Total lapsed becomes a smaller satellite metric. Per design tenet 4 (honest numbers): if scoring hasn't run yet, show "Pending first score" rather than a misleading zero.

### 11. UI states (empty / loading / error)

Every new fetch boundary gets all three. Same pattern as Sprint 03 chunks 12â€“15.

### 12. Tests

Non-negotiable:

- `classifyLifecycle` â€” unit tests covering each stage transition + edge cases (zero orders, future-dated orders, etc.)
- `assignGroups` â€” unit tests per template, plus an integration test with realistic merchant fixtures
- `customer-scoring.ts` â€” unit tests with mocked Anthropic client (deterministic input â†’ expected output schema validation)
- Scoring job orchestrator â€” idempotency test (run twice â†’ same state), cap-respecting test (cap reached mid-run â†’ halts cleanly), per-merchant isolation test
- Cross-merchant RLS test on `customer_inferred_state` extension, `scoring_runs`, `merchant_scoring_caps`
- E2E test: scoring run produces visible signals on customer detail page

### 13. Observability

- Structured log per scoring batch: merchant_id (truncated), batch_size, tokens_in, tokens_out, latency_ms, status
- No PII in logs (no customer emails, names, phone, order details)
- Cost dashboard query: tokens Ã— pricing Ã— merchant aggregation (Sprint 09 surfaces this in billing; for Sprint 04, just log it)

## Out of scope (do not touch â€” these are later sprints)

- Reactivation campaign generation â€” Sprint 06
- Conversation engine â€” Sprint 07
- Bandit state / hypothesis testing â€” Sprint 06
- Brand voice / agent identity â€” Sprint 05
- Holdout group assignment for campaigns â€” Sprint 08
- Attribution math â€” Sprint 08
- Stripe billing â€” Sprint 09
- Voice channel / email channel â€” post-v1
- Cross-merchant aggregate scoring (network-effect intelligence) â€” Sprint 10+
- Merchant-tunable group definitions â€” defer to Sprint 06
- Real-time scoring on individual engagement events â€” defer; nightly batched is the v1 cadence
- Score-driven priority weighting in conversation queue â€” Sprint 07
- Recharge / Klaviyo / Gorgias integrations
- Storefront pixel installation
- Any change to the agent operating model or design tenets

## Acceptance criteria

Every box must be checked with evidence in the PR description.

- [ ] Migration `0003_customer_intelligence.sql` creates all new tables/columns with RLS policies, tested cross-merchant
- [ ] `classifyLifecycle` pure function, unit-tested across all 6 stages
- [ ] `assignGroups` pure function, all 6 system-wide templates implemented and tested
- [ ] RFM nightly job extended to write `lifecycle_stage`
- [ ] `customer-scoring.ts` calls Haiku in batches of 50 with structured output schema enforced
- [ ] Incremental scoring eligibility logic implemented and tested (skip unchanged customers)
- [ ] Per-merchant daily token cap respected (cap reached â†’ halts cleanly)
- [ ] Scoring run row recorded with token usage and cost
- [ ] Each scored customer gets a `customer_scored` event written via `appendCustomerEvent`
- [ ] Nightly cron wired at 03:00 merchant timezone, runs after materialized profile job
- [ ] Customer detail page shows Signals panel (lifecycle, propensity, residual LTV, groups, last scored)
- [ ] Lapsed list has group filter, sort by propensity, lifecycle badges, top signal column
- [ ] Dashboard hero metric is "Ready to reactivate"
- [ ] Empty / loading / error states for every new fetch boundary
- [ ] All scoring tests pass: classifier, group templates, scoring service (with mock), orchestrator, RLS
- [ ] E2E: post-scoring, customer detail page renders signals
- [ ] `pnpm grep:pii` clean
- [ ] No new dependencies without justification (Anthropic SDK already in repo from earlier prep)
- [ ] Architecture-guardian, code-reviewer, test-coverage-analyzer dispatched after every chunk; no Critical/High findings open at merge

## Definition of done

- All acceptance criteria checked with evidence
- `pnpm typecheck` exits 0
- `pnpm lint` exits 0
- `pnpm test` all passing (target: 270+ total, +50 from Sprint 03)
- `pnpm build` exits 0 for all three apps
- `pnpm test:e2e` all passing
- `pnpm grep:pii` clean
- `pnpm vercel:env:check` clean (includes new `ANTHROPIC_API_KEY`, `SCORING_TOKEN_CAP_DEFAULT`, `PROPENSITY_READY_THRESHOLD`)
- No `TODO: ...` deferrals in the diff
- No bypasses of canonical event helpers
- HANDOFF.md committed with rubric scores
- PR opened, evaluator session run, every rubric criterion scored 3, then squash-merged

## Quality rubric

Scored 0â€“3 by evaluator. All must score 3 before merge.

1. **Inferred state purity** â€” `customer_inferred_state` is fully regeneratable from event log + scoring algorithm. No data lives only in inferred state. Verified by running the orchestrator twice on the same data and confirming idempotent output.
2. **Scoring event-sourcing** â€” every score write produces a `customer_scored` event via `appendCustomerEvent`. Verified by grep + event log inspection.
3. **Cost discipline** â€” incremental scoring skip logic correct; per-merchant cap respected; cap-exhaustion case tested.
4. **Lifecycle classifier correctness** â€” all 6 stages reachable from realistic fixtures; transitions follow the documented rules; idempotent.
5. **Group template correctness** â€” all 6 templates produce expected groups against fixture customers covering the relevant distributions.
6. **Haiku integration robustness** â€” structured output schema enforced; malformed responses rejected and retried; mocked tests cover happy path + retries + cap halt + API error.
7. **RLS tenancy isolation** â€” verified by cross-merchant test on all new tables and the extended `customer_inferred_state`.
8. **UI completeness** â€” Signals panel, Lapsed list filtering/sorting, Dashboard hero metric all wired to real data with empty/loading/error states.
9. **Observability** â€” structured logs include all required fields; no PII; cost-tracking query works.
10. **Architecture discipline** â€” no canonical event helper bypasses; no inferred-state-as-truth code paths; no deferrals in the diff.

## Suggested chunking â€” 13 commits

After every chunk: dispatch **architecture-guardian + code-reviewer + test-coverage-analyzer** in parallel. Critical or High blocks; fix in same commit (amend). Architecture violations always block.

For chunks 8â€“11 (UI), also dispatch design-tenet-auditor + vocabulary-auditor + accessibility-auditor.

1. Migration 0003 â€” `customer_inferred_state` extensions, `scoring_runs`, `merchant_scoring_caps`, enums, RLS policies, cross-merchant test
2. `classifyLifecycle` pure function in `@lapsed/core` + unit tests (target: 25+ test cases)
3. `assignGroups` pure function + `merchant_aggregates` materialized view + unit tests for all 6 templates
4. RFM job extension â€” write `lifecycle_stage` from `classifyLifecycle` output; idempotent
5. `customer-scoring.ts` â€” Haiku client wrapper, batch prompt construction, structured output parser, mocked tests
6. Scoring orchestrator + `scoring_runs` lifecycle + per-merchant cap logic + idempotency tests
7. Cron wiring at 03:00 + retry logic + Settings sync surface update
8. UI: Customer detail Signals panel + empty/loading/error states
9. UI: Lapsed list group filter + sort + lifecycle badges + top signal column
10. UI: Dashboard "Ready to reactivate" hero metric + threshold env var
11. Final UI polish across new surfaces + design-tenet sweep + vocabulary sweep
12. E2E test: install â†’ backfill â†’ materialize â†’ score â†’ see signals
13. HANDOFF.md with rubric scores, deviations documented, deferred items, failure modes

## Cost notes for evaluator and future sprints

Approximate Haiku 4.5 cost per scoring run, per merchant:
- 5,000 customers, batched 50/batch = 100 batches
- ~500 tokens input per customer, ~50 tokens output per customer (structured)
- Per batch: ~25,000 input + ~2,500 output = ~$0.04 per batch at current Haiku pricing
- Per merchant per night: ~$4 for 5,000 customers
- Incremental scoring typically cuts this to 10â€“20% on subsequent nights

Default daily cap is 10M tokens â€” far above typical merchant needs. Tune per plan tier in Sprint 09.

## Exact next action

After Sprint 03 PR is merged to main and the small Sprint 02.6 vocab cleanup ships, create branch `sprint-04/customer-intelligence` from main and start with chunk 1 (migration 0003). The first chunk validates the schema + RLS pattern â€” cross-merchant test must pass before chunk 2 starts.

This sprint is well-suited to an overnight run. Chunks 2â€“6 are mechanical (math + LLM integration + orchestrator) and chunks 8â€“11 are UI work that the harness handles well.
