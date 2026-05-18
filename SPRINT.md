# SPRINT-11.md — UX Coherence, Premium-Feel Core, Onboarding Polish

**Sprint:** 11
**Theme:** Turn a working product into one that exudes ultra-quality at the $299-$1,499/month price point.
**Predecessor:** Sprint 09 (cohort symmetric-ITT + flat Stripe subscription billing). Sprint 10 (usage metering) is paused pending Sprint 11.
**Source of truth:** `WALKTHROUGH-FINDINGS.md` is REQUIRED READING for every chunk. Every CRITICAL and HIGH finding from that doc must be resolved by this sprint.
**Chunks:** 13
**New architectural decisions:** 34, 35, 36 (added to CLAUDE.md; see `CLAUDE-md-additions-sprint-11.md`)
**Mid-sprint checkpoint:** After chunk 6 (foundation verified before strategic work begins). Earlier than standard chunk-7 position because chunks 1-6 are foundational sweeps and chunks 7-12 build on them.

---

## What this sprint delivers

By the end of Sprint 11, lapsed.ai feels like a premium SaaS product. A prospect can preview the dashboard at lapsed.ai/preview without installing. A new merchant onboards through a guided first-run experience. The dashboard tells them what happened, what's at risk, what to do next, and what's coming. Suggested campaigns surface AI-derived recommendations the merchant can launch in one click. Every contrast issue, every microcopy leak, every hydration race, every dead affordance from the walkthrough is gone. The product still works the same — but it now feels worth what it costs.

## Out of scope

- **Sprint 10's usage metering** — paused, resumes after Sprint 11 ships
- **User management / roles** — Sprint 12+
- **Operator dashboard (Tim-facing all-merchants view)** — Sprint 12
- **Per-merchant Twilio numbers** — Sprint 12
- **Sentry monitoring** — Sprint 12
- **Marketing site full rebuild** — Sprint 12 or separate effort (Sprint 11 only fixes specific findings from the walkthrough, not a rebuild)
- **Production Stripe key switchover** — MVP launch
- **Benchmarks vs other merchants** — v2 (needs critical mass for anonymization)
- **Reports / PDF / CSV exports** — Sprint 12
- **Email notifications on payment events** — v2
- **Refund workflow UI, coupons, free trials** — v2
- **Dark mode, keyboard shortcuts, global search** — v2

## New architectural decisions (CLAUDE.md additions)

These are added to CLAUDE.md during the harness chore commit before kickoff. See `CLAUDE-md-additions-sprint-11.md` for the verbatim insertions and the `architecture-guardian.md` updates.

- **Decision 34 — Demo mode pattern.** Demo mode renders the merchant dashboard against a fixture dataset (`packages/core/src/demo-fixtures/`), not against live DB. Demo routes live at the public path `/preview` (both `lapsed.ai/preview` marketing entry and `app.lapsed.ai/preview` direct). No demo data ever bleeds into live merchant pages — empty states everywhere instead. Demo fixtures are versioned alongside the math.
- **Decision 35 — Vocabulary audit in CI.** User-facing strings never contain internal terminology (sprint names, code identifiers, internal table names, hex-encoded values). A new `pnpm grep:vocab` CI gate enforces this with a deny-list (`sprint`, `chunk`, `posterior`, `arm_id`, `merchant_id`, `attribution_results`, etc.). Placeholder copy uses confident future-tense when explaining latency or pending state.
- **Decision 36 — Recommendations engine is deterministic.** The AI Insights/Recommendations layer (`packages/core/src/insights-engine.ts`) derives recommendations from existing DB signals (RFM scores, cohort sizes, bandit posteriors, opt-out trends, send-rate, attribution windows). No new ML models, no LLM calls for recommendation generation. Every recommendation has: an `id`, a `priority` (HIGH/MEDIUM/LOW), a `category` (cohort/arm/opt-out/conversation/payment), a `signal` (the numeric trigger), a `merchant_copy` (rendered text), and a `cta_action` (route + params).

## The chunks

### Chunk 1 — Demo mode foundation

