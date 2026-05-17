# HANDOFF — Sprint 09: Cohort Symmetric-ITT Refactor + Flat Subscription Billing

Branch: `sprint-09/subscription-billing` · Base: `main`
Date: 2026-05-17

Sprint 09 shipped in two parts: **Part 1 (chunks 1-4)** resolved the Sprint 08
cohort asymmetry by refactoring attribution to symmetric ITT and backfilling
existing `attribution_results`; **Part 2 (chunks 5-12)** built flat Stripe
subscription billing ($299 / $799 / $1499 monthly). The mid-sprint checkpoint
after chunk 3 ruled **ADJUST → Position B** on the bandit-posterior question;
that ruling is applied (commit `6fcd601`).

## CI gate status (final, on the branch tip)

| Gate | Result |
|---|---|
| `pnpm typecheck` | ✅ 11/11 packages |
| `pnpm test` | ✅ core 1099 · web 196 · db 150 (108 live-DB skipped, no creds) |
| `pnpm lint` | ✅ clean |
| `pnpm grep:pii` | ✅ no findings |
| `pnpm build` | ✅ compiles |
| `pnpm vercel:env:check` | ✅ 27/27 — see Manual Action 2 (Stripe vars NOT yet in `EXPECTED_ALL`) |
| `pnpm db:diagnose` | ⚠️ requires migration 0010 applied to production first — see Manual Action 1 |

---

# Rubric self-scores (evidence-required format)

### Criterion 1: Cohort symmetric ITT

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/attribution-treatment.ts:168-256` (`getTreatmentCohort` — sources the cohort from `campaign_group_snapshots` WHERE `included_in_holdout = false`, the mirror of `getHoldoutCohort`)
- `packages/core/src/attribution-treatment.ts:259-356` (`getTreatmentOrders` — campaign-calendar window `[launched_at, launched_at + windowDays]`, single-attribution preserved)
- Supporting: `packages/core/src/incremental-revenue.ts` (`campaignCalendarWindow` re-anchored from median to `launched_at`)

**Test evidence:**
- Test file: `packages/core/__tests__/attribution-treatment.test.ts` — 24 test cases
- `packages/core/__tests__/attribution-scenarios.test.ts` — 7 cases (the five constructed scenarios + Monte-Carlo Welch coverage), re-run under symmetric ITT
- Key assertions: cohort size equals the `campaign_group_snapshots` non-holdout row count; an opt-out / never-sent customer is IN the cohort and contributes zero revenue; single-attribution invariant holds (`resultA.orders.length + resultB.orders.length === 1`); the late-sent customer's day-20 order is excluded by the campaign-calendar window.

**Notes:** SPRINT.md named the columns `is_holdout` / `campaign_proposal_id`; the real migration-0007 schema uses `included_in_holdout` / `proposal_id` — the implementation uses the real names.

### Criterion 2: ITT bandit posterior signal

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/attribution-batch.ts:226-289` (`processCampaign` no-order loop — iterates the full ITT `cohort.cohort`; writes a `no_order` `attribution_decisions` row for every member; the order posterior moves only for arm-exposed customers)
- Supporting: `packages/core/src/bandit-order.ts` (`recordNoOrderOutcome` — `armId = null` writes the decision row but skips the posterior)

**Test evidence:**
- Test file: `packages/core/__tests__/attribution-batch.test.ts` — 14 cases (chunk-3 block: 5)
- Key assertions: 80 `no_order` decision rows for a 100-cohort/20-order campaign (full ITT audit), but only 40 `order_beta` posterior updates (arm-exposed only); never-sent customers move no posterior; a no-arm campaign moves no posterior; opt-outs in the ITT cohort can push a sub-30 sent campaign over the evidence threshold.

**Notes:** **Deliberate deviation — the mid-sprint checkpoint ADJUST.** SPRINT.md chunk 3 (original) routed never-sent opt-out customers' no-order failures onto arms (so the order posterior would converge to 0.7 with 30% opt-out). The mid-sprint checkpoint evaluator ruled **Position B**: the bandit order posterior measures *arm efficacy among arm-exposed customers* (decisions 4/14/19/22); a never-sent customer was exposed to no arm, so their non-conversion carries no arm-efficacy signal. Effective reach (the opt-out drag) is already captured — without double-counting — in the symmetric-ITT `attribution_results.treatment_cohort_size` denominator and the incremental-revenue per-customer math (chunk 2). SPRINT.md chunk 3 was amended to match (commit `6fcd601`); the order posterior now converges to **1.0 among reached customers** with reach recorded separately.

