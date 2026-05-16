# Sprint 08: Attribution + Holdouts + LTV Restoration

Date: 2026-05-17
Repo: lapsed
Branch: sprint-08/attribution

---

## Scope

Sprint 08 closes the credibility loop. Sprint 07 makes lapsed.ai *do things* — it sends SMS, classifies replies, fires bandit posteriors on leading signals. Sprint 08 makes it *prove things* — when an order arrives within a campaign's attribution window from a customer who received the outbound, that order is incrementally attributed against a matched holdout cohort, the bandit's arm-level posterior is updated against ground-truth, and the merchant sees a per-campaign dollar number defensible to an external audit.

This is the make-or-break sprint for monetisation. Sprint 09 (Stripe billing on incremental revenue) literally consumes Sprint 08's output as the meter. If the attribution math is wrong, the invoices are wrong. If the holdout-matching is wrong, the lift numbers are inflated and merchants who audit will leave. If the LTV restoration calculation is over-confident, the case studies become legally risky.

**Not in scope this sprint:** Stripe billing (Sprint 09), multi-touch attribution (v2), customer-journey reconstruction (v2), LTV forecasting beyond restoration delta (v2), A/B-test orchestration UI (v2), email/web-channel attribution (v2), per-merchant attribution-model selection (v2), retroactive attribution-window changes on existing proposals (v2).

---

## Acceptance Criteria

