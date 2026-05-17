# HANDOFF — Sprint 08: Attribution + Holdouts + LTV Restoration

Branch: `sprint-08/attribution`
Date: 2026-05-17
Migration: `0009_attribution.sql`

Sprint 08 closes the credibility loop: when an order arrives within a campaign's
attribution window from a customer who received the outbound, that order is
incrementally attributed against a matched holdout group, the bandit's
arm-level order posterior is updated against ground truth, and the merchant
sees a per-campaign dollar number with a 95% confidence interval. Sprint 09
billing meters off `attribution_results`.

13 chunks, all committed. Each chunk's specialist auditors (architecture-
guardian, code-reviewer, test-coverage-analyzer, spec-adherence-auditor; plus
the three UI auditors for chunks 10–11) returned clean after remediation. The
mid-sprint checkpoint (after chunk 7) returned APPROVE.

---

## ⚠️ Required manual actions before the PR merges

1. **Apply migration `0009_attribution.sql` to production Supabase.** `pnpm
   db:diagnose` currently reports its four new tables missing. The migration is
   additive and data-safe — see Deliberate Deviation 1. Apply via the Supabase
   SQL editor (the `supabase link` CLI bug, CLAUDE.md failure modes).
2. **Regenerate `packages/db/src/types.ts`** from the migrated schema
   (`supabase gen types`). The file was hand-maintained this sprint because
   `gen types` cannot run without the migration applied — see Deviation 9.
3. **No new Vercel env vars.** `ATTRIBUTION_DEFAULT_WINDOW_DAYS` and
   `LTV_EVALUATION_WINDOW_DAYS` were implemented as `merchant_attribution_config`
   column defaults (14 / 30), not env vars; `INSUFFICIENT_EVIDENCE_THRESHOLD`
   is hardcoded (`INSUFFICIENT_EVIDENCE_MIN_COHORT = 30`); `HOLDOUT_RATE`
   already exists. `pnpm vercel:env:check` passes with no changes.
4. **Statistician / product sign-off on the cohort methodology** — see
   Deliberate Deviation 6. This is a billing-validity item; resolve it before
   Sprint 09 bills off these numbers.

CI gates at the tip of the branch: `pnpm typecheck`, `test`, `lint`,
`grep:pii`, `vercel:env:check` all green. `db:diagnose` reports 0009 not yet
applied (expected — manual action 1).

---

## Rubric self-scores (evidence-required format)

### Criterion 1: Order ingestion via Shopify webhook

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `apps/web/app/api/shopify/webhooks/handlers/orders-paid.ts:25-154`
- Supporting files: `apps/web/app/api/shopify/webhooks/route.ts` (unified HMAC
  validation + per-webhook-id idempotency), `packages/core/src/customer-events.ts:16-23`
  (`OrderEventType` + `unmatched_customer`)

**Test evidence:**
- Test file: `apps/web/__tests__/webhook-handlers.test.ts:314-431` (ordersPaid block)
- Number of test cases: 10 ordersPaid cases
- Key assertions: HMAC-failure path is the unified route's concern (covered by
  `webhooks-route.test.ts`); `unmatched_customer` order event is appended when
  the customer is not in our table and the order is still persisted; redelivery
  (order already ingested) does NOT re-run `increment_customer_order`
  (`_rpcs` length 0); a fractional price `"19.99"` converts to `1999` integer
  cents; the structured log carries `merchant_id`/`order_gid`/`customer_matched`/
  `elapsed_ms` and no shop_domain.

**Notes:** Order ingestion stays on the unified `/api/shopify/webhooks` route's
`orders/paid` handler — see Deliberate Deviation 2.

### Criterion 2: Per-merchant attribution window

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/attribution-config.ts:1-64`
  (`getAttributionWindow`, `getLtvEvaluationWindow`)
- Supporting files: `packages/core/src/campaign-approval.ts:69-103` (the stamp
  inside `approveProposal`'s `!alreadyApproved` branch); migration
  `0009_attribution.sql` (`merchant_attribution_config` table;
  `campaign_proposals.attribution_window_days NOT NULL DEFAULT 14` backfill)

**Test evidence:**
- Test files: `packages/core/__tests__/attribution-config.test.ts:1-82`
  (9 cases); `packages/core/__tests__/campaign-approval.test.ts` (stamp tests)
- Number of test cases: 9 + 3 stamp/immutability cases
- Key assertions: default fallback to 14/30 when no config row; per-merchant
  override; per-merchant independence; query errors propagate (no silent
  fallback); the stamped window is immutable — a merchant-config change AFTER
  approval does not move it ("the stamped window is immutable" test); a failed
  stamp aborts approval with NO `campaign_approved` event appended.

**Notes:** Decision 20. The stamp precedes the approval event per SPRINT.md;
crash-retry re-stamp is decision-20-safe (the proposal is not yet approved).

### Criterion 3: Treatment cohort attribution

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/attribution-treatment.ts:1-356`
  (`getTreatmentCohort`, `getTreatmentOrders`)