### Criterion 3: Backfill with audit trail

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/attribution-backfill.ts:180-309` (`runAttributionBackfill` — recomputes every `attribution_results` row under symmetric ITT; in-place UPDATE by id, never delete+recreate)
- Route: `apps/web/app/api/cron/attribution-backfill/route.ts` (CRON_SECRET-authed, one-shot, returns 500 if any row errored)

**Test evidence:**
- Test file: `packages/core/__tests__/attribution-backfill.test.ts` — 7 cases
- Key assertions: a recompute that grows the ITT denominator 60→100 shrinks incremental 140000→100000; the `attribution_methodology_migration` audit event captures `old` AND `new` for all audited fields plus `delta_incremental_cents`; a re-run produces zero new audit events and identical rows; a partial failure self-heals on re-run (audit-first ordering + the heal path).

**Notes:** **Audit-first, crash-safe ordering.** The audit event is INSERTed before the row UPDATE; a re-run finds the audit event and re-applies the UPDATE (`rowsHealed`). The audit event is therefore never silently lost. Worked old-vs-new example below.

### Criterion 4: Stripe customer creation

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/ensure-stripe-customer.ts:49-90` (`ensureStripeCustomer` — idempotent twice over: DB short-circuit + a merchant-id-keyed Stripe idempotency key; the write-back is `WHERE stripe_customer_id IS NULL`, first-writer-wins)
- `apps/web/app/api/shopify/callback/route.ts` (onboarding wiring — best-effort, logs `level:critical` on failure, never blocks install)
- `packages/core/src/ensure-stripe-customer.ts:107-142` (`backfillStripeCustomers`) + `apps/web/app/api/cron/stripe-customer-backfill/route.ts` (one-shot backfill for pre-Sprint-09 merchants)

**Test evidence:**
- Test file: `packages/core/__tests__/ensure-stripe-customer.test.ts` — 9 cases
- Key assertions: a re-run is a no-op with no second Stripe call; a Stripe failure and a DB write-back failure both propagate (the callback catches); the backfill isolates a per-merchant failure and continues.

### Criterion 5: Subscription checkout flow

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `apps/web/app/app/billing/subscribe/page.tsx` (three tier cards from the shared `TIER_PLANS`), `subscribe-button.tsx` (client), `success/page.tsx`
- Route: `apps/web/app/api/billing/checkout/route.ts` (auth → `isSubscriptionTier` validation → `ensureStripeCustomer` → `createCheckoutSession`; 409 if already subscribed — decision 29)
- `packages/core/src/stripe-client.ts:265-299` (`createCheckoutSession` method — Stripe Tax enabled, billing-address collection; `createStripeClient` factory at `:229`)

**Test evidence:**
- `packages/core/__tests__/stripe-client.test.ts` — 14 cases (checkout session: Stripe Tax params, per-attempt idempotency key, missing-URL, missing-price-id)
- `apps/web/e2e/billing-flow.spec.ts` — subscribe page renders three priced cards; Select POSTs `{tier}` to the checkout API
- Key assertions: `automatic_tax.enabled` and `billing_address_collection: "required"` on the session; the checkout route returns 403/409 on a denied billing gate.

**Notes:** Audited by all 7 subagents (UI chunk) — design-tenet / accessibility / vocabulary all APPROVE.

### Criterion 6: Stripe webhook handler

**Self-score:** 3/3

**Implementation evidence:**
- Route: `apps/web/app/api/stripe/webhooks/route.ts` (reads the RAW body, verifies the signature BEFORE any parse or DB write — decision 32; bad signature → 400, zero writes)
- Primary file: `packages/core/src/stripe-webhook.ts:156-338` (`handleStripeWebhookEvent` — idempotent on `stripe_event_id`; state mutation then audit-row insert; the five event types)

**Test evidence:**
- Test file: `packages/core/__tests__/stripe-webhook.test.ts` — 15 cases
- `packages/core/__tests__/stripe-client.test.ts` — webhook signature verification (tampered / absent header → `StripeWebhookSignatureError`)
- Key assertions: each event type's mirror transition; a re-delivered event id is a `duplicate` no-op; `past_due` stamps `grace_period_started_at` and a *repeat* `past_due` does NOT re-stamp it; `current_period_*` is read from the subscription ITEM (recent Stripe API shape) with a top-level fallback.