- [ ] Shopify `orders/create` webhook ingests orders idempotently with HMAC signature validation; orders are append-only event-sourced.
- [ ] Each campaign proposal at approval time is stamped with its merchant's current `attribution_window_days` (default 14, per-merchant configurable in `merchant_attribution_config`); the stamp is immutable for that proposal.
- [ ] Treatment cohort attribution: for each campaign within its window, the set of customers who received at least one outbound is materialised and their attributed orders counted.
- [ ] Holdout cohort attribution: for each campaign, the holdout snapshot from Sprint 06 is queried, and orders from those customers within the same time-window are counted.
- [ ] Incremental revenue calculator returns: `treatment_revenue_per_customer - holdout_revenue_per_customer`, multiplied by treatment cohort size; with a 95% confidence interval (Welch's t-test on per-customer revenue distributions); with an explicit `insufficient_evidence` flag when either cohort has fewer than 30 customers.
- [ ] LTV restoration calculator returns per-campaign delta: `(avg_30d_post_revenue_per_treatment_customer - avg_30d_post_revenue_per_holdout_customer) × treatment_cohort_size`, with cohort-relative scaling.
- [ ] Bandit dual-signal posterior: each arm now maintains BOTH `sentiment_alpha`/`sentiment_beta` (Sprint 07) AND `order_alpha`/`order_beta` (this sprint). Selection at proposal-creation time uses the order posterior when `order_observation_count ≥ 30`, else falls back to the sentiment posterior. Posterior updates from orders are idempotent (per-order).
- [ ] Single-attribution rule: a customer who received outbounds from N campaigns within their respective windows is attributed to the most recent outbound preceding the order — never to multiple campaigns simultaneously.
- [ ] Daily attribution batch cron materialises `attribution_results` from `order_events` + `message_events` + `campaign_group_snapshots`. Idempotent: re-running produces identical output.
- [ ] Per-campaign attribution UI shows treatment cohort size, holdout cohort size, incremental revenue with CI, LTV restored with CI, attribution window in effect; explicit "insufficient evidence — need 30+ orders per cohort" state when below threshold.
- [ ] Merchant rollup UI aggregates across campaigns: total revenue restored (last 30/90/all-time), total LTV restored, top 5 campaigns by lift, holdout-rate effectiveness sanity check (should approximate the configured rate).
- [ ] RLS tenancy on every new table: orders, order_events, attribution_decisions, attribution_results, ltv_snapshots, merchant_attribution_config.
- [ ] No "cohort", "segment", "blast", "customer journey" in any new UI string (vocabulary compliance per existing rule).
- [ ] HANDOFF.md uses the evidence-required format with file:line citations, test file:line citations, test count, named assertions per criterion. Constructed-scenario validation (chunk 12) is the criterion-5 + criterion-6 evidence.

---

## Definition of Done

- [ ] All 13 acceptance criteria checked with evidence.
- [ ] All 10 rubric criteria self-scored 3/3 in HANDOFF with full evidence trail.
- [ ] CI gates green: pnpm typecheck, lint, test, build, grep:pii, vercel:env:check, db:diagnose.
- [ ] Mid-sprint checkpoint at chunk 7 passed (APPROVE or ADJUST-then-remediated).
- [ ] Branch pushed; PR not opened by build agent (human gate).

---

## Architectural Decisions Added This Sprint (20–26)

20. **Attribution window is per-merchant configurable, immutable per proposal.** Default 14 days. Stamped at proposal approval. Future merchant-default changes affect new proposals only.

21. **Single-attribution per order.** Most-recent-preceding-outbound wins. No double-counting across overlapping campaigns.

22. **Bandit posterior dual-signal.** Sentiment posterior (leading, Sprint 07) and order posterior (lagging, Sprint 08) tracked separately on `bandit_state`. Selection uses order when `order_observation_count ≥ 30`, sentiment otherwise.

23. **LTV restoration = cohort-relative delta.** Simple, explainable, no stay-probability modelling. Aggregates per-customer delta against holdout baseline.

24. **Order events are event-sourced (decision 12 extended).** Append-only `order_events`. Materialised `orders` table is the read view. All writes go through `appendOrderEvent`.

25. **Order ingestion via Shopify `orders/create` webhook.** Real-time. HMAC-validated. Idempotent on `order_gid`. Re-delivery safe (Shopify retries are real).

26. **Attribution is computed nightly, materialised into `attribution_results`.** Per-campaign + per-customer rows. UI reads from the materialised table. Re-runnable from event log. The cron is the only write path to `attribution_results`.

Decisions 1–19 remain. New cumulative count: 26.

---

## Chunk Sequence (13 chunks, checkpoint barrier after chunk 7)

### Chunk 1 — Migration 0009: attribution schema

`packages/db/supabase/migrations/0009_attribution.sql`

New tables:
- `orders` — materialised view; one row per Shopify order. Columns: `id` (PK), `merchant_id`, `customer_id` (gid as text, per Sprint 07 convention), `order_gid` (UNIQUE on `(merchant_id, order_gid)`), `total_amount` (numeric), `currency` (text), `placed_at` (timestamptz), `created_at`, `updated_at`. RLS: merchant-scoped read.
- `order_events` — append-only source. Columns: `id` (PK), `merchant_id`, `order_id` (FK orders), `customer_id`, `event_type` (text — `'received'`, `'attributed'`, `'refunded'`), `data` (jsonb), `appended_at`. Append-only trigger per decision 12.
- `attribution_decisions` — append-only audit. Columns: `id` (PK), `merchant_id`, `order_id` (FK orders), `attributed_campaign_id` (FK campaign_proposals nullable — null = "no qualifying outbound"), `attributed_message_id` (FK messages nullable), `attribution_window_days` (int), `decided_at` (timestamptz). Append-only trigger.
- `attribution_results` — materialised view; one row per (campaign, window-close-date). Columns: `id`, `merchant_id`, `campaign_id` (FK), `window_close_date` (date), `treatment_cohort_size` (int), `holdout_cohort_size` (int), `treatment_revenue_cents` (bigint), `holdout_revenue_cents` (bigint), `incremental_revenue_cents` (bigint), `incremental_ci_low_cents`, `incremental_ci_high_cents`, `ltv_restored_cents`, `insufficient_evidence` (bool), `computed_at`. UNIQUE on `(campaign_id, window_close_date)`. Cron is the only write path.
- `ltv_snapshots` — per-customer pre/post LTV markers. Columns: `id`, `merchant_id`, `customer_id`, `campaign_id` (FK), `pre_30d_revenue_cents`, `post_30d_revenue_cents`, `delta_cents`, `snapshot_at`.
- `merchant_attribution_config` — per-merchant settings. Columns: `merchant_id` (PK), `attribution_window_days` (int default 14), `ltv_evaluation_window_days` (int default 30), `created_at`, `updated_at`.

Schema additions:
- `campaign_proposals.attribution_window_days` (int, NOT NULL, stamped at approval time)
- `bandit_state.order_alpha`, `bandit_state.order_beta`, `bandit_state.order_observation_count`, `bandit_state.order_last_updated_at` — dual-signal posterior columns per decision 22

Indexes:
- `orders (merchant_id, customer_id, placed_at)` — attribution lookups
- `orders (merchant_id, placed_at)` — window scans
- `order_events (order_id, appended_at)` — audit traversal
- `attribution_decisions (order_id)` — one-decision-per-order lookups
- `attribution_results (merchant_id, window_close_date)` — rollup queries
- Partial unique: `attribution_decisions (order_id)` ensures one final attribution per order

RLS: every new table gets merchant-scoped read + service-role write. Verified by RLS tests.

**No embedding columns on these tables.** Decision 2's embedding requirement applies to narrative-content tables (customer_events, conversations, messages, voice_profile, campaign_proposals). Sprint 08's tables are quantitative. Note this explicitly in the migration header comment to prevent architecture-guardian false-flagging.

### Chunk 2 — Shopify orders/create webhook handler

`apps/web/app/api/shopify/webhooks/orders/route.ts`

- HMAC signature validation using `SHOPIFY_API_SECRET` (already in env). Reject 401 BEFORE body parsing.
- Idempotent on `(merchant_id, order_gid)`: if exists, return 200 (don't error — Shopify retries).
- Customer-gid resolution: match `customer.id` from payload to `customers.shopify_customer_gid`. If unmatched: write the order anyway with `customer_id = null`, append an order_event of type `'unmatched_customer'`, log structured warning. Don't fail.
- Append `order_events.received` with full payload as `data`.
- Insert into `orders` materialised view.
- Response: 200 JSON `{ok: true}` always (except 401 for HMAC failure).
- Structured logs: `merchant_id`, `order_gid`, `customer_matched` (bool), `elapsed_ms`.

`packages/core/src/order-events.ts` — `appendOrderEvent`, similar shape to `appendMessageEvent`.

`packages/core/src/shopify-orders-ingest.ts` — `ingestShopifyOrder` orchestrator (parse payload → resolve customer → append event → upsert orders row).

Tests: HMAC pass/fail, idempotent re-delivery, customer-matched + customer-unmatched cases, structured-log assertions.

### Chunk 3 — Attribution window resolver + proposal stamping

`packages/core/src/attribution-config.ts`

- `getAttributionWindow(merchantId)` — returns `merchant_attribution_config.attribution_window_days`, default 14 if no row.
- `getLtvEvaluationWindow(merchantId)` — same pattern, default 30.

`packages/core/src/campaign-approval.ts` (extend Sprint 06)
- At approval time, BEFORE inserting the approval event, call `getAttributionWindow(merchantId)` and stamp into `campaign_proposals.attribution_window_days`.
- For proposals approved before this sprint (already in main): backfill migration in 0009 sets `attribution_window_days = 14` for all existing approved proposals.

Tests: default fallback, per-merchant override, stamp immutability (subsequent merchant-config change does NOT update the stamped value on existing proposals).

### Chunk 4 — Treatment cohort engine

`packages/core/src/attribution-treatment.ts`

- `getTreatmentCohort(campaignId, windowDays)` — returns the set of `customer_id`s who received at least one outbound from the campaign. Sourced from `messages` where `direction = 'outbound'` and `campaign_id = $1`.
- `getTreatmentOrders(campaignId, windowStart, windowEnd, treatmentCustomerIds)` — orders from those customers placed within `[outbound_sent_at, outbound_sent_at + windowDays]`. Per-customer window relative to THEIR outbound timing.
- Returns: `{cohort: customer_id[], orders: Order[], revenue_cents: number, customers_with_orders: number}`.

Single-attribution implementation: if a customer received outbounds from multiple campaigns in overlapping windows, the treatment query joins to the most-recent-preceding outbound per order and only returns orders where this campaign IS that most-recent outbound.

Tests: single-campaign happy path, multi-campaign single-attribution (customer in 2 campaigns, order attributed to most recent), order-outside-window exclusion, empty cohort.

### Chunk 5 — Holdout cohort engine

`packages/core/src/attribution-holdout.ts`

- `getHoldoutCohort(campaignId)` — sourced from `campaign_group_snapshots` where `is_holdout = true` and `campaign_proposal_id = $1`. This is the frozen snapshot per decision 15.
- `getHoldoutOrders(campaignId, windowStart, windowEnd, holdoutCustomerIds)` — orders from holdout customers within the same calendar window as the treatment cohort's send dates (NOT per-customer offset, since holdouts have no send-time anchor).
- Returns: same shape as treatment.

Tests: holdout-snapshot-frozen verification (modifying group memberships post-snapshot doesn't affect this), correct window-bounding, no-overlap with treatment cohort (the snapshot guarantees disjoint sets).

### Chunk 6 — Incremental revenue calculator

`packages/core/src/incremental-revenue.ts`

- `computeIncrementalRevenue(campaignId)` orchestrates chunks 4 + 5, then:
  - `treatment_per_customer = treatment_revenue / treatment_cohort_size`
  - `holdout_per_customer = holdout_revenue / holdout_cohort_size`
  - `incremental_per_customer = treatment_per_customer - holdout_per_customer`
  - `incremental_total = incremental_per_customer × treatment_cohort_size`
  - 95% CI via Welch's t-test on the per-customer revenue distributions (NOT bootstrap — Welch is exact for unequal variances and small samples, well-suited here)
  - If `treatment_cohort_size < 30` OR `holdout_cohort_size < 30`: return `insufficient_evidence: true` with the raw numbers but no CI.

The Welch t-test math is in `packages/core/src/stats/welch.ts` — exposed as `welchConfidenceInterval(treatment_values, holdout_values, alpha=0.05)`. Standard formula: pooled standard error, Welch–Satterthwaite degrees of freedom, t-critical via the existing math import (or hand-rolled if no stats lib).

Tests:
- Known-input test: synthetic distributions with known mean difference; verify CI brackets the true mean difference.
- Insufficient-evidence path: 29 customers per cohort returns insufficient.
- Negative-lift case: holdout outperforms treatment → returns negative incremental, no special handling (let the UI surface).
- Currency arithmetic: all amounts in cents (integer), avoid float drift.

### Chunk 7 — Bandit dual-signal posterior (CHECKPOINT BARRIER)

`packages/core/src/bandit-order.ts`

- `recordOrderArrival(orderId)` — called from the attribution batch cron when a treatment order is finalised:
  1. Look up the order's attributed campaign + attributed message
  2. Look up the message's arm_id
  3. Idempotency: check `attribution_decisions` for prior `recordOrderArrival` event for this order; if present, no-op
  4. UPDATE `bandit_state.order_alpha`, `order_beta`, `order_observation_count`, `order_last_updated_at` for that arm
  5. Append `attribution_decisions` row recording the posterior update
- `selectArm(campaignId)` (extending Sprint 06's `packages/core/src/bandit.ts`):
  - For each arm, look at `order_observation_count`:
    - If `≥ 30`: use `(order_alpha, order_beta)` for the Thompson sample
    - Else: use `(sentiment_alpha, sentiment_beta)` (Sprint 07's existing posterior)
  - Selection logs which posterior was used per arm — structured `bandit_selection` event with `posterior_source: 'order'` or `'sentiment'`

Architecture-guardian note: arm identity is still immutable per decision 14. Only the alpha/beta/observation_count/last_updated_at columns are touched. The `order_*` columns are new but the immutability rule covers them — arms can't be deleted or have their template_text/voice_attributes changed.

Tests:
- Order arrival from positive-sentiment-fired arm: sentiment posterior had alpha=2/beta=1 from Sprint 07; order arrives; order posterior moves alpha=2/beta=1 (independent track).
- Order arrival from negative-sentiment-fired arm (Sprint 07 fired beta + 1): order arrives anyway; order alpha + 1 (the lagging signal can override the leading signal's prior expectation).
- No-order case (no arrival within window): order_beta + 1 (the failure signal). This update fires from the attribution batch cron at window-close, not from order arrival (which never fires).
- Selection threshold: arm with 29 order observations falls back to sentiment; arm with 30 uses order.
- Idempotency: same order processed twice does NOT double-update.

**MID-SPRINT CHECKPOINT BARRIER.** After chunk 7 lands and is auditor-clean, the build agent surfaces:
> "Chunk 7 complete. Mid-sprint checkpoint evaluator should now run. Awaiting human to launch a separate Claude Code session for checkpoint per CLAUDE.md → Mid-sprint checkpoint evaluator protocol."

Do not proceed to chunk 8 until APPROVE (or ADJUST-then-remediated).

### Chunk 8 — LTV restoration calculator

`packages/core/src/ltv-restoration.ts`

- `computeLtvRestoration(campaignId)` returns per-campaign LTV delta per decision 23:
  - For each treatment-cohort customer: their revenue in the 30 days AFTER their outbound
  - For each holdout-cohort customer: their revenue in the 30 days AFTER the campaign's median send time (since holdouts have no individual outbound time)
  - Per-customer delta: post_treatment_revenue - cohort_mean_holdout_revenue
  - Aggregated: sum of per-customer deltas
  - CI via Welch's t-test on the per-customer revenue distributions (same pattern as chunk 6)
  - Materialise into `ltv_snapshots` rows per treatment customer + a campaign-level summary
- Insufficient-evidence threshold same as chunk 6: < 30 customers per cohort.

Tests:
- High-restoration case: treatment cohort's avg 30d revenue substantially higher than holdout's → positive delta
- Zero-restoration case: cohorts indistinguishable → ~0 delta with wide CI
- Per-customer snapshot persistence: verify ltv_snapshots rows are written

### Chunk 9 — Attribution batch cron

`apps/web/app/api/cron/attribution-batch/route.ts`

- CRON_SECRET authentication (existing pattern).
- Iterates merchants → campaigns approved-and-launched → for each:
  1. Determine window-close date = `min(now(), launched_at + attribution_window_days)`
  2. If window-close <= today AND no `attribution_results` row exists for `(campaign_id, window_close_date)`:
     - Run `computeIncrementalRevenue(campaignId)` and `computeLtvRestoration(campaignId)`
     - For each attributed order: call `recordOrderArrival(orderId)` (idempotent)
     - For each treatment-cohort customer with NO order in window: append `attribution_decisions` of type `'no_order'` and update bandit `order_beta + 1` (the failure signal feeds the order posterior)
     - INSERT into `attribution_results`
- Structured logs with `merchant_id`, `campaign_id`, `window_close_date`, `treatment_size`, `holdout_size`, `incremental_revenue_cents`, `elapsed_ms`.
- Idempotency: the UNIQUE on `attribution_results (campaign_id, window_close_date)` prevents duplicate inserts. Re-running the cron the next day skips already-computed campaigns.

`vercel.json` adds:
```json
{ "path": "/api/cron/attribution-batch", "schedule": "0 6 * * *" }
```
(06:00 UTC = 16:00 AEST, well after rfm/score nightly batches finish.)

Tests:
- Idempotent re-run: second invocation produces no new `attribution_results` rows
- Insufficient-evidence path: writes `attribution_results` with `insufficient_evidence = true`, does NOT update bandit posteriors (don't pollute the bandit with low-confidence signal)
- Window-not-closed path: campaigns still inside their window are skipped

### Chunk 10 — Per-campaign attribution UI

`apps/web/app/app/campaigns/[id]/attribution/page.tsx`

- Server component reads from `attribution_results` for the given campaign
- Sections:
  - **Window in effect**: shows the `attribution_window_days` value stamped on the proposal
  - **Cohorts**: treatment size, holdout size, percentages
  - **Incremental revenue**: dollar amount with CI low/high in parentheses; if `insufficient_evidence: true`, replace with explicit "Insufficient evidence — need 30+ customers per cohort. Currently treatment: X, holdout: Y." card
  - **LTV restored**: same pattern
  - **Attributed orders table**: list of orders attributed to this campaign with linked customer + outbound message
- Vellum tokens only. No hex/rgb. WCAG 2.2 AA.
- Vocabulary: NO "cohort" in UI strings (use "group" — per existing Sprint 04 vocabulary). Internal code can use "cohort" because it's the technical term for the math; UI translates.

### Chunk 11 — Merchant rollup attribution UI

`apps/web/app/app/dashboard/attribution/page.tsx`

- Server component reads aggregates from `attribution_results` joined to `campaign_proposals`
- Sections:
  - **Headline**: "Revenue restored this month: $X". Three tabs: last 30d / last 90d / all-time.
  - **Top 5 campaigns by incremental revenue**: sortable table
  - **LTV restored**: same headline pattern
  - **Holdout effectiveness check**: the configured `HOLDOUT_RATE` env value compared against the realised average across campaigns. If they diverge >10%, surface a warning ("Holdout assignment may be skewed").
  - **Time series chart**: revenue restored by week, last 12 weeks (recharts, Vellum tokens)
- Same UI rules as chunk 10.

### Chunk 12 — E2E + constructed-scenario validation

`apps/web/e2e/attribution-scenarios.spec.ts` (Playwright) AND `packages/core/src/__tests__/attribution-scenarios.test.ts` (Vitest)

**The defensibility test.** Five constructed scenarios run against the live attribution engine with synthetic data:

1. **High-lift scenario.** Treatment cohort of 100 customers, 40 of whom place orders ($50 avg). Holdout cohort of 30 customers, 6 of whom place orders. Expected: positive incremental, narrow CI excluding 0, LTV restored positive.
2. **Zero-lift scenario.** Treatment 100 customers, 20 orders. Holdout 30 customers, 6 orders. Both cohorts ~20% conversion. Expected: ~$0 incremental, CI brackets 0, LTV restored ≈ 0.
3. **Negative-lift scenario.** Treatment 100 customers, 10 orders. Holdout 30 customers, 12 orders. Holdout outperforms. Expected: negative incremental, negative LTV, surfaced cleanly in UI without crashing or hiding the result.
4. **Insufficient-evidence scenario.** Treatment 25 customers, 5 orders. Holdout 10 customers, 2 orders. Expected: `insufficient_evidence: true`, raw numbers shown, no CI, UI shows the "need 30+ per cohort" message.
5. **Multi-campaign-overlap scenario.** Customer X in both campaign A and campaign B (treatment for both). Customer X places an order 5 days after A's outbound, 2 days after B's outbound. Expected: attributed to B only (most-recent-preceding). A's treatment_cohort still includes X (membership), but A's attributed orders does not include this order.

Each scenario seeds synthetic data via direct DB inserts (NOT via the Shopify webhook — the math is what's being tested), runs `computeIncrementalRevenue` and `computeLtvRestoration`, and asserts against expected outcomes within tight tolerances.

### Chunk 13 — HANDOFF.md

Evidence-required format per CLAUDE.md. 10 rubric criteria, each with:
- Primary implementation file path:line range
- Test file path:line range
- Test count
- Named assertion(s)

Deliberate deviations section (anticipate at least one — math choices, threshold tuning, etc.).

---

## Quality Rubric (10 criteria, score 0–3 each)

| # | Criterion | What 3/3 looks like |
|---|---|---|
| 1 | Order ingestion via Shopify webhook | HMAC validated, idempotent on order_gid, customer-match + unmatched both handled, structured logs |
| 2 | Per-merchant attribution window | `merchant_attribution_config` table, `getAttributionWindow` helper, proposal-stamping at approval, immutability test |
| 3 | Treatment cohort attribution | `getTreatmentCohort` + `getTreatmentOrders`, single-attribution rule enforced, per-customer-window math |
| 4 | Holdout cohort attribution | `getHoldoutCohort` queries frozen snapshot, no-overlap with treatment, calendar-window correct |
| 5 | Incremental revenue + CI | Welch t-test implementation, integer cents arithmetic, insufficient-evidence threshold, constructed-scenario passing |
| 6 | LTV restoration | Cohort-relative delta per decision 23, per-customer ltv_snapshots persisted, CI calculated |
| 7 | Bandit dual-signal | `bandit_state.order_*` columns, `recordOrderArrival` write path, selection threshold at 30 observations, idempotent |
| 8 | RLS tenancy | Every new table has merchant-scoped read + service-role write; RLS tests pass |
| 9 | Attribution dashboard UI | Per-campaign + rollup pages, insufficient-evidence state, Vellum tokens, WCAG 2.2 AA, vocabulary compliance |
| 10 | Observability + HANDOFF | Structured logs at every cron step, deliberate-deviations section in HANDOFF, evidence-required format compliance |

---

## Out of Scope

- Stripe billing on incremental revenue → Sprint 09
- Multi-touch attribution (multiple campaigns share credit) → v2
- Customer-journey reconstruction across channels → v2
- LTV forecasting beyond observed restoration delta → v2 (would require stay-probability modelling)
- A/B-test orchestration UI → v2
- Email/web-channel attribution → v2 (channel-agnostic infra exists per decision 3 but no other channel ingestion built)
- Per-merchant attribution-model selection → v2 (v1 ships one model)
- Retroactive attribution-window changes on existing proposals → v2 (would invalidate already-computed results)
- Order refund handling beyond appending refund event → v2 (UI surfacing + posterior corrections deferred)
