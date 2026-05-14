# CLAUDE.md — Build initializer for lapsed.ai

> This file is the first thing every Claude Code session reads. It defines the stack, the conventions, the sprint sequence, and the failure modes encoded from past work. For the **what is this product** questions — positioning, agent operating model, module specs, design philosophy — read **PRODUCT.md** alongside this file. CLAUDE.md is the build initializer; PRODUCT.md is the product initializer. Both should be read before starting any sprint.

## What lapsed.ai is

**Lapsed customer win-back on autopilot.** An AI agent that runs the dormant-customer recovery program for Shopify DTC merchants. Identifies who's lapsed, plans the engagement, runs two-way SMS conversations, attributes recovered revenue conservatively against Shopify orders, and reports honest outcomes weekly. Performance-priced — the merchant pays a percentage of incrementally recovered revenue, validated by randomised holdout control groups.

ICP: Shopify DTC merchants doing $5M–$30M in annual revenue. Positioning: the AI win-back specialist. Differentiation: agent-operator paradigm (not a workflow builder), longitudinal customer memory, conversation-thread attribution with holdouts. See PRODUCT.md for the full positioning and moat thesis.

## Stack (pinned)

- **Framework**: Next.js 15.1 (App Router) — pinned; Next 16 GA migration is its own post-v1 sprint
- **Database**: Supabase Postgres (project `lapsed`, region `ap-southeast-2` Sydney, ref `vuyjtkpubxadudahzrlh`)
- **Vector search**: pgvector for conversation memory and semantic retrieval over customer history
- **Hosting**: Vercel, region `syd1`, three projects: `lapsed-web`, `lapsed-marketing`, `lapsed-storybook`
- **Monorepo**: Turborepo + pnpm v10.13.1, workspaces under `apps/*` and `packages/*`
- **Language**: TypeScript strict, zero `any`, zero `@ts-ignore`/`@ts-expect-error`
- **Linting**: ESLint 8 — pinned; ESLint 9 flat config migration ships alongside Next 16
- **Auth (merchant ↔ app)**: Shopify OAuth + App Bridge session tokens (JWT)
- **Encryption at rest**: AES-256-GCM with key in `TOKEN_ENCRYPTION_KEY` env var (key never reaches Postgres)
- **SMS**: Twilio (toll-free `+18888800461`, sandbox + test recipient `+61408768484`)
- **Conversation LLM**: Anthropic `claude-sonnet-4-6`
- **Scoring / summarisation LLM**: Anthropic `claude-haiku-4-5-20251001` (batch-friendly, cost-effective)
- **Billing**: Stripe (sandbox until v1 cutover)
- **Email (transactional only)**: Resend, domain `lapsed.ai` verified in Tokyo region. Email-as-a-channel for merchant customers is post-v1.

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

## Sprint sequence to v1 (SMS-only, agent-operator paradigm)

Each sprint ships with: `SPRINT.md` for scope and acceptance criteria, an adversarial evaluator session post-implementation, and `HANDOFF.md` at the end. The sprint branch merges via PR with green CI before the next sprint starts. The harness pattern is non-negotiable — see "Conventions for evaluator sessions" below.

