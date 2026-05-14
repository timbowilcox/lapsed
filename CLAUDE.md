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

These six decisions are expensive to retrofit. Any code that touches them is reviewed by the `architecture-guardian` subagent (see `.claude/agents/architecture-guardian.md`). "We'll fix it later" is not an acceptable deferral for any of these.

1. **Event-sourced customer memory graph (Sprint 03).** Append-only event log with timestamp + source. Materialised customer profile regenerated nightly. No snapshot mutations — every customer state change is an appended event, never an `UPDATE` to the profile row.

2. **pgvector for conversation memory (Sprint 03, not later).** Semantic search over conversation transcripts requires an embedding column on the conversations table from the start. Adding vector search to an existing schema is a migration burden; getting it right on first build is not. Schema decisions ripple through the conversation engine.

3. **Channel-agnostic conversation engine (Sprint 07).** Channel is a parameter (`"sms" | "voice" | "email"`), not a hardcoded assumption. v1 ships SMS only, but every function signature, prompt template, and event record accepts channel cleanly. No `if channel === 'sms'` branching without an abstraction. No `sendSms(...)` functions — `sendMessage(..., channel)`.

4. **Bandit state as first-class data structure (Sprint 06).** Thompson sampling state per group across hypothesis dimensions (offer type, message timing, tone). Not a future enhancement — campaign generation reads from and writes to bandit state on every run. A/B test logic that bypasses the bandit state is a violation.

5. **Holdout control groups baked into every group engagement (Sprint 08).** 10% randomised holdout per group, per campaign, deterministically seeded by `(campaign_id, customer_id)`. Never optional. If a cohort is "too small" for a holdout, it is too small to run a campaign on — the answer is not to skip the holdout.

6. **Performance pricing on incremental revenue, not gross.** Billing math is `(attributed revenue × incrementality factor)`. The incrementality factor is derived from holdout group comparison. No invoice line item uses gross attributed revenue without the adjustment. "We'll fix it later" means the billing math is wrong from day one.

## Conventions

- **Sprint branches**: `sprint-NN/<short-name>` or `fix/<short-name>` for hotfixes
- **Commits**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- **PRs**: opened against `main`, squash-merged after green CI
- **Worktree mode**: prefer Claude Code's worktree mode for sprint work so the main checkout stays clean
- **Env vars**: every server-side var read by `apps/web` MUST be declared in `turbo.json`'s `tasks["@lapsed/web#build"].env` array. The `pnpm vercel:env:check` script enforces parity between `EXPECTED_ALL`, Vercel project env, and `turbo.json`. Drift fails CI.
- **Encryption**: tokens encrypted at rest with AES-256-GCM in Node runtime; key never touches Postgres. `packages/db/src/encryption.ts` is the single helper.
- **Format helpers**: currency / date / timestamp formatting lives in `packages/ui/src/lib/format.ts` (lands in Sprint 02.5). Never format inline.
- **Parallel review during build**: six specialist subagents in `.claude/agents/` can be dispatched in parallel after each implementation chunk to review work independently. See `.claude/agents/README.md` for which subagents to run per sprint type and how to dispatch them. The evaluator session (post-merge) and the subagents (during build) are both required — they are not substitutes for each other.

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
