# CLAUDE.md — Initializer for the lapsed.ai monorepo

> This file is the spec every Claude Code session reads first. It defines what the project is, how it's built, what's true today, and what comes next. When you finish a session, leave failure modes you encountered in the "Failure modes encoded so far" section so the next session inherits the learning.

## What lapsed.ai is

AI-driven dormant customer recovery SaaS for Shopify merchants. Identifies customers who've stopped buying, engages them via two-way SMS conversations powered by an LLM, and attributes recovered revenue back to specific campaigns. Sells on a tiered subscription model (Starter $299 / Growth $799 / Scale $1499 monthly) with a 3% performance kicker on recovered revenue.

ICP: Shopify DTC merchants doing $2M–$50M in revenue. Positioning: focused win-back specialist, not a generalist SMS platform — the differentiation is the AI conversation engine and the closed-loop revenue attribution against Shopify orders.

## Stack (pinned)

- **Framework**: Next.js 15.1 (App Router) — pinned; Next 16 GA migration is its own post-v1 sprint
- **Database**: Supabase Postgres (project `lapsed`, region `ap-southeast-2` Sydney, ref `vuyjtkpubxadudahzrlh`)
- **Hosting**: Vercel, region `syd1`, three projects: `lapsed-web`, `lapsed-marketing`, `lapsed-storybook`
- **Monorepo**: Turborepo + pnpm v10.13.1, workspaces under `apps/*` and `packages/*`
- **Language**: TypeScript strict, zero `any`, zero `@ts-ignore`/`@ts-expect-error`
- **Linting**: ESLint 8 — pinned; ESLint 9 flat config migration ships alongside Next 16
- **Auth (merchant ↔ app)**: Shopify OAuth + App Bridge session tokens (JWT)
- **Encryption at rest**: AES-256-GCM with key in `TOKEN_ENCRYPTION_KEY` env var (key never reaches Postgres)
- **SMS**: Twilio (toll-free `+18888800461`, sandbox + test recipient `+61408768484`)
- **Conversation LLM**: Anthropic `claude-sonnet-4-6`
- **Scoring LLM**: Anthropic `claude-haiku-4-5-20251001` (batch-friendly, cost-effective)
- **Billing**: Stripe (sandbox until v1 cutover)
- **Email (transactional only)**: Resend, domain `lapsed.ai` verified in Tokyo region. Marketing-email-as-channel is post-v1.

## Domains

- `app.lapsed.ai` → `lapsed-web` (merchant-facing embedded app)
- `lapsed.ai` and `www.lapsed.ai` → `lapsed-marketing` (public marketing site)
- `storybook.lapsed.ai` → `lapsed-storybook` (component library, internal)

## Shopify app config

Source of truth is `shopify.app.toml` at repo root. Push changes via `shopify app deploy` (the legacy `shopify app config push` was removed in Shopify CLI 3.x).

- **Client ID / API Key**: stored as `SHOPIFY_API_KEY` (server) and `NEXT_PUBLIC_SHOPIFY_API_KEY` (client, identical value — the API key is public, only the secret is sensitive)
- **Webhooks API version**: `2026-04`
- **Required scopes** (requested at install): `read_customers,read_orders,read_products,write_discounts,write_pixels`
- **Optional scopes** (declared, requested dynamically when features need them): `read_inventory,read_checkouts,write_draft_orders,read_locations,read_price_rules`

## Design system

**Codename: Vellum.** Lavender (`#B8A6F4`) + cream (`#F8F5EE`) + ink black (`#0A0A0B`). Geist Sans for body and tabular numbers; Instrument Serif for hero numerals only (the $47,283 treatment on Dashboard/Attribution). Full token set in `packages/ui/src/tokens.css` and `packages/ui/src/tailwind-preset.ts`. All component variants live in `packages/ui/src/components/*`.

Brand mark is `lapsed.` (lowercase with period). App Store name is `Lapsed`.