- **Sprint 01** ✅ Design system + clickable v1 UI with seed fixtures (merged)
- **Sprint 02** ✅ Repo backend foundation + Shopify OAuth + merchant auth + encrypted tokens (merged, with PRs #3–6 covering App Bridge loading, host-decode, root-embedded entry, OAuth iframe cookies, Turborepo env passthrough)
- **Sprint 02.5** ← UI Polish (cosmetic + a11y + format helpers + topbar wiring). The current sprint.
- **Sprint 03** Data ingestion (webhooks + Shopify backfill) + customer memory graph foundation (event-sourced, pgvector retrofitted from the start) + fixture-to-real-data sweep + empty/loading/error states across every screen
- **Sprint 04** Customer intelligence layer — reactivation propensity scoring (Haiku batch), LTV estimation, lapsed classification, group auto-detection (agent identifies natural groups without explicit rules)
- **Sprint 05** Agent identity + brand voice — storefront analysis on install, brand voice profile synthesis, knowledge base, agent persona configuration. Onboarding-as-hiring (3-minute install to operational)
- **Sprint 06** Campaign designer module + merchant approval surface — weekly planning loop, hypothesis-level multi-armed bandit state, proposal generation, weekly Monday briefing email, approval queue UI
- **Sprint 07** Conversation engine — channel-agnostic core, SMS (Twilio) as first implementation, multi-turn memory retrieval via pgvector, opt-out registry, TCPA quiet hours, escalation rules to human (Gorgias), tool use mid-conversation (inventory, discount codes, order lookup)
- **Sprint 08** Attribution + outcomes — conversation-thread attribution rules, randomised holdout control groups (10% per group), LTV restoration tracking, statistical confidence intervals, cohort-level outcome reporting
- **Sprint 09** Stripe billing + performance pricing infrastructure — incremental-revenue-based billing math, holdout-validated invoicing, usage metering, merchant-visible audit trail
- **v1.0 launch**

## Post-v1 backlog (deferred — NOT in scope until v1.0 ships)

Do not pull these forward into earlier sprints without an explicit decision recorded here.

- **Voice channel escalation** (Scale tier only) — Vapi or Retell or Bland AI for voice transport, ElevenLabs or built-in voices for synthesis, latency budget under 800ms response. Positioned as escalation for high-LTV VIP customers, not primary channel.
- **Email channel** — parallel to SMS as a campaign output. Substantial scope — Resend integration as outbound sender, separate compliance (List-Unsubscribe, GDPR), send-time logic, deliverability tracking, inbound bounce handling.
- **AI Email Designer agent** — storefront crawler + design token extraction + MJML / React Email template generation matching merchant aesthetic. Depends on Email channel sprint.
- **Cross-merchant intelligence activation** — only viable after ~20 paying merchants generating outcome data. Pattern library surfaces as pre-loaded craft in onboarding, never customer-facing as a feature.
- **Mobile responsive pass** — primary use should already be mobile-first (most merchants check on phone); this sprint is the desktop secondary view polish.
- **Multi-store / team management** — multiple users per merchant with role-based access; one merchant managing multiple Shopify stores.
- **Next 16 + ESLint 9 migration** — coordinated upgrade once Next 16 is GA and `eslint-config-next` supports flat config.
- **Webhook handlers for GDPR mandatory topics** (`customers/data_request`, `customers/redact`, `shop/redact`) — required for App Store listing but not for private install testing.
- **Recharge integration** — subscription churn win-back logic differs from one-time buyer win-back.
- **Dark mode**, **Cmd+K palette** — defer.

## Quality rubric (12 criteria, scored 0–3 per sprint)

Each sprint that touches a relevant area scores against these. Anything below 3 needs remediation before sprint close.

1. Tenancy isolation tested with cross-merchant access attempt
2. Shopify HMAC signature verified on every callback + webhook
3. Twilio inbound webhook signature verified
4. Stripe webhook signature + idempotency key handling
5. Opt-out registry consulted before every send
6. LLM conversation guardrails (system prompt, refusal patterns, max-turn limits, no PII leakage, brand-voice compliance check before send)
7. Attribution conservatively reconciles against Shopify orders — conversation-thread rule, 7-day window, no overcounting
8. No PII (shop_domain, tokens, customer phone, order details) in logs — verified by `pnpm grep:pii`
9. Anthropic + Twilio API calls have timeout + retry policy with exponential backoff
10. DB-generated TypeScript types end-to-end (Supabase `gen types` consumed by all packages)
11. UI surfaces use Vellum tokens — no hardcoded colors / fonts / radii outside `packages/ui`
12. Optional Shopify scopes declared in `shopify.app.toml` but requested dynamically only when features need them (not at install)

## Conventions

- **Sprint branches**: `sprint-NN/<short-name>` or `fix/<short-name>` for hotfixes
- **Commits**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- **PRs**: opened against `main`, squash-merged after green CI
- **Two PRs per sprint**: one for the spec change (CLAUDE.md/PRODUCT.md/SPRINT.md updates), then a separate one for the implementation. Keeps audit trail clean.
- **Worktree mode**: prefer Claude Code's worktree mode for sprint work so the main checkout stays clean
- **Env vars**: every server-side var read by `apps/web` MUST be declared in `turbo.json`'s `tasks["@lapsed/web#build"].env` array. The `pnpm vercel:env:check` script enforces parity between `EXPECTED_ALL`, Vercel project env, and `turbo.json`. Drift fails CI.
- **Encryption**: tokens encrypted at rest with AES-256-GCM in Node runtime; key never touches Postgres. `packages/db/src/encryption.ts` is the single helper.
- **Format helpers**: currency / date / timestamp formatting lives in `packages/ui/src/lib/format.ts` (lands in Sprint 02.5). Never format inline.
- **Vocabulary**: use **"group"** as the standard term for collections of customers. Not "cohort" (academic) and not "segment" (overloaded with Klaviyo/Shopify meaning). Reserved exception: "segment" can be used when explicitly mapping to Shopify or Klaviyo segment APIs.
- **Agent reference**: refer to the agent functionally ("the agent", "lapsed.ai") in the operator-facing UI. Do not give the agent a personal name. See PRODUCT.md design tenet 8.

## Parallel review during build

Specialist subagents live in `.claude/agents/` and run in parallel during build chunks to catch issues fast. See `.claude/agents/README.md` for the full dispatch pattern. Summary:

- **After every implementation chunk**, dispatch the relevant specialists in parallel
- **UI sprints** (e.g., Sprint 02.5): code-reviewer, design-tenet-auditor, vocabulary-auditor, accessibility-auditor
- **Backend / data sprints** (Sprint 03, 04, 08): architecture-guardian, code-reviewer, test-coverage-analyzer
- **Conversation / agent sprints** (Sprint 06, 07): all six
- **Billing sprint** (Sprint 09): architecture-guardian (mandatory), code-reviewer, test-coverage-analyzer

Any Critical or High finding from a specialist blocks the chunk from being committed until resolved. Any architecture violation from architecture-guardian blocks merge with no exception — load-bearing decisions don't get deferred.

These specialists do not replace the evaluator session pattern below. The evaluator runs against the merged sprint code as the final gate. Both layers stay.

## Architectural load-bearing decisions

These are the design choices that are expensive to revisit later. They get locked in early sprints and treated as constraints, not preferences, for the rest of v1.

- **Event-sourced customer memory graph from Sprint 03.** Don't store snapshots; store events with timestamp + source. Materialised customer profile is regenerated nightly from the event log.
- **pgvector for conversation memory in Sprint 03.** Not Sprint 07. Retrofitting semantic search is painful, and the schema decisions ripple through the conversation engine.
- **Channel-agnostic conversation engine in Sprint 07.** Even though v1 ships SMS only, the engine should accept channel as a parameter so voice plugs in cleanly in v2 without rework.
- **Bandit state as a first-class data structure in Sprint 06.** Not a future enhancement. The agent's planning loop reads from and writes to bandit state on every cycle.
- **Holdout control groups baked into every group engagement from Sprint 08.** 10% randomised holdout per group, per campaign. Cannot add later without breaking the entire attribution and pricing story.
- **Performance pricing on incremental revenue, not gross.** The billing math reads `attributed revenue × incrementality factor`. Build this correctly from Sprint 09 — retrofitting "we used to bill differently" creates trust damage.

## Failure modes encoded so far

Each entry is a real bug we hit. Future sessions should read these before going near the relevant code.

- **Next 16 was not GA at install time**; pinned to `^15.1`. ESLint 9 flat-config isn't fully supported by Next 15's `next lint`; pinned to `^8`. Both unlock in a coordinated migration sprint post-v1.
- **App Bridge script loading**: React 19 / Next 15's `<Script strategy="beforeInteractive">` silently rewrites the tag with `async=""`, which Shopify rejects. Fix: use a literal `<script>` JSX element inside a real `<head>` element in `apps/web/app/layout.tsx`, never Next's `<Script>` component for App Bridge.
- **App Bridge requires shop config field**: when Shopify Admin loads the embedded app via the sidebar, it passes `?host=` and `?shop=` to the root path (`/`), not to `/app/auth/install`. Don't blindly redirect from `/` — read params first, validate HMAC, route accordingly. See `apps/web/app/lib/root-redirect.ts`.
- **Next.js `redirect()` strips query strings**. Sprint 02 had three redirect hops that lost `?shop=`/`?host=` before they reached the install detection logic. Always preserve search params explicitly when redirecting between auth-context routes.
- **State cookie for OAuth must work in iframe context**: Chrome blocks third-party cookies (`SameSite=Lax`) on iframe-set cookies. Set state cookies with `SameSite=None; Secure; Partitioned`. Defense in depth: root entry also does `window.top.location.href` to break out of iframe before hitting `/api/shopify/install`.
- **Turborepo strips env vars not declared in `turbo.json`**. Even when set on Vercel, server-side vars are filtered from the build environment unless listed in `tasks["@lapsed/web#build"].env`. Manifested as cookie / state / OAuth errors. The `vercel:env:check` script asserts parity with `turbo.json` to catch drift.
- **Supabase CLI link bug**: `supabase link` returns 403 "necessary privileges" for org owners on the new key system. Workaround: use `psql "$SUPABASE_DB_URL"` directly for migrations. The Supabase Vault extension was unreliable on the new key system; we use AES-GCM in Node runtime instead.
- **Supabase publishable key format**: must be `sb_publishable_...` (not legacy `eyJ...` JWT). Required by the new key system. JWT signing for per-merchant RLS uses `SUPABASE_JWT_SECRET` from project settings.
- **Move-Item drops dotfiles**: PowerShell's `Move-Item` sometimes fails to move hidden directories (`.git`, `.gitignore`). After any directory move, verify `git status` works before continuing.
- **pnpm global bin dir**: `pnpm setup` must run before `pnpm add -g <pkg>` works on a fresh Windows machine. Adds `PNPM_HOME` to user PATH; restart shell after.
- **Shopify CLI commands changed**: `shopify app config push` was removed in 3.x. Use `shopify app deploy` instead. The CLI also moved authentication to the Shopify Dev Dashboard at `dev.shopify.com`, not `partners.shopify.com`.
- **Vercel monorepo Root Directory**: must be set explicitly per app project (`apps/web`, `apps/marketing`, `apps/storybook`) with "Include source files outside of the Root Directory" enabled so workspace packages resolve.

## Conventions for evaluator sessions

After each sprint, open a separate Claude Code session pointed at the same repo with this prompt template:

```
You are a skeptical senior engineer doing QA on Sprint NN of lapsed.ai (<sprint scope>). Your job is to find everything wrong, incomplete, or inconsistent. Do not approve anything unless you are certain it meets the standard.

Read in order: CLAUDE.md, PRODUCT.md, DESIGN-SYSTEM.md, SPRINT.md, HANDOFF.md.

Then run and report exact output:
- pnpm typecheck
- pnpm lint
- pnpm test
- pnpm build
- pnpm test:e2e
- pnpm test:a11y (where applicable)
- pnpm grep:pii
- pnpm vercel:env:check

Verify every acceptance criterion in SPRINT.md against actual code — do not trust HANDOFF.md claims. Open the relevant files, check the actual implementation.

Score each rubric criterion 0-3 with justification. Pay special attention to:
- Did the sprint touch anything in "Out of scope"?
- Are architectural load-bearing decisions respected (event-sourced memory, channel-agnostic engine, bandit as first-class, holdouts on every group, incremental-revenue billing)?
- Are the design tenets from PRODUCT.md respected on any UI changes?

Report PASS or REMEDIATE per criterion. Do not suggest the sprint is complete unless every criterion scores 3.
```

Treat the evaluator's verdict as binding. Don't merge until every criterion scores 3.