- Supporting file: `packages/core/src/paginate.ts:1-50` (`fetchAllRows`,
  `chunk`, `IN_CLAUSE_CHUNK` — bounded, non-truncatable fetches)

**Test evidence:**
- Test file: `packages/core/__tests__/attribution-treatment.test.ts:1-334`
- Number of test cases: 17
- Key assertions: in-window attributed / out-of-window + pre-outbound excluded;
  window-edge inclusivity (order at exactly `send + windowDays` included, one
  ms past excluded); single-attribution — a customer in campaigns A and B
  attributes to the most-recent-preceding outbound only (`getTreatmentOrders(A)`
  excludes the order won by B); a competitor whose own window has lapsed loses;
  an exact-same-`sent_at` tie resolves deterministically by message id (exactly
  one campaign wins); `perCustomerRevenueCents` has one entry per cohort
  customer; throws on a malformed timestamp / non-integer cents.

**Notes:** Single-attribution (decision 21) is implemented as the most-recent-
preceding winner selection in application code so the in-memory fake exercises
it. See Deviation 6 for the treatment-cohort definition.

### Criterion 4: Holdout cohort attribution

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/attribution-holdout.ts:1-184`
  (`getHoldoutCohort`, `getHoldoutOrders`)

**Test evidence:**
- Test file: `packages/core/__tests__/attribution-holdout.test.ts:1-223`
- Number of test cases: 14
- Key assertions: `getHoldoutCohort` returns ONLY `included_in_holdout = true`
  rows from the frozen `campaign_group_snapshots` (decision 15) — a later
  group-membership change does not leak in; treatment-flagged snapshot rows are
  excluded (disjoint from treatment); calendar-window bounding with inclusive
  edges; orders across a cohort larger than the `.in()` chunk size are counted
  correctly; throws on a malformed calendar-window timestamp even for an empty
  cohort; non-integer cents rejected.

### Criterion 5: Incremental revenue + CI

**Self-score:** 3/3

**Implementation evidence:**
- Primary files: `packages/core/src/incremental-revenue.ts:1-181`
  (`computeIncrementalRevenue`, `campaignCalendarWindow`,
  `INSUFFICIENT_EVIDENCE_MIN_COHORT`); `packages/core/src/stats/welch.ts:1-174`
  (`welchConfidenceInterval`, `studentTCdf`, `studentTQuantile`)

**Test evidence:**
- Test files: `packages/core/__tests__/welch.test.ts:1-128` (17 cases);
  `packages/core/__tests__/incremental-revenue.test.ts:1-238` (11 cases);
  `packages/core/__tests__/attribution-scenarios.test.ts:1-322` (the
  constructed-scenario gate — 7 cases)
- Number of test cases: 17 + 11 + 7 = 35
- Key assertions: Welch–Satterthwaite df verified against textbook two-sided
  97.5% critical values (df=1→12.706, df=8→2.306, df=100→1.984, df→∞→1.96);
  unequal-variance df, not pooled; the t-critical comes from the inverse
  Student-t CDF (incomplete-beta identity + bisection), not a normal
  approximation; the **Monte-Carlo coverage test** — Welch's 95% CI brackets
  the true mean difference in the [0.93, 0.97] band over 2000 unequal-variance
  trials; the **five constructed scenarios** — high-lift (`incremental ===
  100000`, CI excludes 0), zero-lift (`=== 0`, CI brackets 0), negative-lift
  (`=== -150000`, CI wholly below 0, surfaced cleanly), insufficient-evidence
  (sub-30 cohort → `insufficient_evidence: true`, raw counts, null CI),
  multi-campaign-overlap (the order counted exactly once, in B's revenue not
  A's); integer-cents on every persisted field.

**Notes:** All currency is integer cents; per-customer means are fractional
intermediates and only the reported integer fields are `Math.round`-ed. The CI
on the total is the per-customer Welch CI scaled by the treatment cohort size.

### Criterion 6: LTV restoration

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/ltv-restoration.ts:1-230`
  (`computeLtvRestoration`)