**Why first:** Unblocks two things — prospects can preview the product, and Tim can walk through populated screens mid-sprint to find more findings before the strategic chunks land.

**Scope:**
- Create `packages/core/src/demo-fixtures/` with: 1 demo merchant, ~120 demo customers across recency cohorts (30/60/90/180-day dormant, VIP at-risk), 3 demo campaigns (1 live, 1 paused, 1 completed), ~40 demo conversations across sentiment buckets, ~30 days of demo attribution results with realistic CIs.
- Create route handlers at `/preview` (public, no auth) that render the merchant app shell with demo data. Reuse existing dashboard / lapsed-customers / campaigns / conversations / attribution / settings page components — switched to demo data source via a `useDemoData()` hook.
- Banner across every demo page: "This is a demo. [Install lapsed on your Shopify store →]" — links to install with sticky source attribution.
- Add `/preview` to marketing site primary CTA (replace "Preview the dashboard" link target from `/app` to `/preview`).
- Demo fixtures rendered through the same UI components as live data — when chunk 10 (dashboard reframe) lands, demo mode automatically picks up the new layout.

**Acceptance criteria:**
- `/preview` route public, no auth, no cookie required
- Demo dashboard renders within 1.5s LCP
- Every nav item (Dashboard, Lapsed customers, Campaigns, Conversations, Attribution, Billing, Settings) renders with demo data
- "This is a demo" banner present on every demo page, dismissible per session only
- Marketing site `Preview the dashboard` CTA points to `/preview`, NOT to install
- Demo data does NOT appear on any authenticated merchant route (sidebar badge counts, dashboard cards, etc.) — verified by spec-adherence-auditor cross-checking `useDemoData()` is never reachable in `/app` paths
- Demo fixtures versioned in `demo-fixtures/v1.json` so future Sprint 12 changes don't silently break preview

**Walkthrough findings resolved:** Install page CRITICAL (no preview path), Marketing site MEDIUM (CTA misleading)

---

### Chunk 2 — Microcopy + vocabulary sweep

**Why second:** Touches every file. Doing it early prevents later chunks from re-introducing regressions.

**Scope:**
- Audit every user-facing string across `apps/web/app/`, `apps/marketing/app/`, and shared UI in `packages/ui/`
- Replace internal terminology with merchant-facing copy:
  - "Attribution in Sprint 08" → "Available after 30 days of campaign activity"
  - "Pending — connects in Sprint 05" → "SMS sending activates with your first campaign"
  - "Pending first score · 0 total lapsed" → "Your first scoring run completes within 24 hours of installing. Dormant cohorts will appear here after that."
  - All other instances of "Sprint NN", "Chunk N", placeholder "—" copy
- Establish premium tone-of-voice guidelines in `DESIGN-SYSTEM.md`:
  - Confident future-tense for pending state ("Your first scoring run completes within 24 hours" NOT "Pending first score")
  - Concrete subjects ("the agent drafts a campaign" NOT "campaigns are drafted")
  - When/then structure for empty states ("Figures appear here once X has happened" NOT just "No figures yet")
  - Merchant-second-person ("Your top campaign" NOT "The top campaign")
- Add `pnpm grep:vocab` CI gate (decision 35). Deny-list includes: `sprint \d`, `chunk \d`, `posterior`, `arm_id`, `merchant_id`, `attribution_results`, `bandit_state`, `\bRFM\b` (in user paths only), `cohort` (in user paths only — internal use OK), `holdout` (in user paths only).
- Apply premium guidelines to every empty state, error message, button label, tooltip, placeholder, and helper text

**Acceptance criteria:**
- `pnpm grep:vocab` exits 0 across the entire repo's user-facing paths
- `DESIGN-SYSTEM.md` has a "Voice & tone" section with the four guidelines + examples
- Every CRITICAL/HIGH microcopy finding from walkthrough resolved (Sprint 08 leak, Sprint 05 leak, all internal vocab)
- Premium tone applied consistently — verified by vocabulary-auditor sampling 20 randomly-chosen user strings
- No regression in existing positive copy (the Lapsed customers empty state, the Stripe trust line, the Campaigns "Nothing is sent until you approve" subtitle)

