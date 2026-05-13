# Sprint 01 — Design System + Clickable v1 UI (No Backend)

Date: 2026-05-13
Repo: lapsed-ai
Branch: `sprint-01/design-system`

## Scope

Implement the Vellum design system in code and produce a fully clickable v1 UI with zero backend. Every route listed in the `DESIGN-SYSTEM.md` page inventory must render with seed fixtures and be navigable end-to-end. Storybook is published with stories for every custom component. The Vercel preview deploy is reachable and a Playwright tour passes through every route.

This sprint touches no external services beyond Vercel and GitHub. It does not require any of the credentials in `PREREQUISITES.md` sections 3–9. It is designed to run autonomously without supervision.

The closed loop for Sprint 01 is "design system is implemented, all v1 screens exist as click-through prototypes, every component has a story, every route has a Playwright test."

## Acceptance Criteria

### Repo foundation

- [ ] Turborepo monorepo initialised at repo root with `pnpm` workspaces matching the package layout in `CLAUDE.md` (`apps/web`, `apps/marketing`, `apps/storybook`, `packages/ui`, `packages/core`, `packages/db`, `packages/shopify`, `packages/conversation`, `packages/sms`, `packages/billing`, `packages/fixtures`). Only `apps/web`, `apps/marketing`, `apps/storybook`, `packages/ui`, and `packages/fixtures` need real content this sprint; others are empty scaffolds.
- [ ] Next.js 16 App Router project in `apps/web` boots locally with `pnpm dev` on port 3000 with zero errors and zero warnings.
- [ ] Marketing site in `apps/marketing` boots on port 3001.
- [ ] Storybook in `apps/storybook` boots on port 6006.
- [ ] TypeScript configured `strict: true` across all packages with zero `any` introduced anywhere. Shared `tsconfig.base.json` at repo root.
- [ ] ESLint + Prettier configured with shared config in `packages/config`.
- [ ] CI/CD: GitHub Actions runs `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:e2e` on every PR. All green on the sprint branch.
- [ ] Vercel projects linked: `lapsed-web` deploys `apps/web`, `lapsed-marketing` deploys `apps/marketing`, `lapsed-storybook` deploys `apps/storybook`. Preview URLs in `HANDOFF.md`.

### Design tokens

- [ ] `packages/ui/src/tokens.css` exports every color, spacing, radius, and font token from `DESIGN-SYSTEM.md` as CSS custom properties, with names matching the spec exactly
- [ ] `packages/ui/tailwind.config.ts` exposes all tokens as Tailwind theme values (colors, fontFamily, fontSize with line-height + tracking + weight, borderRadius, spacing)
- [ ] Geist and Instrument Serif loaded via `next/font/google` in `apps/web` and `apps/marketing` root layouts
- [ ] Lucide React installed and a base `<Icon name="..." />` wrapper component exists in `packages/ui` with stroke-width 1.75 applied by default
- [ ] Storybook displays a "Foundations" section with stories for: Color palette, Typography scale, Spacing scale, Radius, Iconography. Each visualises the tokens.

### Component library

For every component in the `DESIGN-SYSTEM.md` shadcn mapping table and the custom composed components list, the following must be true:

- [ ] Component implemented in `packages/ui/src/components/<kebab-name>.tsx`
- [ ] Vellum overrides applied per the spec (no default shadcn styling visible)
- [ ] Storybook story exists at `packages/ui/src/components/<kebab-name>.stories.tsx` with at least one default story and stories for each variant or state listed in the spec
- [ ] Component is exported from `packages/ui/src/index.ts`
- [ ] No component uses any hardcoded color, font, or radius — all values come from tokens

Custom composed components specifically required (no shadcn equivalent):

- [ ] `<HeroMetric>` — label + serif numeral + meta line + mini chart slot
- [ ] `<MetricCard>` — label + value + trend
- [ ] `<CampaignRow>` — name/meta column, status badge, revenue column
- [ ] `<ConversationRow>` — avatar + name/time + preview + tag
- [ ] `<StatusDot>` — coloured dot + text in a pill, four variants (live, draft, paused, error)
- [ ] `<SidebarItem>` — icon + label + optional count + active state
- [ ] `<ShopSwitcher>` — sidebar footer card matching the mockup
- [ ] `<AppShell>` — sidebar + topbar + content layout matching the mockup

### Seed fixtures

- [ ] `packages/fixtures/src/` contains seed JSON for: one merchant (`Bondi Goods`, plan: growth), a list of 30 lapsed customers with varied scores, 4 campaigns (matching mockup data), 12 conversations across the four tag states, attribution data for the last 30 days
- [ ] Every fixture is typed (no `any`) using interfaces co-located with the fixture
- [ ] Fixtures are imported in routes via `import { merchant, lapsedCustomers, campaigns, conversations, attribution } from '@lapsed/fixtures'`

### Routes (every page from `DESIGN-SYSTEM.md` inventory)

Each route below must render with seed data and be navigable. No real fetch calls, no auth, no API routes. Routes use the seed fixtures directly.

- [ ] `/` — marketing landing (placeholder, hero + features + footer)
- [ ] `/app/auth/install` — pre-install Shopify install prompt (static, no real install action)
- [ ] `/app` — dashboard matching the mockup faithfully (use the HTML mockup as the reference)
- [ ] `/app/lapsed` — lapsed customers list with filter bar and table
- [ ] `/app/lapsed/[id]` — customer detail with profile, order history timeline, conversation history
- [ ] `/app/campaigns` — campaigns list
- [ ] `/app/campaigns/new` — 4-step wizard (audience → offer → message → review). Steps navigable but no real submission.
- [ ] `/app/campaigns/[id]` — campaign detail with performance header, conversation feed, audience breakdown
- [ ] `/app/conversations` — all conversations with filter
- [ ] `/app/conversations/[id]` — conversation thread view with customer sidebar and attribution panel
- [ ] `/app/attribution` — recovered revenue chart (use Recharts), breakdown by campaign, reconciliation status
- [ ] `/app/billing` — current plan card, usage meter, invoice history (seed), plan switcher
- [ ] `/app/settings` — shop info, brand voice, opt-out keywords, integrations placeholders
- [ ] `/app/onboarding` — 3-step onboarding flow (connect → cadence → first campaign)