**Test evidence:**
- Test files: `packages/core/__tests__/ltv-restoration.test.ts:1-437` (14
  cases); `packages/core/__tests__/attribution-scenarios.test.ts` (scenarios 1–4
  assert LTV outcomes)
- Number of test cases: 14 + 4 scenario assertions
- Key assertions: cohort-relative delta per decision 23 — restored LTV =
  Σ(per-customer 30-day-post revenue) − treatmentSize × holdout-mean, NO
  forecast/stay-probability; a positive-restoration cohort yields a positive
  delta with a non-null CI; indistinguishable cohorts yield ~0; per-customer
  `ltv_snapshots` rows are materialised (one per treatment customer,
  pre/post/delta) and the re-run is idempotent (upsert — 35 rows not 70);
  window boundaries partition pre vs post with no overlap (order at exactly
  send-time → pre, at send+window → post); the window anchors on a customer's
  EARLIEST outbound; the per-merchant LTV window override is honoured.

### Criterion 7: Bandit dual-signal

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/bandit-order.ts:1-410` (`recordOrderArrival`,
  `recordNoOrderOutcome`, `selectArm`, `ORDER_POSTERIOR_MIN_OBSERVATIONS`)
- Supporting files: migration `0009_attribution.sql` (`alpha`/`beta` renamed to
  `sentiment_alpha`/`sentiment_beta`; `order_alpha`/`order_beta`/
  `order_observation_count`/`order_last_updated_at` added);
  `packages/core/src/bandit.ts` (sentiment-side `updatePosterior` updated to the
  renamed columns)

**Test evidence:**
- Test file: `packages/core/__tests__/bandit-order.test.ts:1-319`
- Number of test cases: 23
- Key assertions: an order arrival moves the ORDER posterior and leaves the
  SENTIMENT posterior untouched (independent tracks — no cross-contamination);
  an arrival fires `order_alpha+1` even on an arm the sentiment signal scored a
  failure; `recordNoOrderOutcome` fires `order_beta+1`; both are idempotent (a
  re-processed order/customer does not double-move the posterior — the
  `attribution_decisions` decision row is the idempotency ledger); the
  selection threshold is exactly 30 — an arm with 29 order observations falls
  back to the sentiment posterior, 30 uses the order posterior; a cross-merchant
  campaign is rejected (tenancy); a posterior-update failure after the decision
  row commits logs `posterior_orphaned` and rethrows.

**Notes:** Decisions 22 + 14. See Deliberate Deviation 5 (the order-posterior
crash-window).

### Criterion 8: RLS tenancy

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/db/supabase/migrations/0009_attribution.sql` — every
  new table (`merchant_attribution_config`, `attribution_decisions`,
  `attribution_results`, `ltv_snapshots`) has `enable row level security` + a
  merchant-scoped read policy; no write policy is granted (writes are
  service-role-only by RLS-bypass — documented in the migration header).
  `attribution_decisions` is append-only (`prevent_event_mutation` triggers).

**Test evidence:**
- Test file: `packages/db/__tests__/rls.test.ts` — RLS read-isolation describe
  blocks for all four new tables; an append-only block for `attribution_decisions`
  (UPDATE/DELETE/TRUNCATE rejected); a single-attribution block (a duplicate
  `order_id` insert rejected by the partial UNIQUE).
- Supporting: `packages/db/__tests__/attribution-queries.test.ts:1-197`
  (7 cases) — `getCampaignAttribution` / `getMerchantAttributionRollup`
  cross-merchant isolation (another merchant's rows resolve to null / are
  excluded).
- Key assertions: merchant A sees only its own rows in each new table; merchant
  A cannot see merchant B's; a cross-merchant campaign id returns null (404
  without leaking existence).

**Notes:** The live-DB blocks in `rls.test.ts` / `campaign-rls.test.ts`
`skipIf` until migration 0009 is applied (the schema-ready guard now also
checks for the renamed `bandit_state.sentiment_alpha` column).

### Criterion 9: Attribution dashboard UI