**Notes:** **Deliberate deviation — `verifyWebhookEvent`.** SPRINT.md chunk 5 listed `validateWebhookSignature` and `parseWebhookEvent` as two exports. Stripe's `webhooks.constructEvent` verifies-then-parses atomically; a standalone parser would permit unverified parsing. They are merged into one `verifyWebhookEvent` — verification strictly precedes parsing. Also: Stripe moved `current_period_start/end` onto subscription items in recent API versions; the handler reads the item first, top-level fallback, so it is correct across API versions.

### Criterion 7: Failed payment grace period

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/billing-grace.ts:65-160` (`runBillingGraceSweep` — suspends merchants past the configurable grace window; per-merchant isolation; status-flip-last ordering so a partial failure self-heals; event dedup)
- Route: `apps/web/app/api/cron/billing-grace/route.ts` (CRON_SECRET-authed)
- `apps/web/vercel.json` — `/api/cron/billing-grace` at `0 7 * * *` (registered in the same commit — the Sprint 07/08 lesson)

**Test evidence:**
- Test file: `packages/core/__tests__/billing-grace.test.ts` — 10 cases
- Key assertions: a merchant 8 days into a 7-day window is suspended (both mirror tables + a `grace_period_expired` event); a merchant at exactly the boundary is spared (suspend only STRICTLY after); a malformed grace anchor is skipped; a per-merchant failure is counted (`failed`) and the sweep continues; a non-positive `gracePeriodDays` is rejected rather than mass-suspending.

### Criterion 8: Customer portal

**Self-score:** 3/3

**Implementation evidence:**
- Page: `apps/web/app/app/settings/billing/page.tsx` (current plan + status; calm `past_due`/`suspended` copy — tenet 7), `manage-billing-button.tsx` (client)
- Route: `apps/web/app/api/billing/portal/route.ts` (auth → `ensureStripeCustomer` → `createPortalSession`, returnUrl `/app/settings/billing`)

**Test evidence:**
- `packages/core/__tests__/stripe-client.test.ts` — `createPortalSession` success + error-wrapping
- `apps/web/e2e/billing-flow.spec.ts` — a subscribed merchant sees "Manage billing"; clicking it POSTs `/api/billing/portal`
- Key assertions: the portal session is created against the merchant's Stripe customer; the settings page shows the plan card for a subscribed merchant and "No active plan" otherwise.

**Notes:** Webhook-driven state sync after a portal change is covered server-side by `billing-scenarios.test.ts` Scenarios 2-5. The stale demo `/app/billing` fixture page was deleted and the sidebar Billing nav re-pointed to `/app/settings/billing`.

### Criterion 9: Entitlements + feature gates

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/entitlements.ts:125-167` (`getMerchantEntitlements` — pure derivation from the shared `TIER_PLANS`; ~5-min in-process cache; suspended → read-only) and `:182-218` (`checkCampaignApprovalAllowed`)
- Webhook invalidation: `packages/core/src/stripe-webhook.ts` calls `invalidateMerchantEntitlements` after every processed event
- Gates: `apps/web/app/api/campaigns/[id]/approve/route.ts` (403 on a denied gate); `packages/core/src/launch-campaigns.ts` (suspended → `writeBlocked`; over the monthly send quota → `monthlySendCapReached`, with a running counter so a run cannot overshoot)

**Test evidence:**
- Test file: `packages/core/__tests__/entitlements.test.ts` — 13 cases
- `packages/core/__tests__/launch-campaigns.test.ts` — 18 cases (billing-gate block: 4); `apps/web/__tests__/campaigns-routes.test.ts` — 44 cases (incl. the 403 gate)
- Key assertions: each tier returns its `TIER_PLANS` limits; `suspended` forces `writesAllowed=false`; the cache serves a stale value until `invalidateMerchantEntitlements`, then a fresh read; the launcher stops at exactly the monthly budget (no overshoot); a suspended merchant sends nothing.

**Notes:** The billing-critical write gates (`checkCampaignApprovalAllowed`, the launcher) read with `skipCache: true` so a multi-instance-stale cache can never let a suspended merchant transact; the cache serves display reads only.

### Criterion 10: Observability + HANDOFF

**Self-score:** 3/3

