# Sprint 09: Cohort Symmetric-ITT Refactor + Flat Subscription Billing

Date: 2026-05-17
Repo: lapsed
Branch: sprint-09/subscription-billing

---

## Scope

Sprint 09 does two things, in order:

**Part 1 (chunks 1-4) — Resolve the Sprint 08 cohort asymmetry.** The Sprint 08 final evaluator confirmed and flagged that Sprint 08's treatment cohort was as-attempted (customers who actually received an outbound) while the holdout was full ITT (frozen snapshot at proposal-creation). The asymmetry biases incremental revenue upward by excluding opt-outs and daily-cap-deferred customers from the treatment denominator while keeping them in the holdout denominator. This is a SPRINT.md-level methodology issue from Sprint 08, not a code bug, and the chosen resolution is symmetric ITT both sides — both cohorts source from `campaign_group_snapshots`, both use the campaign-calendar window. This MUST land before any billing UI ships, because Sprint 10 will charge a percentage of incremental revenue and the numbers must be defensible.

**Part 2 (chunks 5-12) — Flat subscription tier billing.** Stripe-integrated recurring subscription at three tiers ($299/$799/$1499 monthly), with merchant Stripe customer creation at onboarding, Stripe Checkout for tier selection, webhook-driven subscription state mirroring, failed-payment grace period, Stripe customer portal for self-service, entitlements + feature gates per tier. NO usage-based metering this sprint — that's Sprint 10, which will consume the now-symmetric attribution numbers as the meter.

**Not in scope this sprint:** Usage-based metering on incremental revenue (Sprint 10), refund workflow UI (v2), coupon codes / discounts (v2), free trials (v2 — can be added as Stripe config later), multi-currency invoicing beyond Stripe defaults (v2), custom tax logic (rely on Stripe Tax for AU GST, US sales tax, UK VAT — Stripe handles), admin dashboard for billing (Sprint 11 ops), per-merchant Twilio numbers (Sprint 11 ops), retroactive attribution-window changes (still v2 from Sprint 08).

---

## Acceptance Criteria