**Self-score:** 3/3

**Implementation evidence:**
- Primary files: `apps/web/app/app/campaigns/[id]/attribution/page.tsx`
  (per-campaign); `apps/web/app/app/attribution/page.tsx` (merchant rollup)
- Supporting file: `packages/db/src/queries.ts` (`getCampaignAttribution`,
  `getMerchantAttributionRollup` — read-only projections over the materialised
  tables)

**Test evidence:**
- Test file: `packages/db/__tests__/attribution-queries.test.ts:1-197` (7 cases)
- Number of test cases: 7 (query layer); pages exercised by the chunk-12
  Playwright spec + manual auditor review (read-only server components are
  E2E-deferred per repo convention)
- Key assertions: per-campaign — window in effect, treatment/holdout sizes,
  incremental revenue + CI, LTV restored + CI, the explicit insufficient-
  evidence card, the attributed-orders table (order/customer/message); rollup —
  revenue restored over 30d/90d/all-time, top-5 campaigns, holdout-effectiveness
  check, 12-week revenue chart. Both verified clean by the design-tenet,
  accessibility, and vocabulary auditors (no "cohort" in UI copy; "group"
  throughout; honest-numbers — incremental not gross, negative surfaced
  plainly, insufficient-evidence explicit; progressive disclosure — one number
  first; WCAG 2.2 AA).

**Notes:** See Deliberate Deviation 7 (route path; LTV-as-card).

