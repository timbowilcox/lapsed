# CLAUDE.md — lapsed.ai

This file is the harness initializer for the lapsed.ai codebase. Read it first in every session. It encodes the assumptions you operate under. Session-specific scope lives in `SPRINT.md`. Design tokens and component spec live in `DESIGN-SYSTEM.md`. One-time external setup is documented in `PREREQUISITES.md`.

## Project context

**lapsed.ai** is an AI-driven dormant customer recovery platform for Shopify ecommerce brands. The product identifies customers who have lapsed (using each merchant's actual purchase cadence, not a generic threshold), scores their reactivation probability, and runs two-way LLM-driven SMS conversations to win them back. Revenue is attributed cleanly back to the recovery campaign.

**It is NOT** a general SMS marketing platform, a Klaviyo replacement, or a campaign builder. Resist scope drift toward those surfaces — they are explicitly out of scope.

**ICP**: Shopify and Shopify Plus DTC brands, $2M–$50M revenue, repeat-purchase potential (CPG, beauty, supplements, apparel, pet, home goods).

**Pricing**: Three tiers ($299 / $799 / $1,999 per month) plus a 3% performance kicker on recovered revenue above tier baseline. v1 ships subscription only; kicker comes in v2.

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router) | Server actions + edge runtime where useful |
| Language | TypeScript (strict) | No JS files, no `any` |
| Database | Supabase (Postgres) | RLS enforced at API layer |
| Auth | Supabase Auth (staff) + Shopify OAuth (merchants) | Two distinct contexts, never conflated |
| Hosting | Vercel (`syd1` region) | Match other Tim ventures |
| Monorepo | Turborepo + pnpm | Match other Tim ventures |
| Styling | Tailwind + shadcn/ui, custom theme (`DESIGN-SYSTEM.md`) | No raw CSS files except globals |
| Fonts | Geist + Instrument Serif (Google Fonts) | Never Inter, Roboto, system-ui |
| Component dev | Storybook 8 | Every custom component has a story |
| SMS | Twilio | Telnyx as future fallback |
| Email (fallback) | Resend | Sprint 06 only |
| LLM | Anthropic API | `claude-sonnet-4-6` default, `claude-haiku-4-5-20251001` for batch scoring |
| Payments | Stripe | Subscriptions + metered usage |
| Background jobs | Supabase Edge Functions + `pg_cron` | No external queue in v1 |
| Testing | Vitest (unit), Playwright (integration + E2E) | See "Self-verification" |
| Observability | Vercel Analytics + Supabase logs | Sentry added post-v1 |

## Package layout

```
apps/
  web/           Next.js merchant dashboard + Shopify embedded app
  marketing/     Public site (lapsed.ai)
  storybook/     Component dev environment
packages/
  ui/            Vellum theme tokens, shared shadcn/ui components, custom composed components
  core/          Domain logic (scoring, cadence, attribution)
  db/            Supabase schema, migrations, generated types
  shopify/       Shopify API client + webhook handlers
  conversation/  LLM conversation engine + prompt library
  sms/           Twilio adapter + opt-out registry
  billing/       Stripe integration
  fixtures/      Seed data for design system mockups (committed JSON)
```

`packages/core` depends on `packages/db` only. `packages/ui` depends on nothing internal. Apps depend on packages. No circular deps.

## Auth model

Two distinct auth contexts that must not be conflated:

1. **Merchant auth** — Shopify OAuth into the embedded app. Session token from Shopify App Bridge. Used for all merchant dashboard actions.
2. **Internal staff auth** — Supabase Auth with magic link. Used for the admin panel only. Never exposed to merchants.

End customers (the lapsed shoppers receiving SMS) never authenticate. They are identified by phone number and email, scoped to a merchant.

## Shopify scopes

Two-tier scope structure declared in `shopify.app.toml`. Maintain this split deliberately.

**Required scopes** (blocking at install, kept minimal to maximise install conversion):
- `read_customers` — identify lapsed customers
- `read_orders` — compute each merchant's actual purchase cadence
- `read_products` — load the catalogue into LLM conversation context
- `write_discounts` — create discount codes for win-back offers
- `write_pixels` — Web Pixels API for attribution tracking on checkout

**Optional scopes** (declared now, requested dynamically when the feature first runs):
- `read_inventory` — stock-aware conversation responses
- `read_checkouts` — cart abandonment recovery (distinct feature, post-v1)
- `write_draft_orders` — pre-loaded checkout URLs with discount + cart populated
- `read_locations` — multi-warehouse merchants, ship-time awareness
- `read_price_rules` — read existing discount logic to avoid stacking