### Playwright tour

- [ ] `apps/web/e2e/tour.spec.ts` navigates through every route above, asserts on a unique visible string per page, and captures a full-page screenshot into `_evidence/sprint-01/screenshots/`
- [ ] Tour passes locally and in CI
- [ ] Screenshots are committed (or stored as CI artifacts and linked in `HANDOFF.md`)

### Marketing site

- [ ] `/` renders the v1 landing page: hero ("Recover the customers you already paid for"), three-column features, call-to-action ("Install on Shopify"), footer
- [ ] Uses the same Vellum tokens — visual continuity between marketing and app

## Definition of Done

- [ ] All acceptance criteria above checked with evidence in HANDOFF.md
- [ ] `pnpm typecheck` passes with no errors and zero `any`
- [ ] `pnpm lint` passes with no warnings
- [ ] `pnpm test` passes (unit tests for any logic in `packages/ui`)
- [ ] `pnpm build` passes for all three apps
- [ ] `pnpm test:e2e` (Playwright tour) passes
- [ ] All three Vercel preview deploys reachable; URLs in HANDOFF.md
- [ ] Storybook preview deploy reachable; URL in HANDOFF.md
- [ ] Visual check: dashboard route matches `mockup-dashboard.html` faithfully (side-by-side screenshots in HANDOFF.md)
- [ ] HANDOFF.md committed
- [ ] Sprint branch merged to `main` via PR with green CI

## Quality Rubric

Score each 0–3. Anything below 3 needs remediation before closing the sprint.

- Every UI surface matches `DESIGN-SYSTEM.md` tokens (no hardcoded colors, fonts, radii) — [score]
- Every custom component has a Storybook story — [score]
- TypeScript: zero `any`, zero `@ts-ignore`, zero `@ts-expect-error` — [score]
- Playwright tour covers every route in the page inventory — [score]
- Dashboard route renders faithful to the HTML mockup (judged by side-by-side) — [score]
- Build, typecheck, lint, test, e2e all green in CI — [score]

Rubric criteria from `CLAUDE.md` that do not apply this sprint (no backend): 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 — mark N/A.

## Out of Scope

Explicitly NOT in this sprint. Do not build any of these.

- Any backend logic, any API routes, any server actions that touch external services
- Shopify OAuth (Sprint 02)
- Supabase schema or migrations (Sprint 02)
- Real data fetching — all data comes from `packages/fixtures`
- Real authentication — pages render as if a merchant is signed in, no auth gate
- Any webhook handlers
- Any LLM calls
- Any Twilio integration
- Any Stripe integration
- Mobile-optimised layouts below 1024px (acceptable to break, must not crash)
- Dark mode (post-v1)
- Internationalisation (post-v1)

## Self-verification commands

The Claude Code session should run these in order and paste output into HANDOFF.md:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
git diff --stat main..HEAD
```

If any command fails, do not declare done. Either fix it or stop and write HANDOFF.md recording the failure.

## Evaluator session prompt

Open a fresh Claude Code session pointed at this repo with this prompt:

```
You are a skeptical senior frontend engineer doing QA on Sprint 01 of lapsed.ai (design system + clickable v1 UI).
Your job is to find everything wrong, incomplete, or inconsistent. Do not approve anything unless you are
certain it meets the standard.

Specifically:
- Read CLAUDE.md, DESIGN-SYSTEM.md, SPRINT.md, HANDOFF.md in that order
- Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:e2e` and report exact output
- Verify every acceptance criterion against the actual code — do not trust HANDOFF.md claims
- Specifically check:
  * Open Storybook locally. Does every custom component in DESIGN-SYSTEM.md have a story? Does every shadcn override component have a story?
  * Open each route in apps/web. Does it render without console errors? Does it match the seed fixtures?
  * Grep the codebase for hardcoded color hex values outside packages/ui/src/tokens.css. Any found = violation.
  * Grep for `font-family` declarations outside tokens.css. Any found = violation.
  * Grep for `any` type and `@ts-ignore`. Any found = violation.
  * Compare /app dashboard route against mockup-dashboard.html. Any visual divergence = violation.
- Score each rubric criterion 0–3 with justification
- Report findings in a single message with a clear PASS or REMEDIATE verdict per criterion
- Do not suggest the sprint is complete unless every criterion scores 3
```

## Exact next action

Create the sprint branch (`git checkout -b sprint-01/design-system`) and initialise the monorepo: `pnpm init`, set up `pnpm-workspace.yaml`, create the package directories. Then scaffold the three apps in this order: `apps/web` (Next.js), `apps/storybook` (Storybook 8 React-Vite), `apps/marketing` (Next.js). Then build `packages/ui` starting with tokens.css and the Tailwind config. Then build components in this order: foundations (Button, Input, Card, Badge, Avatar, Icon), then composed (SidebarItem, ShopSwitcher, AppShell, StatusDot, MetricCard, HeroMetric, CampaignRow, ConversationRow). Then build the dashboard route as a faithful port of mockup-dashboard.html, using only the components you just built. Then the remaining routes in the page inventory.