### Criterion 10: Observability + HANDOFF

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/attribution-batch.ts:1-281` — structured
  per-campaign and per-result logs (`merchant_id`, `campaign_id`,
  `window_close_date`, `treatment_size`, `holdout_size`,
  `incremental_revenue_cents`, `elapsed_ms`); per-campaign errors are caught,
  logged as structured JSON, and do not halt the batch.
- Supporting: `bandit-order.ts` `posterior_orphaned` / `bandit_selection`
  structured logs; `orders-paid.ts` PII-clean structured ingestion log.

**Test evidence:**
- Test file: `packages/core/__tests__/attribution-batch.test.ts:1-296` (8 cases)
- Number of test cases: 8
- Key assertions: a per-campaign error increments `errors` and the batch still
  resolves (resilience contract); idempotent re-run writes no new
  `attribution_results` rows; insufficient-evidence writes the row but fires no
  posteriors; this HANDOFF.md uses the evidence-required format with file:line
  + test counts + named assertions, and a Deliberate Deviations section.

**Notes:** `grep:pii` clean — logs reference IDs, counts, and timing only.

---

## Deliberate deviations

1. **Migration 0009 is additive, not the chunk-1 "new tables" literal.** SPRINT.md
   chunk 1 lists `orders` and `order_events` as new tables; both already existed
   from migration 0002 (Sprint 03) and carry the live order pipeline. Per an
   explicit human decision, 0009 EXTENDS them in place (adds attribution-lookup
   indexes; relies on the existing append-only `order_events`) and creates only
   the four genuinely-new tables. No destructive operation. The existing
   `total_price_cents` (bigint) is better than chunk 1's sketched `total_amount`
   numeric and was kept.

2. **Order ingestion stays on the unified webhook route.** SPRINT.md chunk 2
   sketched a new `/api/shopify/webhooks/orders/route.ts`; per an explicit human
   decision, the existing unified `/api/shopify/webhooks` route's `orders/paid`
   handler was extended instead (it already does HMAC + idempotency). No
   parallel route. Architecture decisions 24/25 remain valid commitments but
   were partially pre-existing. **Guest checkouts (an order with no Shopify
   customer at all) are not persisted** — `orders.shopify_customer_gid` is NOT
   NULL and a customerless order cannot be attributed; it is logged, not
   silently dropped. Customer-*unmatched* orders (gid present, no `customers`
   row) ARE persisted with an `unmatched_customer` order event.

3. **`appendOrderEvent` lives in `customer-events.ts`,** not a new
   `order-events.ts` (SPRINT.md chunk 2). The helper pre-existed from Sprint 03;
   a duplicate was not created.

4. **Attribution-window stamp ordering.** The window is stamped BEFORE the
   `campaign_approved` event (SPRINT.md chunk 3). A crash between the stamp and
   the event leaves the proposal still `proposed`; a retry re-stamps with the
   then-current window. This is decision-20-safe — immutability is guaranteed
   *after* approval, and approval is finalised by the event.

5. **Order-posterior crash-window — RPC hardening deferred.** `recordOrderArrival`
   / `recordNoOrderOutcome` write the `attribution_decisions` decision row FIRST
   (the idempotency ledger), then fire the posterior. A crash in between costs
   at most one missed order observation (a benign single-observation loss on a
   noisy signal with a 30-observation maturity gate) — logged as
   `posterior_orphaned`. It can never double-count. A fully-atomic
   decision-insert + posterior-update would require a Postgres RPC, which is a
   migration change beyond chunk 1's spec (a designated hard stop). **Follow-up:
   add the RPC for true atomicity in a future migration.**

6. **⚠️ Cohort methodology — as-treated treatment vs ITT holdout (billing-validity
   item).** Per SPRINT.md chunk 4, the treatment cohort is "customers who
   received at least one outbound" (an as-attempted / sent-to set). Per chunk 5,
   the holdout cohort is the full frozen `campaign_group_snapshots` holdout set
   (intent-to-treat). These are methodologically asymmetric: non-holdout
   customers who were never sent to (opted-out, daily-cap-deferred) are excluded
   from the treatment denominator while their holdout-side equivalents remain.
   If opt-out customers are systematically less engaged, this biases incremental
   revenue **upward** — an over-billing risk that can exceed criterion-7's 1%
   drift tolerance. Additionally, the holdout is measured over a single
   median-anchored calendar window while treatment uses per-customer windows —
   strictly comparable only when sends are tightly clustered (the typical
   single-batch launch). The implementation faithfully follows SPRINT.md's
   chunk-4/chunk-5 definitions; correcting the asymmetry is a methodology
   decision above the build agent's authority. **This MUST receive a
   statistician / product sign-off before Sprint 09 billing goes live.** Raised
   by the code-reviewer and confirmed by the mid-sprint checkpoint evaluator.

7. **Merchant rollup UI — route + LTV presentation.** SPRINT.md chunk 11 names
   `app/dashboard/attribution/page.tsx`; the live sidebar-linked route is
   `/app/attribution` (formerly a Sprint-01 fixture page). The rollup replaced
   that page in place rather than spawning an orphan route and leaving a stale
   demo page live. LTV restored is shown as a prominent second-tier card, not a
   co-equal second `HeroMetric` — a second hero would violate tenet 6
   (progressive disclosure — one number first), the same constraint applied to
   the per-campaign page in chunk 10.

8. **Chunk-12 Playwright scope.** The constructed-scenario MATH gate is the
   Vitest file (`attribution-scenarios.test.ts` — direct synthetic seeding +
   the real engine). The Playwright spec covers the attribution-batch cron's
   CRON_SECRET boundary + page id validation — what only the real routes
   demonstrate without external mocks. This follows the Sprint 07 precedent
   (`conversation-engine.spec.ts`): a full browser-level batch run is not
   feasible without a route injection seam (v2). The Vitest scenario file is at
   `packages/core/__tests__/` (the repo's actual test location), not the
   `src/__tests__/` SPRINT.md sketched.

9. **`packages/db/src/types.ts` was hand-maintained.** The Supabase
   `gen types` command cannot run until migration 0009 is applied to a
   database; the generated types file was edited by hand to match 0009. It must
   be regenerated from the migrated schema before merge (manual action 2).

---

## Test summary

`pnpm test` — all packages green. New/changed Sprint 08 test files:
`attribution-config` (9), `attribution-treatment` (17), `attribution-holdout`
(14), `welch` (17), `incremental-revenue` (11), `bandit-order` (23),
`ltv-restoration` (14), `attribution-batch` (8), `attribution-scenarios` (7),
`paginate` (6), `attribution-queries` (db, 7), plus extended `webhook-handlers`,
`campaign-approval`, `rls`, and the bandit-rename test sweep.

## Definition of done

- [x] All 13 acceptance criteria implemented with test evidence.
- [x] All 10 rubric criteria self-scored 3/3 with file:line + test + named
  assertions above.
- [x] CI gates green: typecheck, test, lint, grep:pii, vercel:env:check.
- [ ] `db:diagnose` — reports 0009 not yet applied (manual action 1).
- [x] Mid-sprint checkpoint (chunk 7) — APPROVE.
- [x] Branch pushed; PR not opened by the build agent (human gate).