When a feature needs an optional scope, the implementation must:

1. Check `currentAppInstallation.accessScopes` via GraphQL first
2. If absent, trigger the dynamic OAuth dance to request it
3. Only proceed once the merchant has approved

**Never** promote an optional scope to required without explicit discussion — that change forces every existing merchant to re-authorise. Adding new optional scopes is free; adding new required scopes is expensive and visible.

## Data model conventions

- All tables have `id` (uuid), `created_at`, `updated_at`, `merchant_id` (where applicable)
- `merchant_id` is the tenancy boundary — every query filters by it
- RLS policies enforce merchant isolation; application code does not bypass RLS
- Soft delete via `deleted_at` — no hard deletes except for compliance (right-to-erasure)
- Use `pgcrypto` for any tokenisation (Stripe customer IDs, Shopify access tokens encrypted at rest)

## Naming conventions

- Tables: snake_case plural (`merchants`, `lapsed_customers`, `conversations`)
- Columns: snake_case
- TypeScript types: PascalCase, generated from Supabase schema (`Merchant`, `LapsedCustomer`)
- React components: PascalCase
- Files: kebab-case (`lapsed-customer-list.tsx`)
- Server actions: verb-noun (`create-campaign.ts`, `score-customer.ts`)
- Routes: `/app/(merchant)/...` for merchant-scoped, `/app/(admin)/...` for staff

## Design system

The aesthetic is codenamed **Vellum**: cream surfaces, lavender accent, ink black, a single Instrument Serif moment for hero numerals. The reference is `mockup-dashboard.html` in the repo root. The formal tokens, type scale, component mapping, and page inventory are in `DESIGN-SYSTEM.md`. Read it before writing any UI code.

Never deviate from the tokens. Never introduce new colors, fonts, or radii without updating `DESIGN-SYSTEM.md` first. If a UI need genuinely is not covered, stop and update the spec before building.

## What "done" means in this codebase

A feature is done when:

1. The acceptance criteria in `SPRINT.md` are checked with evidence in `HANDOFF.md` (test output, Playwright screenshots, curl results — auto-captured into the repo at `_evidence/sprint-XX/`)
2. TypeScript compiles with no errors and no `any` types added
3. Unit tests exist for domain logic in `packages/core` (Vitest)
4. Integration tests exist for any webhook handler (Shopify, Twilio, Stripe)
5. Playwright E2E test exists for any user-facing flow added in the sprint
6. RLS policies are tested with at least one cross-tenant access attempt
7. `HANDOFF.md` is committed
8. Code is committed and pushed; CI is green on the sprint branch
9. Vercel preview deploy succeeds and is reachable; URL is in `HANDOFF.md`

Premature completion is the most common failure mode. Do not declare done without running tests, building, and pasting output into `HANDOFF.md`.

## Self-verification rules (for autonomous sprints)

These rules let a Claude Code session verify its own work without Tim watching.

1. **At sprint start**, read `PREREQUISITES.md` and confirm `.env.local` has every variable populated. If any are blank, stop and surface them in `HANDOFF.md` — do not improvise values.
2. **For every UI change**, run a Playwright script that navigates to the affected route, asserts visible content matches the acceptance criterion, and captures a screenshot into `_evidence/sprint-XX/`. Embed the screenshot path in `HANDOFF.md`.
3. **For every API endpoint added**, write a Vitest integration test that exercises the happy path and at least one failure mode (auth failure, validation error, or signature mismatch). Run it and paste output.
4. **For every webhook**, write a signature-verification negative test (tampered payload rejected).
5. **For every RLS-protected table**, write a cross-tenant negative test.
6. **For every external service call** (Anthropic, Twilio, Stripe, Shopify), write a test that uses the service's test/sandbox mode end-to-end. Do not mock external services if a sandbox is available — use the sandbox.
7. **Sprint is not done** until `pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e` all pass locally and in CI.
8. **If a check fails**, fix the issue or stop and write `HANDOFF.md` honestly recording the failure. Do not silently skip tests, do not add `it.skip`, do not lower a threshold.

## Grading rubric (lapsed.ai-specific)

Score each criterion 0–3 in the evaluator session. Anything below 3 needs remediation.