**Walkthrough findings resolved:** Dashboard CRITICAL (Sprint 08 leak), Settings MEDIUM (Sprint 05 leak), Microcopy & tone of voice cross-cutting section

---

### Chunk 3 — Design system audit: contrast, layout grid, focus rings

**Why third:** Like microcopy, touches every component. Foundation sweep before strategic work.

**Scope:**
- Global contrast audit. Every text/background combination across the app verified against WCAG 2.2 AA (4.5:1 for body, 3:1 for large text). Black-on-black button bugs eradicated — not by patching one button at a time but by adding contrast as a design token guard.
- Add contrast-token-validation utility: a runtime check that warns in dev when a `bg-*` token is paired with a `text-*` token that fails contrast.
- Layout grid normalization. Every page in `apps/web/app/` uses the same content max-width (currently inconsistent — Billing is dramatically narrower than Dashboard). Define a single `content-container` class in the design system; apply everywhere.
- Focus ring audit. Every interactive element has a visible focus ring meeting WCAG 2.2 (3:1 contrast against background, ≥2px width). Tab through every page to verify.
- Add the `sr-only` treatment to the skip-to-main-content link (currently leaking visually).

**Acceptance criteria:**
- WCAG 2.2 AA contrast verified on every page via Lighthouse + manual audit
- Zero instances of invisible button text (the black-on-black bugs are gone)
- Every page uses the same `content-container` layout grid
- Focus rings visible on every interactive element when tabbed
- Skip-link hidden visually until keyboard focus
- accessibility-auditor reports zero critical/serious violations

**Walkthrough findings resolved:** Billing CRITICAL (black-on-black CTA), Choose plan CRITICAL (three invisible tier CTAs), Billing MEDIUM (narrower content area), Navigation MEDIUM (skip-link leak), Design system gaps cross-cutting section

---

### Chunk 4 — Hydration & loading state pattern

**Scope:**
- Establish single loading pattern across the app: skeleton → real content, with no flicker, no late-render races.
- Audit every page for hydration races: settings (brand voice + workspace name disappearing), dashboard (sparkline late-animate), sidebar (badge count flicker). Either SSR everything above the fold OR consistently apply skeleton.
- Define skeleton component primitives in `packages/ui/`: `<Skeleton.Card />`, `<Skeleton.Row />`, `<Skeleton.Text />`, etc. Match the shape of the loaded content.
- Add a `useFirstRender()` hook to coordinate skeleton-to-content swap on all client-fetched data.

**Acceptance criteria:**
- No visible flicker on initial page load for any of the 7 main pages (dashboard, lapsed customers, campaigns, conversations, attribution, billing, settings)
- "Lapsed test" workspace name in sidebar does NOT disappear on settings page load
- Brand voice section + Extract button render in their final position from frame 1 (skeleton if not loaded)
- Skeleton primitives documented in `DESIGN-SYSTEM.md`
- Lighthouse CLS ≤ 0.1 on every page

**Walkthrough findings resolved:** Settings HIGH (hydration race), Loading & hydration cross-cutting section

---

### Chunk 5 — Empty state pass