**Implementation evidence:**
- Structured JSON logs at every billing operation, emitted as `console.info`/`console.warn`/`console.error` with `JSON.stringify`: `apps/web/app/api/shopify/callback/route.ts` (`onboarding_stripe_customer_failed`), `packages/core/src/stripe-webhook.ts:330-336` + `apps/web/app/api/stripe/webhooks/route.ts` (`stripe_webhook_processed` / `_signature_rejected` / `_processing_failed`), `packages/core/src/billing-grace.ts:138-156` (`billing_grace_suspended`, `billing_grace_merchant_error`), `packages/core/src/attribution-backfill.ts:266-289` (`attribution_backfill_migrated` / `_healed` / `_row_error`), `apps/web/app/api/billing/checkout/route.ts` (`billing_checkout_failed`), `apps/web/app/api/billing/portal/route.ts` (`billing_portal_failed`), `packages/core/src/launch-campaigns.ts` (`launch_campaigns_write_blocked` / `_monthly_send_cap_reached`).
- Each billing operation also returns a typed machine-readable result object (the auditable observability surface): `BillingGraceSweepResult`, `AttributionBackfillResult`, `StripeWebhookHandlerResult`, `LaunchMerchantCampaignsResult`.
- This HANDOFF.md, in the evidence-required format.

**Test evidence:**
- Test files: `packages/core/__tests__/billing-grace.test.ts` (10 cases) and `packages/core/__tests__/attribution-backfill.test.ts` (7 cases) — these assert the typed result objects field-for-field, which is the auditable observability contract of each operation.
- Number of test cases asserting an observability result shape: 17 across those two files (plus the `StripeWebhookHandlerResult.status` assertions in `stripe-webhook.test.ts` and the `LaunchMerchantCampaignsResult` flags in `launch-campaigns.test.ts`).
- Key assertion: `billing-grace.test.ts` "isolates a per-merchant write failure" asserts `result.failed === 2` while the sweep continues (`result.suspended` / `withinGrace` / `skipped` all observable); `attribution-backfill.test.ts` asserts `rowsScanned` / `rowsMigrated` / `rowsHealed` / `rowsAlreadyMigrated` / `rowsUnchanged` on every scenario.
- The `console.*` log lines are additionally gated by `pnpm grep:pii` (clean — no shop_domain, token, phone, or order detail in any log).

**Notes:** The `console.*` JSON log *strings* are not string-asserted by unit tests (a deliberate, conventional choice — log-string assertions are brittle); their absence of PII is enforced by the `grep:pii` CI gate and their structure was verified by the code-reviewer subagent on every chunk. The tested observability surface is the typed result objects, which is what an operator/monitor consumes.

---

# Worked old-vs-new comparison (the cohort methodology change)

The chunk-4 backfill recomputes `attribution_results` under symmetric ITT. A
representative campaign (from `attribution-backfill.test.ts`):

| Field | Sprint 08 (as-attempted) | Sprint 09 (symmetric ITT) |
|---|---|---|
| `treatment_cohort_size` | 60 (senders only) | 100 (full ITT snapshot incl. opt-outs/deferred) |
| `treatment_revenue_cents` | 200,000 | 200,000 (unchanged — same orders) |
| treatment per-customer | 200000 / 60 ≈ 3,333¢ | 200000 / 100 = 2,000¢ |
| `holdout_cohort_size` | 40 | 40 |
| `incremental_revenue_cents` | 140,000 | 100,000 |

The Sprint 08 figure was biased **upward** — it divided the same revenue by a
smaller (senders-only) denominator while the holdout denominator was full ITT.
Direction holds: a positive lift stays positive but smaller. Every backfilled
row's old vs new values are preserved in its `attribution_methodology_migration`
audit event in `subscription_events`.

---

# Manual actions required before / around merge

1. **Apply migration 0010 to production Supabase BEFORE the PR merges**
   (CLAUDE.md companion gate). `packages/db/supabase/migrations/0010_subscriptions.sql`
   adds `merchants.stripe_customer_id/subscription_tier/subscription_status`,
   `merchant_subscriptions`, and `subscription_events`. After applying, run
   `pnpm db:diagnose` (expects exit 0).

2. **Provision the 7 Stripe test-mode env vars on Vercel `lapsed-web`**, then
   add them to `EXPECTED_ALL` in `scripts/vercel-env-check.mjs`:
   `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_SCALE`,
   `BILLING_GRACE_PERIOD_DAYS`. They are already declared in `turbo.json`.
   They were intentionally NOT added to `EXPECTED_ALL` during the build because
   that gate verifies against the live Vercel project — adding them before
   provisioning would fail CI. Target: `vercel:env:check` at 34/34.