| # | Criterion | Why it matters |
|---|---|---|
| 1 | Tenancy isolation tested with cross-merchant access attempt | A leak across merchants is existential |
| 2 | Shopify webhook idempotency verified | Shopify retries — duplicate orders break attribution |
| 3 | Twilio inbound webhook signature verified | Spoofed messages would corrupt conversations |
| 4 | Stripe webhook signature verified + idempotency key used | Billing errors compound silently |
| 5 | Opt-out registry consulted before every send | TCPA non-compliance is a legal risk |
| 6 | LLM conversation has guardrails (refunds, off-topic, escalation) | An LLM offering uncapped discounts is unacceptable |
| 7 | Attribution logic reconciles against Shopify order data | If the recovered revenue number is wrong, the product is worthless |
| 8 | No PII in logs (phone numbers, emails, names redacted) | GDPR + basic hygiene |
| 9 | All Anthropic API calls have timeout + retry | A hung conversation costs money and trust |
| 10 | TypeScript types generated from DB schema and used end-to-end | Drift between DB and code is a constant source of bugs |
| 11 | Every UI surface matches `DESIGN-SYSTEM.md` tokens | Design drift is irreversible debt |
| 12 | Every custom component has a Storybook story | Component reuse depends on discoverability |
| 13 | Optional scopes checked before use; never assumed granted | Dynamic scope grants are not guaranteed |

## v1 scope — what ships

v1 is the smallest fully closed loop. One merchant, one channel, one job, billed.

In scope for v1:
- Merchant installs via Shopify (dev install for design partners; App Store later)
- OAuth, embedded app, merchant dashboard
- Order + customer + product backfill (24 months) and ongoing webhook ingestion
- Per-merchant cadence calculation + lapsed classification
- Reactivation probability score (heuristic + LLM-assisted)
- Campaign creation flow (target segment, offer parameters, approval gate)
- SMS sending via Twilio
- Two-way LLM conversation engine with product catalogue context
- Opt-out handling (STOP, HELP, persistent registry)
- Checkout link generation with attribution tracking
- Revenue attribution reconciled against Shopify orders
- Merchant dashboard with all routes in the `DESIGN-SYSTEM.md` page inventory
- Stripe subscription billing (three tiers)

Out of scope for v1 (do not pull forward):
- Klaviyo integration
- Email channel as a campaign channel (Resend is for transactional notifications only)
- Multi-user / team accounts
- Performance kicker billing
- Shopify App Store public listing
- Compliance automation beyond opt-in/opt-out
- Aggregate cross-merchant scoring model
- WhatsApp, international, RCS
- Custom prompts per merchant beyond brand voice
- Postscript / Attentive co-existence
- Marketing site beyond the v1 landing page
- Cart abandonment recovery (uses `read_checkouts` optional scope; reserved for v2)

## Sprint sequence to v1

Design-first. Sprint 01 produces a fully clickable UI with seed data and zero backend, so the visual and interaction design is locked before any irreversible backend choices are made. Each subsequent sprint wires real data into existing UI.

Each sprint is one Claude Code session with `/clear` between them. Branch per sprint (`sprint-XX/short-name`), PR per sprint, merge to `main` only when CI is green.

| # | Sprint | Acceptance gate |
|---|---|---|
| 01 | **Design system + clickable v1 UI (no backend)** | Every route in the `DESIGN-SYSTEM.md` page inventory renders with seed fixtures; Storybook published; Playwright tour passes through all routes |
| 02 | Repo backend foundation + Shopify OAuth + merchant auth | Merchant can install dev app, complete OAuth, land on the Sprint 01 dashboard with their real shop domain in the topbar |
| 03 | Data ingestion (orders, customers, products, webhooks, 24-month backfill) | Dev store's 24 months of data in Supabase; Lapsed customers list shows real data; ongoing webhooks process |
| 04 | Scoring engine (cadence, lapsed classification, reactivation probability) | Lapsed customers list and Customer detail show real scores; campaign creation wizard pulls real audiences |
| 05 | Conversation engine (Twilio + LLM + opt-out) | Real SMS conversation from a campaign runs end-to-end against the verified Twilio trial recipient |
| 06 | Attribution + Stripe billing | Recovered revenue from a real test order shows in Attribution route; subscription billing live in test mode |

Post-v1 sprint backlog (do not pull forward):
- Klaviyo read/write integration
- Email channel
- Performance kicker billing
- Shopify App Store listing prep
- Aggregate scoring model
- Multi-user / team accounts
- Production Twilio 10DLC registration per merchant
- Cart abandonment recovery using `read_checkouts` optional scope
- Stock-aware conversations using `read_inventory` optional scope

## Failure modes encoded so far

This list grows as sessions fail. Read it before starting.

- *(none yet — first session)*

## Pointer

Read `PREREQUISITES.md` if external setup is incomplete.
Read `SPRINT.md` for the current sprint scope.
Read `DESIGN-SYSTEM.md` before any UI work.