**Scope:**
- Audit every empty state across the app. Apply unified pattern:
  - **When/then language** ("Figures appear here once X has happened")
  - **Preview of future structure** (greyed-out columns, sample row, illustration of what'll appear)
  - **Next-action CTA** (where applicable — "Create your first campaign", "Preview sample conversations", "Connect Shopify to start syncing")
  - **No internal terminology**
- Pages requiring updated empty states:
  - Dashboard cards (Active campaigns, Ready to reactivate)
  - Lapsed customers (preview future columns)
  - Campaigns (already good — but add CTA for chunk 7)
  - Conversations (add "Preview sample conversations" link to `/preview`)
  - Attribution (already strong — but hide/disable filter tabs in empty state)
  - Billing (preview future plan card structure once subscribed)
- Establish empty-state pattern in `packages/ui/EmptyState.tsx` with consistent layout (illustration → heading → explainer copy → CTA → secondary action).

**Acceptance criteria:**
- Every page has an empty state using the unified pattern
- Every empty state has a clear next action (CTA, link to demo, or explainer of when content will appear)
- Attribution filter tabs hidden OR visibly disabled when no data exists
- Dashboard cards explain what will appear and when, not just "Pending first score"
- Lapsed customers page previews future column structure with greyed-out placeholders
- EmptyState component documented in `DESIGN-SYSTEM.md`

**Walkthrough findings resolved:** Dashboard HIGH (Active campaigns confusing, Ready to reactivate copy), Lapsed customers MEDIUM (no preview of structure), Conversations MEDIUM (no bridge to action), Attribution MEDIUM (interactive tabs in empty state)

---

### Chunk 6 — Settings affordances + opt-out keyword editing

**Scope:**
- Consistent edit pattern across all settings fields. Two acceptable patterns: (a) always-editable with auto-save + inline confirmation, (b) explicit Edit → Cancel/Save flow. Pick ONE and apply globally.
- Make opt-out keywords editable. Add UI to add, edit, remove keywords. Validation: case-insensitive, no special chars beyond letters/numbers, length 2-30 chars. STOP and STOPALL remain non-removable (Twilio reserved).
- Add "Default opt-out keywords used by the agent when drafting messages" — a separate editable list that the AI is instructed to include in outbound drafts (separate from the inbound opt-out keyword detection list, which is what the existing badges show).
- "Last synced: Never" — when the sync hasn't happened, the Re-sync button shows tooltip explaining ("Available after your first nightly sync at 03:00 UTC"). After first sync, button works.
- Audit every settings section for consistent affordance signaling.

**Acceptance criteria:**
- One edit pattern applied across all settings fields (pick: always-editable + inline-save preferred for premium feel)
- Opt-out keywords list is fully editable (add, edit, remove), with STOP and STOPALL marked as non-removable
- Separate "Agent draft defaults" section for outbound opt-out language
- Disabled Re-sync button has explanatory tooltip
- All settings changes persist correctly via existing API routes
- Tests cover: edit a keyword, add a keyword, remove a non-reserved keyword, attempt to remove STOP (fails with clear error)

**Walkthrough findings resolved:** Settings HIGH × 3 (opt-out not editable, no agent defaults, inconsistent edit affordances), Settings MEDIUM (disabled Re-sync explainer)

---

### MID-SPRINT CHECKPOINT (after chunk 6)

The build agent stops here and surfaces a checkpoint prompt. Rationale: chunks 1-6 are foundational sweeps; chunks 7-13 are strategic features that build on them. The checkpoint verifies foundation is sound before strategic work begins.

The checkpoint evaluator should specifically verify:
- All CRITICAL walkthrough findings resolved by chunks 1-6
- All HIGH walkthrough findings (in scope for foundational chunks) resolved
- Vocabulary CI gate operational
- Demo mode functional and being used for ongoing populated-state walkthroughs
- Hydration race fixed across all pages
- Contrast pass complete
- Empty states unified

If the foundation is sound: APPROVE, proceed to chunk 7. If gaps remain: ADJUST with specific items.

**Carry-forward instruction:** While the checkpoint runs, Tim should use demo mode (`/preview`) to walk through populated screens and add any new findings to `WALKTHROUGH-FINDINGS.md`. These become acceptance criteria for chunks 7-13.

---

### Chunk 7 — Campaign creation flow

**Scope:**
- Add "Create campaign" button to campaigns page header. Primary CTA.
- Manual campaign builder: select cohort (from existing customer groups), select template (or start blank), select message length / tone parameters, preview generated messages across 3-4 arms, approve to launch.
- Integrates with existing approval flow from Sprint 06 — once approved, the campaign enters the standard approval-and-send pipeline.
- "Cohort picker" UI — list of customer groups with current size, last-campaigned date, recommended-or-not signal.

**Acceptance criteria:**
- "Create campaign" button visible on `/app/campaigns` and discoverable within 2 seconds of page load
- Full create flow: pick cohort → pick template → preview arms → approve → enters draft state
- Created campaigns appear in the existing approval queue
- Manual campaigns are tagged with `source: 'manual'` for analytics
- Tests cover: create empty, create from template, create cancellation, validation errors

**Walkthrough findings resolved:** Campaigns CRITICAL (no way to create), partial Campaigns HIGH (template library)

---

### Chunk 8 — AI Insights/Recommendations engine

**Scope:**
- Build `packages/core/src/insights-engine.ts` per decision 36 (deterministic, signal-derived).
- Recommendation categories:
  - **Cohort signals** — "X new VIP customers became dormant this week — historical win-back rate on this cohort is Y%"
  - **Arm signals** — "Arm B on your 60-day winback has converged at X%, well below Arm A's Y%"
  - **Opt-out signals** — "Opt-out rate on campaign X rose to Y% (typical 1-2%)"
  - **Conversation signals** — "Reply rate has been declining for X weeks"
  - **Payment signals** — "Card on file expires in N days" (when Stripe data flows)
- Each recommendation has: `id`, `priority`, `category`, `signal_metric`, `signal_value`, `threshold`, `merchant_copy`, `cta_action`, `created_at`, `expires_at`, `state` (active/dismissed/acted/snoozed).
- New DB table `insights` (migration 0016). Append-only event log; state changes write new rows.
- Background job that runs every 6 hours, evaluates signals against thresholds, generates new recommendations, expires stale ones.
- API routes for fetching active recommendations + state-change mutations.

**Acceptance criteria:**
- `insights-engine.ts` exports a stable interface: `generateRecommendations(merchantId)`, `getActive(merchantId)`, `markActed/Dismissed/Snoozed(id)`
- Migration 0016 applied, RLS scoped to merchant
- Background job scheduled in vercel.json at 5,11,17,23 UTC (every 6 hours)
- Tests: each category fires when threshold crossed, each clears when threshold un-crossed, dismissal persists, idempotency on re-evaluation
- No LLM calls in this engine — verified by code-reviewer (search for any anthropic/openai SDK imports in the file)

**Walkthrough findings resolved:** Sets up chunk 9 and chunk 10. No direct walkthrough findings — this is foundational.

---

### Chunk 9 — Suggested campaigns surface

**Scope:**
- Consumer of chunk 8's engine. On `/app/campaigns`, surface 2-4 AI-suggested campaigns as cards above the proposal review list.
- Each suggestion card: cohort name + size, suggested message pattern, expected win-back rate (based on historical), single "Spin up this campaign" CTA that auto-drafts and queues for approval.
- "Why suggested" tooltip on each card explains the signal that triggered it.
- Template library below suggested cards: proven patterns (60-day winback, VIP recovery, replenishment, post-purchase, post-holiday) as picker cards.

**Acceptance criteria:**
- 2-4 suggestions render on `/app/campaigns` when engine returns them
- One-click "Spin up" creates a draft campaign with cohort + template pre-filled, lands in approval queue
- "Why suggested" tooltip on every card
- Template library renders below suggestions with 5+ pattern cards
- Demo mode shows realistic suggested-campaigns examples
- Tests: rendering with 0/1/2/4 suggestions, spin-up creates correct draft, dismiss persists

**Walkthrough findings resolved:** Campaigns HIGH × 2 (no suggested campaigns, no template library)

---

### Chunk 10 — Dashboard reframe

**Scope:**
- Restructure dashboard into the four-section "morning standup" pattern:

  **1. Headline outcome** — Restored revenue with: counterfactual line ("~$X is incremental — would not have come back without lapsed.ai"), 95% confidence interval, comparison toggle (last 30 / 90 / lifetime), methodology tooltip.

  **2. Active state** — Lifecycle pipeline (active → at-risk → recently lapsed → deeply lapsed → reactivated) as mini-funnel/sankey. Per-campaign health rows beneath: name, days running, % cohort sent through, current arm posterior, opt-out trend (green/amber/red).

  **3. Recommended actions** — Top 3-5 recommendations from chunk 8's engine, rendered as merchant-facing cards with action CTAs and dismiss/snooze. "See all insights" link to standalone Insights page.

  **4. Forecast** — Projected restored revenue next 30 days ± CI band, upcoming cohort milestones, posterior maturity timeline.

- Replace the current sparse layout. Header bar gains: workspace name (real, no demo bleed), sync status indicator (Shopify last-synced timestamp, Twilio health, Stripe health), help affordance, notifications bell (currently decorative — Sprint 11 makes it real for recommendations).
- Add "how is this calculated?" tooltip on every metric.
- Sparkline replaced with proper chart: axes, labels, scale, prior-period reference line, hover state.

**Acceptance criteria:**
- Four sections visible above the fold on 1440px desktop, gracefully stack on mobile (chunk 11)
- Counterfactual + CI render correctly when attribution data exists; gracefully empty-state when not
- Comparison toggle changes period and re-renders all metrics
- Per-campaign health rows for every active campaign with correct trend colors
- Recommended actions surface consumes chunk 8 engine, shows top 5 by priority
- Forecast section renders projected revenue + cohort milestones
- Every metric has methodology tooltip
- Sync status indicators in header bar accurate to current state
- Mobile responsive (chunk 11 will verify)
- Tests: each section renders correctly with full/partial/empty data

**Walkthrough findings resolved:** Dashboard HIGH × 3 (header bar space, Active campaigns demo, Ready to reactivate copy), Dashboard MEDIUM (sparkline lack of context), Strategic dashboard reframe in WALKTHROUGH-FINDINGS

---

### Chunk 11 — Mobile responsiveness + accessibility pass

**Scope:**
- Every screen tested at 375px width (iPhone SE size). Fix anything that breaks, overflows, or becomes unusable.
- Tables that overflow get horizontal scroll OR collapsed-row card pattern.
- Sidebar collapses to mobile drawer on screens <768px.
- All forms remain usable on mobile (input zoom, tap targets ≥44px).
- Full keyboard navigation audit: every interactive element reachable via Tab, every modal closable via Esc, no keyboard traps.
- Screen reader smoke test on dashboard, campaigns, conversations (VoiceOver or NVDA).
- `prefers-reduced-motion` respected: chart animations disabled, transitions instant.
- Reduced-color-vision check: every color-coded signal (green/amber/red trend indicators) has a non-color affordance (icon or text).

**Acceptance criteria:**
- Every page usable at 375px width with no horizontal scroll on the main content
- Sidebar collapses to drawer below 768px
- All interactive elements reachable via keyboard
- No keyboard traps (Esc closes modals, Tab loops correctly)
- Screen reader smoke test passes on top 3 pages
- `prefers-reduced-motion: reduce` disables animations
- Color-coded indicators have non-color affordances
- accessibility-auditor reports zero serious violations

**Walkthrough findings resolved:** Mobile responsiveness section (was unwalked), Accessibility cross-cutting section

---

### Chunk 12 — First-run onboarding tour + install page guidance + brand polish

**Scope:**
- First-run tour for new merchants. Triggers on first login after install. 5-7 steps:
  1. Welcome — "Your store is connected. Here's how lapsed.ai works in 90 seconds."
  2. Your customers — "We'll classify your customers by purchase cadence overnight. Tomorrow morning you'll see them grouped here."
  3. Your voice — "Extract your brand voice now (60 seconds) or skip and we'll use a sensible default."
  4. Your first campaign — "Once we've classified, we'll suggest your first winback. You always approve before anything sends."
  5. Your dashboard — "This is where you'll see what's working. Defensible math, no marketing claims."
  6. (optional) Settings — "Customize opt-out behavior, agent tone, integrations."
  7. Done — "We'll email you when your first cohort is ready."
- Skippable, dismissible per-step, completable in <2 minutes.
- Persists state in `merchants.onboarding_state` (new column, migration 0017).
- Install page guidance for merchants who land there without `?shop` param: "Find lapsed in the Shopify App Store" link (real URL) + "How to install" expandable section.
- Brand polish: favicon (lapsed-mark.svg), OG meta tags on marketing pages, Twitter cards, 404 page (helpful, branded), 500 page (apologetic, branded), loading screen on initial app load (lapsed wordmark with spinner).

**Acceptance criteria:**
- First-run tour fires on first authenticated app load post-install
- All 5-7 steps reachable, skippable, dismissible
- State persists via `merchants.onboarding_state` enum (`not_started`, `in_progress`, `completed`, `skipped`) (migration 0017)
- Install page shows "Find lapsed in the Shopify App Store" link with real URL
- Favicon set on all routes
- OG meta tags + Twitter cards on marketing pages
- 404 + 500 pages branded and helpful
- Loading screen on initial app load
- Tests: tour state transitions, install page rendering with/without shop param

**Walkthrough findings resolved:** Install page HIGH (no guidance), Onboarding polish section, Brand polish items

---

### Chunk 13 — HANDOFF + E2E

**Scope:**
- E2E test for demo mode flow (visit `/preview`, verify all pages render, click "Install" CTA leads to install page)
- E2E test for first-run onboarding tour (mock new merchant, verify state transitions)
- E2E test for campaign creation flow (manual builder produces a draft in the approval queue)
- E2E test for AI recommendations (engine generates expected recommendations from seeded signals)
- HANDOFF.md using EVIDENCE-REQUIRED format. Every rubric criterion needs: implementation file:line refs, test file:line refs, test count, named assertion, walkthrough findings resolved (cross-reference to WALKTHROUGH-FINDINGS.md sections).

**Acceptance criteria:**
- 4 new E2E tests passing
- HANDOFF.md complete with all 10 criteria scored 3/3 + evidence
- Deliberate Deviations section lists any walkthrough findings deferred to Sprint 12 with rationale
- Walkthrough coverage: every CRITICAL and HIGH finding from WALKTHROUGH-FINDINGS.md crossed off OR explicitly deferred with reason

---

## 10-criterion rubric

Score each 0-3 (0 = absent, 1 = partial, 2 = mostly there, 3 = complete with evidence).

1. **Demo mode** — `/preview` route public, fixtures complete, all pages render, prospect can evaluate without installing. No demo bleed into live merchant routes.
2. **Microcopy + vocabulary** — All internal terminology purged from user-facing strings. `pnpm grep:vocab` operational and green. Premium tone applied consistently.
3. **Design system foundation** — WCAG 2.2 AA contrast across every page. Unified content max-width. Focus rings visible. Skip-link properly hidden.
4. **Loading & hydration** — Single skeleton pattern applied everywhere. No flicker, no race-driven layout shift. CLS ≤0.1 on every page.
5. **Empty state pattern** — Every page has unified empty state with when/then language, future-structure preview, and next-action CTA.
6. **Settings affordances** — One edit pattern across all fields. Opt-out keywords fully editable. Agent default keywords distinct and editable.
7. **Campaign creation + suggestions** — "Create campaign" button discoverable. Manual builder works end-to-end. Suggested campaigns surface consumes recommendations engine. Template library present.
8. **AI Insights/Recommendations engine** — `insights-engine.ts` deterministic, signal-derived, 5+ categories operational. Background job scheduled. Dashboard surface consumes it.
9. **Dashboard reframe** — Four-section morning standup pattern. Counterfactual + CI on headline. Lifecycle pipeline. Campaign health rows. Recommendations surface. Forecast. Methodology tooltips. Real header bar density.
10. **Mobile + accessibility + onboarding polish + HANDOFF** — Every screen usable at 375px. Full keyboard nav. Screen reader smoke passes. First-run tour functional. Install page guidance. Brand polish complete. HANDOFF.md with evidence per criterion.

---

## Process notes

### Auditor dispatch pattern

Every chunk dispatches the full 7-auditor set in parallel:
- architecture-guardian
- code-reviewer
- test-coverage-analyzer
- spec-adherence-auditor (required reading includes `WALKTHROUGH-FINDINGS.md`)
- vocabulary-auditor
- design-tenet-auditor
- accessibility-auditor

Exception: Chunk 13 (HANDOFF) dispatches code-reviewer + spec-adherence-auditor only (established pattern).

### UX work differs from algorithmic work

Sprint 09 had 6 BLOCK findings — mostly correctness bugs in math or webhook handling. Sprint 11's failure modes are different:

- **Design judgment debates.** "Should the empty state CTA be primary or secondary styled?" The build agent should err toward asking on subjective calls rather than guessing. Surface the dispute, propose 2-3 options, let the checkpoint or final evaluator rule. Don't silently pick one and ship.
- **Tone & voice consistency.** The vocabulary-auditor catches forbidden terms; the design-tenet-auditor catches token violations. But tone consistency requires sampling many strings and feeling whether they "speak the same voice." The build agent should compile a list of new strings introduced by each chunk and apply the four tone guidelines deliberately, not just by reflex.
- **Mobile responsiveness can't be fully auditor-verified.** Auditors review code, not rendered output. Chunk 11 requires actual rendered verification at 375px — either via Playwright visual tests OR human review. The harness pattern accommodates this by treating the chunk-11 acceptance criteria as evidence-required: screenshots or visual-test outputs in the HANDOFF.

### Mid-sprint checkpoint specifics

Checkpoint after chunk 6 verifies:
- All CRITICAL walkthrough findings resolved by chunks 1-6 scope
- Demo mode operational and being used by Tim for ongoing walkthrough
- Vocabulary CI gate operational
- Contrast pass complete
- Hydration race fixed
- Empty states unified
- Settings affordances correct

If APPROVE: proceed to chunk 7.
If ADJUST: list specific gaps, build agent remediates, re-audit, then proceed.
If BLOCK: stop. Foundation isn't sound. Sprint 11 needs reshaping.

### CI gates at every commit

Same as prior sprints, plus the new ones:
- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm grep:pii`
- `pnpm grep:vocab` (NEW — decision 35)
- `pnpm vercel:env:check`

### Hard stops requiring human approval

- Migration changes beyond what chunks 8 (insights, migration 0016) and 12 (onboarding_state, migration 0017) specify
- Architectural decision changes to the 36-decision list
- Out-of-scope work (Sprint 12 items, v2 items)
- New external dependencies (no new SDKs without explicit approval)
- Marketing site rebuild — only fix specific findings, do NOT redesign

### Sprint 11 specifics worth noting

- **WALKTHROUGH-FINDINGS.md is the source of truth.** Every CRITICAL and HIGH finding must be addressed by the sprint OR explicitly deferred in HANDOFF Deliberate Deviations with rationale.
- **The walkthrough is partial.** Populated-state findings (campaigns, conversations, attribution detail pages) are not yet captured. Once chunk 1 (demo mode) lands, Tim will walk through populated screens via `/preview` and add findings to the doc. These become acceptance criteria for chunks 9-12.
- **No new external dependencies.** Sprint 11 should NOT add new npm packages, NEW external services, or new vendor SDKs. The recommendations engine is deterministic (no new ML/LLM); the dashboard reframe uses existing chart primitives or adds them as design system components.
- **Performance budget.** Lighthouse score ≥90 on every page, LCP ≤1.5s, CLS ≤0.1, TBT ≤200ms. Sprint 11 is a coherence sprint, not a feature sprint that excuses bloat.
- **Brand voice extracted from existing source.** If first-run tour copy needs lapsed.ai brand voice, extract it from the existing PRODUCT.md narrative — don't invent a new voice.

---

## Sprint 11 build plan acknowledgment template

The build agent acknowledges with a 4-6 line plan covering:

(a) **Demo mode foundation approach** — fixtures location, route structure, demo-data hook pattern, marketing site CTA update

(b) **Microcopy + vocabulary CI gate** — deny-list scope, grep-vocab command structure, premium tone guidelines location in DESIGN-SYSTEM.md

(c) **Design system foundation strategy** — contrast token guard, layout grid container, focus ring tokens, skip-link fix

(d) **Insights engine design** — signal categories, threshold logic, state machine, migration 0011 shape

(e) **Dashboard reframe approach** — four-section layout, where each pulls data from, mobile collapse strategy

(f) **Mid-sprint checkpoint barrier** — after chunk 6 confirmed, proceed only after APPROVE or ADJUST-then-remediated

The agent proceeds to chunk 1 without waiting for confirmation after acknowledgment.