- [ ] `getTreatmentCohort` sources from `campaign_group_snapshots` where `is_holdout = false AND campaign_proposal_id = $1` — same pattern as `getHoldoutCohort` from Sprint 08.
- [ ] `getTreatmentOrders` uses campaign-calendar window (anchored at `launched_at` + `attribution_window_days`), NOT per-customer windows. Symmetric with `getHoldoutOrders`.
- [ ] `recordNoOrderOutcome` in `attribution-batch.ts` loops over the full ITT treatment snapshot (including opt-outs and daily-cap-deferred), not just sent-to customers. Bandit `order_beta + 1` fires for every cohort member with no order in window. Idempotent per (customer, campaign).
- [ ] Backfill all existing `attribution_results` rows under the new methodology via `/api/cron/attribution-backfill`. Audit trail: each backfilled row writes a `attribution_methodology_migration` event capturing old vs new `treatment_revenue_cents`, `holdout_revenue_cents`, `incremental_revenue_cents`, `treatment_cohort_size`, `holdout_cohort_size`.
- [ ] Constructed scenarios (Sprint 08 chunk 12) re-run under new methodology and pass with adjusted expectations (treatment cohort sizes now include opt-outs/deferred — verify the math direction matches: treatment_per_customer should DECREASE; incremental should DECREASE relative to Sprint 08's numbers).
- [ ] Monte Carlo Welch CI coverage test still passes in [0.93, 0.97] bracket band.
- [ ] Migration 0010 adds: `merchants.stripe_customer_id`, `merchants.subscription_tier`, `merchants.subscription_status`; new tables `merchant_subscriptions` (mirror of Stripe state) and `subscription_events` (append-only). RLS + append-only triggers.
- [ ] Stripe customer creation on merchant onboarding is idempotent (re-running onboarding doesn't create duplicate customers).
- [ ] Subscription checkout flow: three tier cards on `/app/billing/subscribe`; Stripe Checkout session created via API; redirect to Stripe-hosted checkout; success/cancel URL routing handled.
- [ ] Stripe webhook handler at `/api/stripe/webhooks` validates Stripe signature BEFORE body parsing (signature mismatch = 400, no DB writes). Idempotent on Stripe event ID. Handles: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`.
- [ ] Failed payments enter 7-day grace period (configurable via `BILLING_GRACE_PERIOD_DAYS`); after grace expiry, merchant transitions to `suspended` (entitlements drop to read-only). Daily cron at 07:00 UTC.
- [ ] Stripe Customer Portal integration: merchant settings page → "Manage Billing" → Stripe portal session → redirect to Stripe-hosted portal for tier changes, payment method updates, cancellation.
- [ ] Entitlements function `getMerchantEntitlements(merchantId)` returns tier-based feature set. Gates enforced at API layer. Cached ~5 min in-memory, invalidated on webhook receipt.
- [ ] Three test-mode Stripe subscription products configured (Starter/Growth/Scale) with price IDs in env vars.
- [ ] No credit card data stored anywhere in our database. Stripe tokenization only.
- [ ] HANDOFF.md uses evidence-required format. Deliberate deviations include the cohort methodology change (with old-vs-new attribution_results comparison data from the backfill audit).

---

## Definition of Done

- [ ] All 13 acceptance criteria checked with evidence.
- [ ] All 10 rubric criteria self-scored 3/3 in HANDOFF.
- [ ] CI gates green: typecheck, lint, test, build, grep:pii, vercel:env:check (with 7 new Stripe-related vars), db:diagnose (with migration 0010 applied).
- [ ] Mid-sprint checkpoint at chunk 3 passed BEFORE chunk 4 backfill runs against production data. This barrier is earlier than the usual chunk-7 position because the backfill mutates production data — checkpoint must approve the math change BEFORE the backfill commits.
- [ ] Branch pushed; PR not opened by build agent (human gate).

---

## Architectural Decisions Added This Sprint (27-33)

27. **Cohort definition is symmetric ITT.** Both treatment and holdout cohorts source from `campaign_group_snapshots` (the frozen Sprint 06 snapshot). Both use the campaign-calendar attribution window anchored at `launched_at`. This supersedes Sprint 08's documented as-treated-vs-ITT asymmetry. Treatment cohort INCLUDES opt-outs and daily-cap-deferred customers in the denominator; they contribute zero revenue but count in the cohort size. Reason: methodological symmetry is the only defensible basis for percentage-of-incremental-revenue billing in Sprint 10.

28. **Stripe customer creation at merchant onboarding (not lazy).** Every merchant gets a `stripe_customer_id` at first signup, regardless of whether they subscribe. Reason: avoids race conditions where subscription attempts happen before the customer record exists; simplifies downstream code that can assume the ID is always present.

29. **Stripe is the source of truth for subscription state; local mirror is eventually-consistent.** The `merchant_subscriptions` table is a read mirror updated via Stripe webhooks. Never compute billing decisions from local mirror state without webhook reconciliation. Application code reads from the mirror for display; sensitive operations re-verify against Stripe.

30. **Subscription tier determines feature entitlements via a pure function.** `getMerchantEntitlements(merchantId)` reads the cached tier and returns a typed entitlements object. No separate entitlements table. Tier transitions update entitlements via webhook receipt. Reason: single source of truth, no drift possible.

31. **Failed payments enter 7-day grace period before suspension.** Immediate revocation is hostile UX and a churn driver. Grace period gives merchants time to update expired cards. After grace, entitlements drop to read-only (existing campaigns continue, no new sends, no new approvals).

32. **Stripe webhooks are idempotent via Stripe event ID.** Same pattern as Twilio MessageSid idempotency from Sprint 07. The `subscription_events` table stores Stripe event IDs as the dedup key. Re-delivery is safe.

33. **Tax handling via Stripe Tax (automatic).** No custom tax logic. Stripe Tax computes AU GST, US sales tax, UK VAT based on the merchant's billing address. Configure once, let Stripe run. Address collection is part of the subscription checkout flow.

Decisions 1-26 remain. New cumulative count: 33.

---

## Chunk Sequence (13 chunks, checkpoint barrier after chunk 3)

### Chunk 1 — Migration 0010: subscriptions schema

`packages/db/supabase/migrations/0010_subscriptions.sql`

Schema additions:
- `merchants.stripe_customer_id` (text, nullable, UNIQUE) — backfilled to NULL for existing rows
- `merchants.subscription_tier` (text, nullable — values: 'starter', 'growth', 'scale')
- `merchants.subscription_status` (text, nullable — values: 'trialing', 'active', 'past_due', 'canceled', 'suspended')

New tables:
- `merchant_subscriptions` — mirrors Stripe subscription state. Columns: `id` (PK), `merchant_id` (FK UNIQUE — one active subscription per merchant), `stripe_subscription_id` (text UNIQUE), `tier` (text), `status` (text), `current_period_start`, `current_period_end` (timestamptz), `grace_period_started_at` (timestamptz nullable — set when status becomes past_due), `cancel_at` (timestamptz nullable), `canceled_at` (timestamptz nullable), `created_at`, `updated_at`. RLS: merchant-scoped read; service-role write.
- `subscription_events` — append-only audit. Columns: `id` (PK), `merchant_id`, `stripe_event_id` (text UNIQUE — idempotency key), `event_type` (text), `data` (jsonb — full Stripe event payload), `appended_at`. Append-only trigger.

Indexes:
- `merchant_subscriptions (merchant_id)` — fast lookup
- `subscription_events (merchant_id, appended_at desc)` — audit traversal
- `merchant_subscriptions (status, grace_period_started_at) where status = 'past_due'` — partial index for grace-expiry cron

**No changes to attribution tables.** The cohort fix is in code, not schema.

RLS verified by RLS tests for both new tables.

### Chunk 2 — Cohort symmetric ITT refactor (treatment side)

`packages/core/src/attribution-treatment.ts`

Refactor:
- `getTreatmentCohort(campaignId)` — change source from `messages where direction=outbound AND campaign_id=X` to `campaign_group_snapshots where is_holdout=false AND campaign_proposal_id=X`. Returns the full ITT treatment cohort including opt-outs and daily-cap-deferred. Returns `customer_id[]`.
- `getTreatmentOrders(campaignId)` — change time anchor from per-customer `sent_at` to campaign-calendar window `[launched_at, launched_at + attribution_window_days]`. Same as `getHoldoutOrders` from Sprint 08.
- Single-attribution rule still applies: the LATERAL-equivalent JS logic (most-recent-preceding outbound across all campaigns wins) is unchanged. A customer in the treatment ITT snapshot who never received an outbound contributes zero orders to the campaign's attributed revenue — no outbound means no preceding outbound to win the attribution.

Tests:
- `getTreatmentCohort` returns the full snapshot ITT, including customers with no outbound history
- Cohort size matches `campaign_group_snapshots` row count where `is_holdout = false`
- `getTreatmentOrders` returns orders attributed to customers regardless of whether they were sent to
- Edge case: customer in ITT snapshot who opted out before the campaign launched — still in cohort, contributes zero revenue
- Edge case: customer in ITT snapshot whose send failed (Twilio error) — still in cohort, contributes zero revenue
- Single-attribution invariant: customer X in campaigns A+B, both ITT-snapshotted; B's outbound more recent than A's; order arrives — still attributes to B only

### Chunk 3 — Bandit posterior signal under ITT denominator

`packages/core/src/attribution-batch.ts`

Update `recordNoOrderOutcome`:
- Loop over the ITT treatment cohort returned by `getTreatmentCohort` (chunk 2's new shape)
- For each customer with NO attributed order in the window, fire `order_beta + 1` via `updateOrderPosterior` (existing chunk 7 path)
- Idempotency: stamp `(customer_id, campaign_id)` in a way that prevents double-firing on cron re-runs. Could be via `attribution_decisions` (new event type `no_order_itt`) or a new table; choose whatever's idempotent and audit-traversable.

**Critical math note for the build agent:** under symmetric ITT, the bandit's success-rate estimate (`order_alpha / (order_alpha + order_beta)`) is now bounded by the *send rate* — if 80% of the cohort actually got sends and 20% opted out, the maximum order rate the bandit can observe is 80%. This is methodologically correct: the bandit should know its effective reach including losses to opt-outs. Test this by constructing a cohort where 30% opt out and verifying the bandit's order posterior converges to the right rate.

Tests:
- ITT denominator iteration: cohort of 100 (60 sent to, 40 opt-out/deferred); 20 orders; verify 80 `order_beta + 1` updates land, not 40
- Idempotency: cron re-run produces no additional posterior updates
- Send-rate ceiling: cohort with 30% opt-out and 100% conversion among sent — bandit converges to 0.7, not 1.0

**MID-SPRINT CHECKPOINT BARRIER.** After chunk 3 lands and is auditor-clean, the build agent surfaces:
> "Chunk 3 complete. Mid-sprint checkpoint evaluator should now run BEFORE the chunk-4 backfill, because the backfill mutates production attribution_results. Awaiting human to launch a separate Claude Code session for checkpoint per CLAUDE.md → Mid-sprint checkpoint evaluator protocol."

Do not proceed to chunk 4 until APPROVE (or ADJUST-then-remediated). This barrier is earlier than the usual chunk-7 position; the rationale is the irreversibility of the backfill.

### Chunk 4 — Attribution results backfill

`apps/web/app/api/cron/attribution-backfill/route.ts` — one-shot cron route (not scheduled; manually triggered or runs once on next cron tick after merge).

Behavior:
- CRON_SECRET auth (existing pattern)
- For each existing `attribution_results` row: re-compute using the new symmetric-ITT methodology
- Write the new values back via the UNIQUE constraint (upsert on `(campaign_id, window_close_date)`)
- For each updated row, append `subscription_events` (or a more appropriate audit table) with event type `attribution_methodology_migration` containing old vs new values for all six fields: `treatment_revenue_cents`, `holdout_revenue_cents`, `incremental_revenue_cents`, `treatment_cohort_size`, `holdout_cohort_size`, `incremental_ci_low_cents`/`incremental_ci_high_cents` if applicable
- Idempotent: re-running produces the same final state (the audit event captures only the FIRST migration; subsequent runs are no-ops)
- Structured logs: `merchant_id`, `campaign_id`, `old_incremental_cents`, `new_incremental_cents`, `delta_cents`

**Decision: do NOT delete or re-write old `attribution_results` rows.** Update them in place. The audit event is the historical record of what changed. Reason: any merchant who already saw a number in their dashboard before the backfill ran needs the new number to be defensible against the old; the audit trail is the explanation.

After backfill: the daily attribution batch cron continues writing new rows under the new methodology going forward.

Tests:
- Backfill of a known scenario: pre-backfill row with `treatment_size=60, treatment_revenue=$5000`; post-backfill same campaign now has `treatment_size=100, treatment_revenue=$5000` (revenue unchanged, denominator grew) → `treatment_per_customer` drops from $83.33 to $50; incremental decreases proportionally
- Idempotency: re-run produces zero new audit events, identical row values
- Audit event has both old and new values

### Chunk 5 — Stripe client wrapper

`packages/core/src/stripe-client.ts`

- Wraps the `stripe` npm package. All Stripe SDK calls go through this module.
- Exports: `createCustomer(merchant)`, `createCheckoutSession(merchant, tier, returnUrls)`, `createPortalSession(merchant, returnUrl)`, `validateWebhookSignature(rawBody, signatureHeader)`, `parseWebhookEvent(rawBody)`.
- Configurable via `STRIPE_SECRET_KEY`. Throws structured errors with Stripe error codes preserved.
- Idempotency keys on customer creation and checkout session creation.
- Tests use `stripe-mock` or hand-mocked Stripe client; integration tests use real Stripe test mode.

### Chunk 6 — Merchant Stripe customer creation

Extend the merchant onboarding flow (find the existing onboarding API/route — likely `/api/merchants/onboarding` or similar):
- After merchant record is created, call `createCustomer(merchant)` from chunk 5
- Store returned `stripe_customer_id` on `merchants` table
- Idempotency: if `merchants.stripe_customer_id` is already populated, no-op
- Failure handling: if Stripe customer creation fails, log structured `level: critical` event; do NOT block onboarding (merchant can still use the app, will be prompted to retry on first subscription attempt)

For existing merchants without a Stripe customer ID: a separate one-shot backfill creates Stripe customers for all existing merchant rows. Could be combined with chunk 4's backfill route or kept separate. Prefer separate — they're conceptually different operations.

### Chunk 7 — Subscription checkout flow

`apps/web/app/app/billing/subscribe/page.tsx` + supporting API route `/api/billing/checkout`.

UI:
- Three tier cards: Starter $299/mo, Growth $799/mo, Scale $1499/mo
- Each card shows: price, tier features (campaign approval limit, monthly send cap, support tier, etc.)
- "Select" button on each card → POST to `/api/billing/checkout` with `{tier}` → returns Stripe Checkout session URL → client redirects
- Vellum tokens, no hex. WCAG 2.2 AA. No "cohort" / "blast" / etc. in copy.

API route:
- Validates merchant is authenticated
- Validates `tier` is one of the three valid values
- Looks up merchant's `stripe_customer_id` (creates if missing per chunk 6)
- Resolves tier → Stripe price ID from env (`STRIPE_PRICE_STARTER`, etc.)
- Calls `createCheckoutSession` with success URL `/app/billing/success` and cancel URL `/app/billing/subscribe`
- Returns the Stripe-hosted session URL

### Chunk 8 — Stripe webhook handler

`apps/web/app/api/stripe/webhooks/route.ts`

- HMAC signature validation via `stripeClient.validateWebhookSignature(rawBody, signatureHeader)` BEFORE body parsing. Failure: 400, no DB writes.
- Idempotency: check `subscription_events.stripe_event_id` for incoming `event.id`. If present, return 200 immediately (Stripe retries are real).
- Append `subscription_events` row with full event payload.
- Switch on `event.type`:
  - `customer.subscription.created` / `customer.subscription.updated`: upsert `merchant_subscriptions` row; update `merchants.subscription_tier` and `merchants.subscription_status`. On status transition into `past_due`, set `grace_period_started_at = now()`.
  - `customer.subscription.deleted`: update status to `canceled`; set `canceled_at`.
  - `invoice.payment_succeeded`: clear `grace_period_started_at` if set (recovery from past_due).
  - `invoice.payment_failed`: no-op (the subsequent `customer.subscription.updated` to `past_due` handles state).
- Unknown event types: log structured warning, return 200 (don't fail Stripe's webhook stream).
- Structured logs: `merchant_id`, `event_type`, `event_id`, `elapsed_ms`.

Tests:
- Signature validation: tampered signature returns 400, no DB writes
- Idempotency: same event ID processed twice produces one row, one merchant state update
- Each event type's state transition
- Unknown event type returns 200 without error

### Chunk 9 — Failed payment grace period cron

`apps/web/app/api/cron/billing-grace/route.ts`

- CRON_SECRET auth
- Runs daily at 07:00 UTC (after the rfm/score/attribution-batch crons)
- Queries `merchant_subscriptions where status = 'past_due' AND grace_period_started_at < now() - interval 'BILLING_GRACE_PERIOD_DAYS days'`
- For each: transition `merchants.subscription_status` to `'suspended'`; entitlements drop to read-only (handled in chunk 11)
- Append `subscription_events` row with event type `grace_period_expired`
- Notification: append a flag to the merchant for next-login banner; (in-app notification UI is Sprint 11 polish — for now, the flag is sufficient)
- Structured logs: `merchant_id`, `grace_started_at`, `days_in_grace`, `suspended_at`

Add to `apps/web/vercel.json` in the same commit (Sprint 07/08 lesson).

### Chunk 10 — Stripe customer portal integration

`apps/web/app/app/settings/billing/page.tsx`

- "Manage Billing" button → POST to `/api/billing/portal` → returns Stripe portal session URL → client redirects
- API route creates portal session via `stripeClient.createPortalSession(merchant, returnUrl)` where returnUrl = `/app/settings/billing`
- The portal handles: tier upgrades/downgrades, payment method updates, view invoices, cancellation
- Subsequent Stripe webhook receipt syncs state back to our DB

UI: simple settings card with current tier display + portal link. Vellum tokens, accessibility compliant.

### Chunk 11 — Entitlements + feature gates

`packages/core/src/entitlements.ts`

- `getMerchantEntitlements(merchantId)`: reads `merchants.subscription_tier` + `merchants.subscription_status`; returns typed entitlements object: `{maxCampaignsPerMonth, maxSendsPerMonth, supportTier, canExportData, ...}`. If `status = 'suspended'`, returns read-only entitlements regardless of tier.
- Cached in-process for ~5 min via a simple Map. Invalidated on Stripe webhook receipt (chunk 8 calls invalidation).
- Used as a gate at API layer: campaign approval (Sprint 06) checks `entitlements.maxCampaignsPerMonth`; outbound launcher (Sprint 07) checks `entitlements.maxSendsPerMonth`; etc.

Feature gates to add in this chunk:
- Campaign approval: deny if monthly count exceeded
- Outbound send: deny if monthly count exceeded
- Suspended status: deny all writes; allow reads

Tests:
- Each tier returns correct entitlements
- Suspended status forces read-only
- Cache invalidation on webhook receipt
- Gate denial returns proper user-facing error

### Chunk 12 — Constructed scenarios + E2E

Two test files:

`packages/core/__tests__/billing-scenarios.test.ts` (Vitest):
- Stripe customer creation idempotency
- Subscription lifecycle (create → upgrade → downgrade → cancel)
- Failed payment → grace → recovery happy path
- Failed payment → grace expiry → suspension
- Webhook idempotency (same event ID processed twice)
- Webhook signature validation (tampered = 400)
- Entitlements per tier
- Suspended status forces read-only

`apps/web/e2e/billing-flow.spec.ts` (Playwright):
- Onboarding → subscribe → Stripe Checkout (test mode) → success → state reflected in app
- Settings → portal → simulate Stripe webhook on return → state updated

### Chunk 13 — HANDOFF.md

Evidence-required format. 10 rubric criteria, each with file:line implementation refs + file:line test refs + test count + named assertion.

Deliberate deviations to include:
- Cohort methodology change (with backfill audit comparison data — at least one example old-vs-new from a real-ish scenario)
- Stripe test mode vs production mode toggle status
- The fact that Sprint 10 will add usage metering on top; Sprint 09's subscription billing is functionally complete without it but charges only the flat tier until Sprint 10 ships
- Any deferred items (refund UI, coupon codes, etc.)

---

## Quality Rubric (10 criteria)

| # | Criterion | What 3/3 looks like |
|---|---|---|
| 1 | Cohort symmetric ITT | getTreatmentCohort + getTreatmentOrders refactored, snapshot source, calendar window, single-attribution preserved |
| 2 | ITT bandit posterior signal | recordNoOrderOutcome iterates full snapshot, posterior signal correct for opt-outs/deferred, idempotent |
| 3 | Backfill with audit trail | Backfill cron idempotent, audit event captures old vs new for every changed row |
| 4 | Stripe customer creation | Idempotent at onboarding, failure handling, structured logs |
| 5 | Subscription checkout flow | Three tier cards, Stripe Checkout session, success/cancel routing, vellum/a11y compliant |
| 6 | Stripe webhook handler | Signature validated pre-parse, idempotent on event ID, all 5 event types handled, audit trail |
| 7 | Failed payment grace period | 7-day grace via cron, suspension on expiry, notification flag, vercel.json updated |
| 8 | Customer portal | Portal session creation, redirect, state sync via webhook |
| 9 | Entitlements + feature gates | getMerchantEntitlements per tier, suspension forces read-only, gates at API layer |
| 10 | Observability + HANDOFF | Structured logs at every billing operation, evidence-required HANDOFF, deliberate deviations |

---

## Out of Scope

- Usage-based metering on incremental revenue → Sprint 10
- Refund workflow UI → v2
- Coupon codes / discounts → v2 (Stripe Coupons can be added later)
- Free trials → v2 (Stripe trial periods can be added later as config)
- Multi-currency invoicing beyond Stripe defaults → v2
- Custom tax logic → v2 (Stripe Tax handles AU GST, US sales tax, UK VAT)
- Admin dashboard for billing across all merchants → Sprint 11 (ops)
- Per-merchant Twilio numbers → Sprint 11
- Retroactive attribution-window changes on existing proposals → v2
- In-app notification UI for grace period → Sprint 11 polish (a flag is set in chunk 9; UI to surface it comes later)
- Email notifications on payment events → v2 (Stripe sends its own; we can add custom emails later)