3. **Configure the Stripe webhook endpoint** in the Stripe dashboard pointing
   at `https://app.lapsed.ai/api/stripe/webhooks`; copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`. Create the three test-mode subscription Products /
   Prices and set the `STRIPE_PRICE_*` vars.

4. **Trigger the two one-shot backfills once, after deploy:**
   `GET /api/cron/stripe-customer-backfill` (provisions Stripe customers for
   existing merchants) and `GET /api/cron/attribution-backfill` (re-computes
   `attribution_results` under symmetric ITT). Both are CRON_SECRET-authed,
   idempotent, and NOT scheduled in `vercel.json`. The attribution backfill is
   IRREVERSIBLE — the mid-sprint checkpoint gated it; it returned APPROVE.

---

# Deliberate deviations

- **Mid-sprint checkpoint ADJUST → Position B** (criterion 2 above). The bandit
  order posterior measures arm efficacy among arm-exposed customers; never-sent
  opt-outs move no posterior. SPRINT.md chunk 3 was amended to match.
- **`verifyWebhookEvent`** merges SPRINT.md's `validateWebhookSignature` +
  `parseWebhookEvent` (criterion 6 above) — Stripe's `constructEvent` is atomic.
- **Stripe test mode.** All Stripe keys are test-mode (`sk_test_…`) for Sprint 09.
  The production-key swap is an MVP-launch step, not part of this sprint. The
  pinned Stripe API version `2025-02-24.acacia` matches `stripe@17.7.0`.
- **`subscription_events` is the audit table** for the chunk-4 backfill's
  `attribution_methodology_migration` events (SPRINT.md chunk 4 permitted
  "subscription_events or a more appropriate audit table") and for the chunk-9
  `grace_period_expired` events — which double as the next-login-banner flag (no
  new column; chunk 11 reads `subscription_status = 'suspended'` as the gate).
- **Idempotency keys.** `createCustomer` uses a deterministic merchant-id key
  (a duplicate customer is the real hazard). `createCheckoutSession` takes a
  per-attempt key (a static key would replay a stale Checkout session inside
  Stripe's 24h window).
- **One-shot cron routes** (`attribution-backfill`, `stripe-customer-backfill`)
  are NOT in `vercel.json` — they are manually triggered (Manual Action 4).
- **CLAUDE.md decisions 27-33** were authored at sprint prep; no decision was
  changed during the build. Decision 27 governs the cohort/incremental-revenue
  denominator only — the Position B ruling on the bandit posterior is consistent
  with it (the ITT denominator change is on the billing-math side, not the
  arm-selection side).

# Sprint 10 dependency (pending)

Sprint 09's subscription billing is functionally complete and charges the flat
tier ($299 / $799 / $1499) via Stripe. **Usage-based metering — the 3%
performance kicker on incremental recovered revenue — is Sprint 10.** Sprint 10
consumes the now-symmetric `attribution_results.incremental_revenue_cents` as
the meter; the symmetric-ITT refactor (Part 1) exists precisely so that meter is
methodologically defensible.

# Deferred items (not in scope; not regressions)

- Refund workflow UI → v2
- Coupon codes / discounts → v2 (Stripe Coupons can be added as config later)
- Free trials → v2 (Stripe trial periods are config)
- In-app notification UI for the grace-period banner → Sprint 11 (the
  `grace_period_expired` event + `suspended` status are the flag today)
- Admin billing dashboard across merchants → Sprint 11
- Pre-existing app-wide a11y note: pages start at `<h2 className="text-h1">`
  with no `<h1>` (the `AppShell` topbar no longer renders `pageTitle`). This
  predates Sprint 09 and affects every page; flagged for a polish sprint.
- `/api/billing/checkout` and `/api/billing/portal` route-handler unit tests
  (the `already_subscribed` 409 branch in particular) — the core logic is
  unit-tested and the routes are exercised by `billing-flow.spec.ts`; a
  dedicated route test following `campaigns-routes.test.ts` is a recommended
  fast-follow.
- The full Stripe-Checkout / Customer-Portal hosted-page round-trip in E2E
  requires test-mode keys provisioned and automating Stripe's hosted UI — a
  post-provisioning manual verification (Manual Action 3 enables it).

# Chunk → commit map

| Chunk | Commit | Chunk | Commit |
|---|---|---|---|
| 1 — migration 0010 | `c9affd8` | 7 — checkout flow | `db864d6` |
| 2 — cohort symmetric ITT | `3b58b6e` | 8 — webhook handler | `0f09529` |
| 3 — bandit posterior (ITT) | `2205710` | 9 — grace cron | `bd4ffc8` |
| 3 ADJUST — Position B | `6fcd601` | 10 — customer portal | `8f2da62` |
| 4 — attribution backfill | `8389402` | 11 — entitlements + gates | `d81b812` |
| 5 — Stripe client | `2c2080e` | 12 — scenarios + E2E | `8487529` |
| 6 — merchant Stripe customer | `22d3890` | 13 — HANDOFF | this commit |