## Sprint sequence to v1 (SMS-only)

Each sprint ships with: `SPRINT.md` for scope and acceptance criteria, an adversarial evaluator session post-implementation, and `HANDOFF.md` at the end. The sprint branch merges via PR with green CI before the next sprint starts.

- **Sprint 01** ✅ Design system + clickable v1 UI with seed fixtures (merged)
- **Sprint 02** ✅ Repo backend foundation + Shopify OAuth + merchant auth + encrypted tokens (merged, with PRs #3–6 covering App Bridge loading, host-decode, root-embedded entry, OAuth iframe cookies, Turborepo env passthrough)
- **Sprint 02.5** ← UI Polish (cosmetic + a11y + format helpers + topbar wiring). The current sprint.
- **Sprint 03** Data ingestion (webhooks + Shopify backfill) + fixture-to-real-data sweep + empty / loading / error states across every screen
- **Sprint 04** Cadence calculation + lapsed classification + scoring (Haiku-powered batch)
- **Sprint 05** Onboarding flow refresh + AI-suggested brand voice from storefront analysis
- **Sprint 06** SMS sending + two-way conversation engine + opt-out registry + Twilio inbound webhooks
- **Sprint 07** AI Campaign Designer — analyzes shop data + scored cohorts to suggest cohort definitions and offer recommendations
- **Sprint 08** Attribution reconciliation + Stripe billing + usage metering
- **v1.0 launch**

## Post-v1 backlog (deferred — NOT in scope until v1.0 ships)

Do not pull these forward into earlier sprints without an explicit decision recorded here.

- **Email channel**: parallel to SMS as a campaign output. Substantial scope — Resend integration as outbound sender, separate compliance (List-Unsubscribe, GDPR), send-time logic, deliverability tracking, inbound bounce handling.
- **AI Email Designer agent**: storefront crawler + design token extraction + MJML / React Email template generation matching merchant aesthetic. Depends on Email channel sprint.
- **Mobile responsive pass**: sidebar collapse, hamburger nav, touch targets — Shopify mobile admin embeds these screens.
- **Multi-store / team management**: multiple users per merchant with role-based access; one merchant managing multiple Shopify stores.
- **Next 16 + ESLint 9 migration**: coordinated upgrade once Next 16 is GA and `eslint-config-next` supports flat config.
- **Webhook handlers for GDPR mandatory topics** (`customers/data_request`, `customers/redact`, `shop/redact`): required for App Store listing but not for private install testing.
- **Dark mode**: Vellum is light-only currently.
- **Cmd+K global command palette**.

## Quality rubric (12 criteria, scored 0–3 per sprint)

Each sprint that touches a relevant area scores against these. Anything below 3 needs remediation before sprint close.

1. Tenancy isolation tested with cross-merchant access attempt
2. Shopify HMAC signature verified on every callback + webhook
3. Twilio inbound webhook signature verified
4. Stripe webhook signature + idempotency key handling
5. Opt-out registry consulted before every send
6. LLM conversation guardrails (system prompt, refusal patterns, max-turn limits, no PII leakage)
7. Attribution reconciles against Shopify orders (no drift > 1% in nightly checks)
8. No PII (shop_domain, tokens, customer phone, order details) in logs — verified by `pnpm grep:pii`
9. Anthropic + Twilio API calls have timeout + retry policy with exponential backoff
10. DB-generated TypeScript types end-to-end (Supabase `gen types` consumed by all packages)
11. UI surfaces use Vellum tokens — no hardcoded colors / fonts / radii outside `packages/ui`
12. Optional Shopify scopes declared in `shopify.app.toml` but requested dynamically only when features need them (not at install)

## Architectural load-bearing decisions

These decisions are expensive to retrofit. Any code that touches them is reviewed by the `architecture-guardian` subagent (see `.claude/agents/architecture-guardian.md`). "We'll fix it later" is not an acceptable deferral for any of these.

1. **Event-sourced customer memory graph (Sprint 03).** Append-only event log with timestamp + source. Materialised customer profile regenerated nightly. No snapshot mutations — every customer state change is an appended event, never an `UPDATE` to the profile row.
2. **pgvector for conversation memory (Sprint 03, not later).** Semantic search over conversation transcripts requires an embedding column on the conversations table from the start. Adding vector search to an existing schema is a migration burden; getting it right on first build is not. Schema decisions ripple through the conversation engine.
3. **Channel-agnostic conversation engine (Sprint 07).** Channel is a parameter (`"sms" | "voice" | "email"`), not a hardcoded assumption. v1 ships SMS only, but every function signature, prompt template, and event record accepts channel cleanly. No `if channel === 'sms'` branching without an abstraction. No `sendSms(...)` functions — `sendMessage(..., channel)`.
4. **Bandit state as first-class data structure (Sprint 06).** Thompson sampling state per group across hypothesis dimensions (offer type, message timing, tone). Not a future enhancement — campaign generation reads from and writes to bandit state on every run. A/B test logic that bypasses the bandit state is a violation.
5. **Holdout control groups baked into every group engagement (Sprint 08).** 10% randomised holdout per group, per campaign, deterministically seeded by `(campaign_id, customer_id)`. Never optional. If a cohort is "too small" for a holdout, it is too small to run a campaign on — the answer is not to skip the holdout.
6. **Performance pricing on incremental revenue, not gross.** Billing math is `(attributed revenue × incrementality factor)`. The incrementality factor is derived from holdout group comparison. No invoice line item uses gross attributed revenue without the adjustment. "We'll fix it later" means the billing math is wrong from day one.
7. **Brand voice profiles are versioned and immutable (Sprint 05).** Re-extraction creates a new `voice_versions` row. Active version tracked via `agent_profiles.active_voice_version_id`. Prior versions retained for audit. Editing = new version with edits applied; old version remains.
8. **Storefront snapshots persisted before synthesis (Sprint 05).** Full input corpus written to `storefront_snapshots` before any LLM call. Same snapshot + same model + same prompt = same output. Enables replay if the voice algorithm changes.
9. **Voice synthesis uses Sonnet 4.6 with structured output (Sprint 05).** Not Haiku. One-shot, high-leverage. `tool_choice` with strict JSON schema; retry up to 3 attempts; token usage accumulated.
10. **PII redaction mandatory before any LLM call (Sprint 05).** Pre-flight test fails the call if PII patterns remain after redaction. No storefront content reaches Sonnet unredacted.
11. **Agent identity uses functional language only — no personal names (Sprint 05).** Role descriptors drawn from a taxonomy enum. Type-level rejection of freeform persona names.
12. **Voice events are event-sourced (Sprint 05).** Every extraction writes a `voice_extracted` event via `appendVoiceEvent`. Current state in `agent_profiles` is materialized cache, regeneratable from events. Consistent with decisions 1 and 2.
13. **Campaign proposals merchant-approved before any send (Sprint 06).** No auto-launch path exists. Every campaign requires a recorded `campaign_approved` event from the merchant before downstream sending becomes possible. Sprint 07's conversation engine reads from `getReadyCampaigns(merchantId)`, which filters to proposals where the latest event is `campaign_approved`. Timer-based auto-approval or "approve after N hours" escalation is explicitly excluded — adding either would violate this decision.
14. **Bandit arms are versioned and immutable (Sprint 06).** Once a proposal is approved and arms are initialized in `bandit_state`, those arms cannot be edited in-place. Editing a campaign creates a new proposal version with new arms; old arms are retained for performance analysis and audit. Mirrors decision 7 (voice profiles versioned). Posterior updates (Sprint 07+) write to the existing arm's row — that's a separate mutation pattern that updates statistics, not the arm's identity or contract.
15. **Group snapshots frozen at proposal creation (Sprint 06).** When a campaign proposal references a customer group, the customer set is snapshotted to `campaign_group_snapshots` at proposal time. Subsequent changes to the underlying group definition (re-scoring, lifecycle drift, customer add/remove) do NOT change which customers receive the campaign. This is essential for attribution math in Sprint 08: incremental revenue is computed against the snapshotted holdout, not a live recompute. A campaign's customer set is determined exactly once, at proposal time.
16. **Conversations are per-customer, not per-campaign (Sprint 07).** A customer in multiple campaigns generates ONE conversation thread, keyed by `(merchant_id, customer_id)`, not one per campaign. Messages reference both `conversation_id` (which thread they belong to) and an optional `campaign_id` + `arm_id` (which campaign drove the outbound). Inbound replies attach to the conversation; bandit posterior updates route to the most recent outbound's arm. Customers experience a single relationship with the merchant, not a thread per marketing campaign — cross-campaign context is preserved.
17. **Inbound webhook is synchronous (Sprint 07).** The `/api/sms/inbound` route generates the reply in-band and returns it as TwiML in the webhook response. No queue, no async worker. Latency budget: 5 seconds p99 from Twilio's POST to our TwiML response. If Sonnet hasn't returned by 4 seconds, the route returns a safe fallback ("Thanks — we'll get back to you shortly.") and queues a follow-up generation for the next cron tick. Synchronous keeps the conversation feeling immediate and avoids the operational complexity of a queue + worker for v1.
18. **Opt-outs are immutable and dual-recorded (Sprint 07).** When a customer opts out (STOP keyword, Sonnet-detected opt-out intent, or merchant manually marks): the opt-out is written to `customer_opt_outs` (append-only, event-sourced) AND Twilio's built-in opt-out tracking is updated. Once opted out, no campaign cron path can ever include that customer again — `assertNotOptedOut` is a mandatory pre-flight before every outbound send, similar to `assertNoPii` in Sprint 05's voice pipeline. Re-engagement requires a fresh customer-initiated message; we never "expire" an opt-out. Spam Act (AU), TCPA (US), and GDPR (EU) all converge on immediate-and-permanent opt-out semantics. Defense in depth: our table is the application source of truth, Twilio's tracking is the safety net.
19. **Bandit posterior updates fire on sentiment-classified positive intent (Sprint 07).** When an inbound reply is classified by Sonnet as positive sentiment + (purchase intent OR engagement intent), the bandit arm that sourced the outbound message gets `updatePosterior(armId, success=true)`. Negative, neutral, or opt-out replies fire `updatePosterior(armId, success=false)`. No-reply (after `NO_REPLY_SWEEP_DAYS`, default 7) also fires `success=false` via a daily cron. The "real" success signal (completed Shopify order within 14 days) is Sprint 08 territory and will adjust posteriors retroactively. Sentiment is fast enough for bandit convergence within a campaign cycle; order completion is slow but ground truth — Sprint 08 reconciles the two.
20. **Attribution windows are per-merchant configurable and immutable per proposal.** Each merchant has an `attribution_window_days` setting (default 14, stored in `merchant_attribution_config`). At proposal-approval time, the current merchant value is stamped onto `campaign_proposals.attribution_window_days` and becomes immutable for that proposal. Subsequent changes to the merchant default affect only future proposals. Reason: attribution numbers must be deterministic and auditable — retroactive window changes would invalidate already-reported lift figures and create non-reproducible billing.
21. **Single-attribution per order.** When a customer who has received outbounds from multiple campaigns places an order, the order is attributed to exactly one campaign: the most-recent-preceding outbound within its attribution window. No double-counting, no fractional credit. Reason: matches the per-customer conversation threading in decision 16; keeps the math defensible to merchants ("show me which message earned the credit"); avoids the explosion in multi-touch-attribution complexity at v1.
22. **Bandit posterior is dual-signal.** Each `bandit_state` arm now maintains TWO posterior pairs: `sentiment_alpha`/`sentiment_beta` (from Sprint 07, fired on inbound sentiment classification) AND `order_alpha`/`order_beta` (from Sprint 08, fired on attributed-order arrival or window-close without order). Arm selection at proposal-creation time uses the order posterior when `order_observation_count ≥ 30`, otherwise falls back to the sentiment posterior. Reason: lagging order signal is ground truth but slow to mature; leading sentiment signal is fast but noisy. Maintaining both separately preserves the audit trail of which signal fired which update.
23. **LTV restoration is computed as cohort-relative delta, not modelled forecast.** For each campaign: per-customer 30-day-post-outbound revenue minus the holdout cohort's average 30-day revenue over the same calendar window, summed across the treatment cohort. No stay-probability modelling, no future-revenue projection beyond the observed window. Reason: simple, explainable to merchants, doesn't require historical data depth the v1 product can't yet rely on. Restoration is a measurement of what happened, not a forecast of what will happen.
24. **Order events are event-sourced (decision 12 extended).** All writes to the `orders` materialised view go through `appendOrderEvent` in `packages/core/src/order-events.ts`. The `order_events` table is the source of truth; `orders` is a read view rebuildable from the event log. The Shopify webhook handler appends events; never writes directly to the orders table. Same pattern as customer_events, message_events, campaign_events.
25. **Order ingestion via Shopify `orders/create` webhook.** Real-time HMAC-validated ingestion is the only supported ingestion path in v1. No polling, no historical backfill via Admin API. Reason: real-time matters for attribution latency (window-close evaluation must reflect orders within hours of placement, not the next polling cycle); idempotency via `order_gid` uniqueness handles Shopify's retry behaviour cleanly; backfill is a v2 problem when we encounter a merchant who needs it.
26. **Attribution is computed nightly via batch cron, materialised into `attribution_results`.** The `/api/cron/attribution-batch` route is the only write path to `attribution_results`. UI components read from this materialised table, never from `computeIncrementalRevenue` directly at request time. Reason: deterministic display values that merchants can audit; computation is too expensive for request-time (joins across orders, message_events, campaign_group_snapshots, Welch t-test math); idempotent re-runs (the `(campaign_id, window_close_date)` UNIQUE prevents drift).
27. **Cohort definition is symmetric ITT.** Both treatment and holdout cohorts source from `campaign_group_snapshots` (the frozen Sprint 06 snapshot). Both use the campaign-calendar attribution window anchored at `launched_at`. This supersedes Sprint 08's documented as-treated-vs-ITT asymmetry, which biased incremental revenue upward by excluding opt-outs and daily-cap-deferred customers from the treatment denominator while keeping them in the holdout denominator. The treatment cohort now INCLUDES opt-outs and daily-cap-deferred customers in the denominator; they contribute zero attributed revenue but count in the cohort size. Reason: methodological symmetry is the only defensible basis for percentage-of-incremental-revenue billing in Sprint 10. The Sprint 08 attribution_results rows were backfilled under the new methodology with an audit trail preserving old vs new values.
28. **Stripe customer creation at merchant onboarding (not lazy).** Every merchant gets a `stripe_customer_id` at first signup, regardless of whether they ever subscribe. Reason: avoids race conditions where subscription attempts happen before the customer record exists; simplifies all downstream code that can assume the ID is always present.
29. **Stripe is the source of truth for subscription state; local mirror is eventually-consistent.** The `merchant_subscriptions` table is a read mirror updated via Stripe webhooks. Never compute billing decisions from local mirror state without webhook reconciliation guarantees. Application code reads from the mirror for display; sensitive operations re-verify against Stripe.
30. **Subscription tier determines feature entitlements via a pure function.** `getMerchantEntitlements(merchantId)` reads the cached tier and returns a typed entitlements object. No separate entitlements table. Tier transitions update entitlements via webhook receipt. Reason: single source of truth, no drift between intended and applied access levels.
31. **Failed payments enter 7-day grace period before suspension.** Immediate revocation on first failed payment is hostile UX and a churn driver. Grace period gives merchants time to update expired cards or resolve transient bank issues. After grace expiry, entitlements drop to read-only (existing campaigns continue but no new sends, no new approvals, no exports).
32. **Stripe webhooks are idempotent via Stripe event ID.** Same pattern as Twilio MessageSid idempotency from Sprint 07. The `subscription_events` table stores Stripe event IDs as the deduplication key. Re-delivery is safe — Stripe retries are real and frequent. Signature validation happens BEFORE body parsing.
33. **Tax handling via Stripe Tax (automatic), not custom logic.** Stripe Tax computes AU GST, US state sales tax, UK VAT, EU VAT based on the merchant's billing address. Configure Stripe Tax once at account level; let it run on every invoice. Address collection is part of the subscription checkout flow.

## Pre-sprint preflight (run BEFORE starting Sprint N)

Before launching the build session, run:

    pnpm db:diagnose

Exits 0 if production Supabase has every migration's expected tables/views/functions/extensions applied; exits 1 with a per-migration breakdown if anything is missing. Apply the missing migration(s) via Supabase SQL editor before proceeding.

The script is self-maintaining — it parses `packages/db/supabase/migrations/*.sql` to derive expectations, so new migrations are automatically covered without updating the diagnostic.

**Companion gate — apply N's migration before merging**. When a sprint introduces a new migration, that migration MUST be applied to production Supabase BEFORE the sprint PR merges. Document this as a manual action in HANDOFF.md and verify before opening the PR.

## Conventions

- **Sprint branches**: `sprint-NN/<short-name>` or `fix/<short-name>` for hotfixes
- **Commits**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- **PRs**: opened against `main`, squash-merged after green CI
- **Worktree mode**: prefer Claude Code's worktree mode for sprint work so the main checkout stays clean
- **Env vars**: every server-side var read by `apps/web` MUST be declared in `turbo.json`'s `tasks["@lapsed/web#build"].env` array. The `pnpm vercel:env:check` script enforces parity between `EXPECTED_ALL`, Vercel project env, and `turbo.json`. Drift fails CI.
- **Encryption**: tokens encrypted at rest with AES-256-GCM in Node runtime; key never touches Postgres. `packages/db/src/encryption.ts` is the single helper.
- **Format helpers**: currency / date / timestamp formatting lives in `packages/ui/src/lib/format.ts` (lands in Sprint 02.5). Never format inline.
- **Parallel review during build**: seven specialist subagents in `.claude/agents/` can be dispatched in parallel after each implementation chunk to review work independently. See `.claude/agents/README.md` for which subagents to run per sprint type and how to dispatch them. The evaluator session (post-merge) and the subagents (during build) are both required — they are not substitutes for each other.

## Failure modes encoded so far

Each entry is a real bug we hit. Future sessions should read these before going near the relevant code.

- **Next 16 was not GA at install time**; pinned to `^15.1`. ESLint 9 flat-config isn't fully supported by Next 15's `next lint`; pinned to `^8`. Both unlock in a coordinated migration sprint post-v1.
- **App Bridge script loading**: React 19 / Next 15's `<Script strategy="beforeInteractive">` silently rewrites the tag with `async=""`, which Shopify rejects with `Shopify's App Bridge must be included as the first <script> tag and must link to Shopify's CDN. Do not use async, defer or type=module`. Fix: use a literal `<script>` JSX element inside a real `<head>` element in `apps/web/app/layout.tsx`, never Next's `<Script>` component for App Bridge.
- **App Bridge requires shop config field**: when Shopify Admin loads the embedded app via the sidebar, it passes `?host=` and `?shop=` to the root path (`/`), not to `/app/auth/install`. Don't blindly redirect from `/` — read params first, validate HMAC, route accordingly. See `apps/web/app/lib/root-redirect.ts`.
- **Next.js `redirect()` strips query strings**. Sprint 02 had three redirect hops (`/` → `/app` → `/app/auth/install`) that lost `?shop=`/`?host=` before they reached the install detection logic. Always preserve search params explicitly when redirecting between auth-context routes.
- **State cookie for OAuth must work in iframe context**: Chrome blocks third-party cookies (`SameSite=Lax`) on iframe-set cookies. Set state cookies with `SameSite=None; Secure; Partitioned`. Defense in depth: the root entry also does `window.top.location.href` to break out of iframe before hitting `/api/shopify/install`, so the cookie is set in first-party context.
- **Turborepo strips env vars not declared in `turbo.json`**. Even when set on the Vercel project, server-side vars are filtered from the build environment unless listed in `tasks["@lapsed/web#build"].env`. This caused silent runtime failures (Shopify API key undefined, encryption key undefined, etc.) that manifested as cookie / state / OAuth errors. The `vercel:env:check` script now also asserts parity with `turbo.json` to catch drift.
- **Supabase CLI link bug**: `supabase link` returns 403 "necessary privileges" for org owners on the new key system. Workaround: use `psql "$SUPABASE_DB_URL"` directly for migrations. The Supabase Vault extension was also unreliable on the new key system; we use `pgp_sym_encrypt` (via Node-side AES-GCM) instead.
- **Supabase publishable key format**: must be `sb_publishable_...` (not legacy `eyJ...` JWT). Required by the new key system. JWT signing for per-merchant RLS uses `SUPABASE_JWT_SECRET` from project settings.
- **Move-Item drops dotfiles**: PowerShell's `Move-Item` sometimes fails to move hidden directories (`.git`, `.gitignore`). After any directory move, verify `git status` works before continuing.
- **pnpm global bin dir**: `pnpm setup` must run before `pnpm add -g <pkg>` works on a fresh Windows machine. Adds `PNPM_HOME` to user PATH; restart shell after.
- **Shopify CLI commands changed**: `shopify app config push` was removed in 3.x. Use `shopify app deploy` instead. The CLI also moved authentication to the Shopify Dev Dashboard at `dev.shopify.com`, not `partners.shopify.com`.
- **Vercel monorepo Root Directory**: must be set explicitly per app project (`apps/web`, `apps/marketing`, `apps/storybook`) with "Include source files outside of the Root Directory" enabled so workspace packages resolve. Building from repo root fails because root `package.json` has no Next.js dependency.

## Conventions for evaluator sessions

After each sprint, open a separate Claude Code session pointed at the same repo with this prompt template:

```
You are a skeptical senior engineer doing QA on Sprint NN of lapsed.ai (<sprint scope>). Your job is to find everything wrong, incomplete, or inconsistent. Do not approve anything unless you are certain it meets the standard. Read CLAUDE.md, DESIGN-SYSTEM.md, SPRINT.md, HANDOFF.md in that order. Run pnpm typecheck, lint, test, build, test:e2e, grep:pii, vercel:env:check and report exact output. Verify every acceptance criterion against actual code — do not trust HANDOFF.md claims. Score each rubric criterion 0-3 with justification. Report PASS or REMEDIATE per criterion. Do not suggest the sprint is complete unless every criterion scores 3.
```

Treat the evaluator's verdict as binding. Don't merge until every criterion scores 3.

# Evidence-required HANDOFF format

Starting Sprint 05, every rubric self-score in HANDOFF.md MUST include three evidence components. Self-scores without all three components are treated as `0/3` by the evaluator, regardless of what number is written.

## Required template per rubric criterion

```
### Criterion N: [name]

**Self-score:** N/3

**Implementation evidence:**
- Primary file: `<path>:<start_line>-<end_line>`
- Supporting files (if any): `<path>:<line>`, `<path>:<line>`

**Test evidence:**
- Test file: `<path>:<test_block_start_line>-<test_block_end_line>`
- Number of test cases: N
- Key assertion(s): describe the specific assertion that proves the criterion is met (e.g., "asserts response_format is passed at line 156"; "asserts customer with stale engagement and unchanged lifecycle is skipped at line 312")

**Notes:** [Optional — only if deviations or context needed. NOT a substitute for evidence above.]
```

## What this prevents

The first HANDOFF.md from Sprint 04 had three fabricated 3/3 self-scores. The fabrications passed the build agent's own review because the agent confused "I addressed this concern" with "the implementation is complete and tested." Requiring file:line evidence forces the agent to look at actual code to fill the references. If the references don't exist, the score must drop.

## Evaluator instruction

When an evaluator session runs against a HANDOFF.md without this format, the evaluator should:
1. Treat every non-conforming criterion as `0/3`
2. Flag the format violation as a High finding in itself
3. Recommend REMEDIATE on format alone

The format is not optional after Sprint 05.

# Mid-sprint checkpoint evaluator protocol

The first evaluator pass on Sprint 04 caught 5 issues, one of them Critical. Several of those issues stemmed from structural drift in early chunks that compounded across later chunks. Catching this earlier — at the halfway point of the sprint — reduces the iteration count needed at sprint end.

## When the checkpoint runs

The checkpoint evaluator runs after the chunk numbered closest to half the chunk count. For a 13-chunk sprint, that's after chunk 7. For a 9-chunk sprint, that's after chunk 5. The chunk where this runs is marked in `SPRINT.md` with a `⚠️ Mid-sprint checkpoint` annotation.

## How to run it

1. After the chunk-7 commit lands on the sprint branch, open a fresh Claude Code session (not the build session)
2. Use **Opus 4.7 + Medium effort** (lighter than the full evaluator's High; the diff is half-size)
3. Paste the checkpoint-evaluator prompt below

## Checkpoint evaluator prompt template

```
You are the mid-sprint checkpoint evaluator for [Sprint N] on lapsed.ai. The build session is halfway done. Your job is to catch structural drift early — before it compounds across the remaining chunks. You are NOT the final evaluator. You score a smaller surface, with a lighter rubric, focused on early-stage course correction.

Read in order:
1. SPRINT.md — full spec, all 13 chunks
2. The diff: `git log main..HEAD --oneline` and `git diff main`
3. HANDOFF.md (if exists from a prior partial session)

Audit only the chunks that have landed. Skip anything not yet attempted.

## Phase 1 — Architectural alignment
For each architectural decision relevant to the chunks built so far:
- Is the foundation laid correctly? (Schema shape, event flow, helper signatures)
- Would the remaining chunks be forced to fight the foundation? If yes, fix the foundation now.

## Phase 2 — Drift detection
Compare the built chunks against SPRINT.md acceptance criteria:
- Are the chunks deviating from the spec in ways that will be expensive to undo later?
- Are there spec items being silently deferred to later chunks that shouldn't be?

## Phase 3 — Foundation for remaining chunks
- Do the data structures support what's coming?
- Are the helpers extensible for the remaining work?
- Is anything being built that will need to be replaced before sprint end?

## Verdict

APPROVE — proceed to chunk N+1
ADJUST — list specific structural fixes needed before continuing. NOT cosmetic issues; only items that would force expensive rework if deferred.

Be lighter than the final evaluator. Cosmetic issues, missing tests for non-critical paths, documentation gaps — those are all final-evaluator concerns. Your only job is to catch structural drift while it's still cheap to fix.
```

## Decision rule

- **APPROVE**: build session continues from chunk N+1 with no changes
- **ADJUST**: a focused remediation commit before chunk N+1. Fixes structural issues only. Re-run checkpoint evaluator after remediation if Critical structural issues found; otherwise proceed.

## Why this works

Structural drift is cheap to fix at chunk 7 (one foundation file affects 5 future chunks). It's expensive at chunk 13 (one foundation file affects 12 already-built chunks). Investing 30 minutes at the halfway mark saves potentially hours of remediation after the final evaluator finds the same issue compounded.

