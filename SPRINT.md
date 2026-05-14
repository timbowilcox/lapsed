# Sprint 02.5 — UI Polish

Date: 2026-05-14
Repo: timbowilcox/lapsed
Branch: `sprint-02.5/ui-polish`
Estimated effort: 3–4 days, single PR

## Scope

A focused cosmetic + accessibility sprint sitting between Sprint 02 (OAuth) and Sprint 03 (data ingestion). Every issue surfaced in the post-Sprint-02 UI review of the six embedded app screens (Dashboard, Campaigns, Conversations, Attribution, Billing, Settings) is fixed here. No backend changes, no fixture-to-real-data sweep, no new features. Goal: when the user opens the app, the surfaces look finished. Goal is NOT: the surfaces are wired to real merchant data — that's Sprint 03.

Single PR against `main`. Squash merge after green CI + evaluator pass.

## In scope

### 1. Primary button contrast — currently invisible

`packages/ui/src/components/button.tsx` primary variant renders dark text on dark background everywhere except the install page (which got a one-off fix in PR #3). Swap the token for the primary variant globally.

- Primary variant: `bg-ink-900 text-cream-50` (not `text-ink-900`)
- Secondary variant: keep as-is (`bg-cream-100 text-ink-900 border border-ink-200`)
- Add a Storybook story per variant with the actual computed contrast ratio visible
- Add a unit test that mounts `<Button variant="primary">Test</Button>` and asserts `getComputedStyle` `color` matches the cream token

### 2. Topbar — broken layout + non-functional icons

Topbar component at `packages/ui/src/components/topbar.tsx` (or `apps/web/app/(app)/_components/topbar.tsx` — check current location). Fixes:

- **Height**: explicit `h-14` (56px). Icons should not exceed this.
- **Icon size**: 20px (`size-5`). Currently appears 24px+, spilling vertically.
- **Notification dot**: 8px (`size-2`), red-error token, positioned `absolute -top-0.5 -right-0.5` relative to the bell button (currently oversized and floating in negative space).
- **? button (help)**: opens `https://docs.lapsed.ai` in a new tab via `target="_blank" rel="noopener"`. The docs site doesn't exist yet — that's fine; it 404s gracefully. Placeholder is acceptable.
- **Bell button**: opens a Radix dropdown panel. Empty state for now: "No notifications yet" + small caption "We'll let you know when campaigns finish or customers reply." No badge / dot until Sprint 03 wires real events.
- **Avatar (TW) button**: opens dropdown menu with three items: "Account settings" (links to `/app/settings`), "Switch shop" (disabled with tooltip "Coming soon"), "Sign out" (clears session, redirects to Shopify Admin). Real sign-out flow.
- **Page title duplication**: drop the page title from the topbar. Keep only branding + actions in topbar. Page H1 lives in page content.

### 3. Unified chart component

Dashboard hero chart and Attribution chart currently use different implementations and rendering styles. Replace both with a single component.

- Create `packages/ui/src/components/revenue-chart.tsx` using Recharts `AreaChart`
- Smooth `monotone` curve, lavender gradient fill, no jagged steps
- X-axis: date labels with appropriate tick density for the date range
- Y-axis: currency-formatted (using new format helpers)
- Hover tooltip: shows date + currency value for that day
- Props: `data: Array<{ date: string; value: number }>`, `height?: number`, `range?: 'auto' | 'compact'`
- Storybook story showing both compact (Dashboard hero) and full (Attribution) variants
- Replace usages in `apps/web/app/(app)/dashboard/page.tsx` and `apps/web/app/(app)/attribution/page.tsx`

### 4. Format helpers — single source of truth

New module `packages/ui/src/lib/format.ts`:

- `formatCurrency(cents: number, opts?: { locale?: string; currency?: string }): string` — default `en-US` + `USD`, thousands separator, no decimals unless cents > 0
- `formatDate(input: string | Date, format: 'short' | 'long' | 'iso'): string` — `short` → "5 May 2026", `long` → "Tuesday, 5 May 2026", `iso` → "2026-05-05"
- `formatRelativeTime(input: string | Date): string` — "2m", "1h", "yesterday", "3d", "Mon 5 May" (anything older than 7 days renders as `short`)
- Unit tests for every branch in `packages/ui/src/lib/format.test.ts`

Sweep every surface in `apps/web/app/(app)/**` and replace inline formatting (`${value}`, `value.toLocaleString()`, etc.) with the helpers. CI should grep-fail if `toLocaleString` or hardcoded `$` interpolation appears outside `format.ts`.

### 5. Number typography — Instrument Serif for hero only

- New component `packages/ui/src/components/hero-metric.tsx`: large Instrument Serif numeral with a label above. Used only for the single largest metric per page (e.g., "Total recovered $47,283" on Dashboard, "Total recovered $47,283" on Attribution).
- Everything else (secondary metrics, table values, inline counts) uses Geist Sans with `font-variant-numeric: tabular-nums`.
- Update Dashboard, Attribution, Billing, Campaigns pages: identify the one hero metric, wrap in `<HeroMetric>`, everything else uses default body type.
- Document the rule in `DESIGN-SYSTEM.md` under "Typography".

### 6. Card padding audit

- Audit every card in `packages/ui/src/components/card.tsx` consumers
- Standardize on `p-6` for elevated cards, `p-4` for inline / list-item cards
- Fix the Billing "Usage this period" overflow (the visible clipping of the heading text)
- Card body should never abut card edge — minimum `pr-6` for content

### 7. Sidebar — counts policy + plan badge

- Counts shown only on data-bearing nav items where the count is meaningful: Lapsed, Campaigns, Conversations
- No counts on: Dashboard, Attribution, Billing, Settings
- Document the rule as a code comment in the sidebar component
- Remove the "Lapsed Test / Starter · 5k msgs" plan badge from the Conversations page sidebar. Sprint 03 will reintroduce it as a global sidebar footer once real plan data is wired.

### 8. Accessibility

- Visible focus ring on every interactive element: `focus-visible:ring-2 ring-lavender-500 ring-offset-2 ring-offset-cream-50`
- `aria-label` on every icon-only button (help, bell, avatar)
- Skip-to-content link at the top of `apps/web/app/(app)/layout.tsx`, visible on focus only
- Run `pnpm test:a11y` (axe-core integration) as part of CI for the six app routes. No serious or critical violations allowed; moderate violations get a tracked issue.

### 9. Tests

- Storybook stories updated / added for: Button (all variants with contrast assertions), HeroMetric, RevenueChart (compact + full), Topbar (with all three dropdowns open), Card (all padding variants)
- New Playwright e2e in `apps/web/e2e/topbar.spec.ts`: opens each topbar dropdown, asserts contents, asserts keyboard navigation works
- Visual regression diff via Playwright `toHaveScreenshot` for Dashboard, Billing, Attribution, Conversations — baseline screenshots updated and committed
- `pnpm test` includes new format helper unit tests
- a11y scan via `@axe-core/playwright` for the six app routes

## Out of scope (do not touch — these are later sprints)

- **Settings page fixture leak** (`bondi-goods.myshopify.com` showing instead of real shop) — Sprint 03 (data wiring)
- **Empty states** for any screen — Sprint 03
- **Loading skeletons / error states** for fetch boundaries — Sprint 03
- **Onboarding flow refresh** — Sprint 05
- **Brand voice character count + AI suggestion** — Sprint 05
- **Email as channel** — post-v1 backlog
- **Mobile responsive pass** — post-v1 backlog
- **Cmd+K global search** — post-v1 backlog
- **Dark mode** — post-v1 backlog
- Any change to API routes, server actions, database schema, Shopify webhooks, encryption, or auth flow
- Real plan data in sidebar footer (deferred to Sprint 03)
- Real notification feed in bell dropdown (deferred to Sprint 03)

## Acceptance criteria

Every box must be checked with evidence in the PR description (screenshot, test output, or file path).

- [ ] Primary button text is cream on ink (not ink on ink) across all six app routes — screenshot of each
- [ ] Topbar height is 56px exactly — DOM inspector screenshot
- [ ] Topbar icons are 20px — DOM inspector screenshot
- [ ] Notification dot is 8px, positioned top-right of bell, not floating outside — screenshot
- [ ] ? button opens new tab to `https://docs.lapsed.ai` — e2e test
- [ ] Bell button opens dropdown with empty-state copy — e2e test + screenshot
- [ ] Avatar button opens dropdown with Account / Switch shop (disabled) / Sign out — e2e test + screenshot
- [ ] Sign out clears session and redirects appropriately — e2e test
- [ ] Page title appears only as H1 in page content, never in topbar — screenshot of every route
- [ ] Single `<RevenueChart>` component used in both Dashboard hero and Attribution — file diff
- [ ] Chart renders smooth curve (no stair-step), with axes and hover tooltip — screenshot
- [ ] `formatCurrency`, `formatDate`, `formatRelativeTime` exist in `packages/ui/src/lib/format.ts` with full unit test coverage — test output
- [ ] No inline currency / date / timestamp formatting remains in `apps/web/app/(app)/**` — grep output proving zero matches
- [ ] `<HeroMetric>` component exists and is used exactly once per page (the largest single metric) — file diff
- [ ] All non-hero numbers render in Geist tabular — visual verification
- [ ] Billing "Usage this period" card no longer clips heading text — screenshot
- [ ] All elevated cards have consistent padding — visual review
- [ ] Sidebar counts present only on Lapsed, Campaigns, Conversations — screenshot
- [ ] Plan badge removed from Conversations sidebar — screenshot
- [ ] Every interactive element has a visible focus ring when tabbed to — keyboard nav video or screenshot sequence
- [ ] Every icon-only button has `aria-label` — code search proving 100% coverage
- [ ] Skip-to-content link present and works — keyboard nav test
- [ ] `pnpm test:a11y` reports zero serious/critical violations on all six routes — test output
- [ ] Visual regression baselines committed for Dashboard, Billing, Attribution, Conversations — file diff
- [ ] Storybook updated with new and changed stories — screenshot of Storybook nav

## Definition of done

- [ ] All acceptance criteria above checked with evidence in the PR description
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` all passing
- [ ] `pnpm build` exits 0 for all three apps
- [ ] `pnpm test:e2e` all passing including new topbar.spec.ts
- [ ] `pnpm test:a11y` zero serious/critical violations
- [ ] `pnpm grep:pii` clean
- [ ] `pnpm vercel:env:check` clean (no env changes expected this sprint)
- [ ] No new dependencies added without justification in PR description
- [ ] No hardcoded colors / fonts / radii outside `packages/ui` — verified by grep
- [ ] HANDOFF.md committed at sprint end with rubric scores
- [ ] PR opened, evaluator session run, every rubric criterion scored 3, then squash-merged to main

## Quality rubric for this sprint

Scored 0–3 by the evaluator session. All must score 3 before merge.

1. **Token discipline** — Every visual change uses Vellum tokens; no hardcoded values
2. **Format helpers used everywhere** — Zero inline currency / date / timestamp formatting in `apps/web/app/(app)/**`
3. **Chart unification** — Both Dashboard and Attribution use the same component; no two implementations
4. **Accessibility** — Focus rings visible, aria-labels present, skip-to-content works, axe scan clean
5. **Storybook coverage** — Every new or changed component has a story
6. **Test coverage** — Format helpers have unit tests for every branch; topbar interactions have e2e tests
7. **Visual regression** — Baselines committed; diffs reviewed; no unintended changes
8. **Scope discipline** — Nothing from "Out of scope" was touched. No data wiring, no backend, no Sprint 03 work.
9. **PR hygiene** — Conventional commits, clean diff, no unrelated changes, no console.log left behind
10. **No regressions** — All existing tests still pass; no new TypeScript errors

## Evaluator session prompt

After implementation, open a fresh Claude Code session with this exact prompt:

```
You are a skeptical senior engineer doing QA on Sprint 02.5 (UI Polish) of lapsed.ai. Your job is to find everything wrong, incomplete, or inconsistent. Do not approve anything unless you are certain it meets the standard.

Read in order: CLAUDE.md, DESIGN-SYSTEM.md, SPRINT.md, HANDOFF.md.

Then run and report exact output:
- pnpm typecheck
- pnpm lint
- pnpm test
- pnpm build
- pnpm test:e2e
- pnpm test:a11y
- pnpm grep:pii
- pnpm vercel:env:check
- git diff main --stat (to see scope of changes)
- grep -rE "\\.toLocaleString\\(|\\$\\{.*\\.toFixed" apps/web/app (to verify format helpers are used)

Then verify EVERY acceptance criterion in SPRINT.md against actual code — do not trust HANDOFF.md claims. Open the relevant files, check the actual implementation, and confirm.

Score each of the 10 rubric criteria 0-3 with justification. Pay special attention to:
- Did the sprint touch anything in "Out of scope"? (Especially: no data wiring, no backend, no empty states, no onboarding changes.)
- Are the format helpers actually used everywhere, or just defined and partially adopted?
- Does the chart unification mean one component, or two components that look similar?
- Are aria-labels real and descriptive, or copy-pasted "button"?

Report PASS or REMEDIATE per criterion. If any criterion is below 3, list the exact files and lines that need fixing. Do not suggest the sprint is complete unless every criterion scores 3.
```

## Exact next action

Open Claude Code in worktree mode pointed at `C:\dev\lapsed`, create branch `sprint-02.5/ui-polish`, and start with criterion 1 (primary button contrast fix in `packages/ui/src/components/button.tsx`) since it's the smallest change, has the highest visual impact, and unblocks visual regression baseline capture for the rest of the sprint.

Suggested chunking, in order:

1. Button contrast fix + Storybook story + unit test → commit
2. Format helpers module + unit tests → commit
3. Sweep inline formatting in app routes to use helpers → commit
4. HeroMetric component + sweep pages → commit
5. RevenueChart component + replace Dashboard + Attribution usages → commit
6. Topbar height + icon + dot fixes → commit
7. Topbar dropdown wiring (?, bell, avatar) + e2e tests → commit
8. Card padding audit + Billing fix → commit
9. Sidebar counts + plan badge cleanup → commit
10. Focus rings + aria-labels + skip-to-content + a11y test pass → commit
11. Visual regression baselines + final sweep → commit
12. HANDOFF.md → commit, open PR
