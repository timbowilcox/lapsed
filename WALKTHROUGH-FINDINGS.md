# WALKTHROUGH-FINDINGS.md

**Walkthrough date:** 18 May 2026
**Type:** Founder-as-merchant pre-Sprint-11 walkthrough
**Method:** Used lapsed.ai through the merchant lens after Sprint 09 production deploy. Pretended to be a brand-new merchant who had never seen the product. Captured everything that felt off.
**Status:** ACTIVE — partial coverage. Still to walk through: campaigns list + detail, conversations list + detail, attribution per-campaign + rollup views, mobile responsiveness pass at 375px, marketing site full pass.
**Purpose:** Input to SPRINT-11.md (UX coherence + onboarding polish sprint). Every finding here becomes a Sprint 11 acceptance criterion or is explicitly deferred to Sprint 12 / v2.

---

## Executive summary

The product works. The math is defensible (Sprint 09 symmetric ITT methodology), the Stripe billing surface is wired, the database has 34 merchants ready, and the end-to-end attribution path is in place. What it does NOT yet feel like is a premium SaaS product priced at $299–$1,499/month.

Three themes dominate the findings:

1. **The product feels early-stage.** Internal sprint terminology leaks into the UI ("Attribution in Sprint 08"). Buttons render with invisible text (black on black). Hydration races make the layout flicker on every page load. Demo data is wired inconsistently — the sidebar lies while the page tells the truth. These are all "this is a beta product" signals that erode credibility before the merchant has seen the value.

2. **The product confirms outcomes but does not advise.** The dashboard says what happened ("$47K restored") but doesn't say what it would have meant without lapsed.ai (the counterfactual), what's at risk now (the active state), what the merchant should do next (recommended actions), or what's coming (forecasts). For a tool that costs $299–$1,499/month, the merchant needs to walk away from the dashboard thinking "this is my most valuable BI tool", not "this confirms a number I could have got from Shopify Analytics."

3. **Affordances are inconsistent.** Some fields look editable but aren't. Some menu items have dropdown icons but no dropdowns. The primary product action (create a new campaign) has no discoverable surface. Each individual screen passed its per-chunk auditor, but the merchant journey through them surfaces a thousand small "wait, what?" moments that no single auditor would catch.

The walkthrough validates the core thesis of Sprint 11: per-chunk auditors approve narrow slices; coherence is a holistic concern that requires the merchant journey as the unit of analysis.

---

## Severity legend

- **CRITICAL** — Production-blocking embarrassment. Internal terms in UI, invisible buttons, missing primary actions.
- **HIGH** — Damages credibility, blocks conversion, or causes confusion in core flow.
- **MEDIUM** — Friction or inconsistency. Doesn't break a flow but accumulates "this is rough" perception.
- **LOW** — Polish. Minor visual or copy items.

---

## Findings by screen

### Marketing site — lapsed.ai

- **[MEDIUM]** Hero CTA "Preview the dashboard" links to `/app` (the install page), not to an actual preview. Text is misleading — clicking takes you to "Install lapsed on your Shopify store", not a preview. Either build a real preview path (see strategic section: Demo mode) or change CTA copy to "Get started" or "Install on Shopify".
- _Still to walk: rest of marketing site (features, pricing, social proof, footer) on next walkthrough._

### Install page — app.lapsed.ai/app/auth/install

- **[CRITICAL]** No path for prospects to preview the product without installing. The only entry point requires entering via Shopify Admin. The original "Preview the dashboard (no install)" button on this page was non-functional and has been removed (PR #21). The replacement — a real demo mode with sample-store data — is the highest-priority Sprint 11 addition.
- **[HIGH]** "Open from Shopify Admin to install" button styled as disabled with no guidance on what to do next. A merchant landing here has no way to know they need to go to Shopify Admin → Apps → search "lapsed". Add explicit copy + a "Find lapsed in the Shopify App Store" link with the right URL.
- **[FIXED]** Dead "Preview the dashboard (no install)" button removed (PR #21, 18 May 2026, commit on main).

### Dashboard — app.lapsed.ai/app

- **[CRITICAL]** "Reactivation rate" card shows "—" with subtitle "Attribution in Sprint 08". Internal sprint terminology in a merchant-facing surface. Replace with confident future-tense copy: "Available after 30 days of campaign activity" or "Calculating — your first reactivation rate publishes after Day 30."
- **[HIGH]** Demo data inconsistency. Dashboard cards correctly labelled `[demo data]`. Sidebar badges show demo counts (`Lapsed customers 2,847`, `Campaigns 3`, `Conversations 4`) but are NOT labelled and provide no indication they're synthetic. Either label everywhere or purge everywhere — currently neither.
- **[HIGH]** Header bar uses space poorly. Mostly empty air on a screen real-estate-rich product. For a $299–$1,499/month tool, the header should signal substance: workspace switcher, sync status indicator, search, recent-events badge. Currently feels lightweight.
- **[HIGH]** Active campaigns card says "3 — 2 live · 1 paused [demo data]". For a merchant who has 0 real campaigns, this is confusing — they don't know if they're meant to have 3, or if these are mocked. Empty state should show "No active campaigns yet. [Create your first campaign]" with a real CTA.
- **[HIGH]** "Ready to reactivate" card says "Pending first score · 0 total lapsed". The copy doesn't explain what scoring is, when it runs, or what the merchant should do while waiting. Replace with: "Your first scoring run completes within 24 hours of installing. You'll see your dormant cohorts here after that." Trust comes from clarity.
- **[MEDIUM]** Sparkline chart in top-right has no axes, no labels, no scale, no tooltip on hover, no comparison reference line. It's decorative noise rather than informative. Either context it properly (axes + hover + reference line for the prior period) or remove.
- **[LOW]** "Campaigns" section header has `[demo data]` label but the "Active conversations" section header has it too — fine, but the same `[demo data]` styling should be consistent across all sections. Audit for consistency.

### Lapsed customers — app.lapsed.ai/app/lapsed

- **[HIGH]** Sidebar badge says "Lapsed customers 2,847" while the page itself correctly shows "No lapsed customers identified yet". Demo data leakage into the navigation badge. Either remove demo counts from the sidebar or label them consistently.
- **[LOW — POSITIVE]** Empty state copy is well-pitched: "Once your store data syncs, the agent will classify customers by purchase cadence and score them. Check back after the nightly scoring run." Keep this pattern; replicate to other empty states (dashboard cards, billing).
- **[MEDIUM]** Page is just a header and an empty container. No filter chips, no sort controls, no view options, no indication of what columns will appear when data arrives. Compare to premium SaaS empty states which preview the future structure (greyed-out columns, sample row).

### Billing page (settings) — app.lapsed.ai/app/settings/billing

- **[CRITICAL]** Subscription plan CTA button is black-on-black — text is invisible. This is the primary conversion action. Currently unusable without sighted trial-and-error. Different instance from the chunk-10 `danger-700` contrast fix. The chunk-10 fix patched one button; the design system did not get a global contrast audit.
- **[MEDIUM]** Content area is dramatically narrower than the dashboard. Inconsistent page layout grid across the app — every page should share the same content max-width or have a defensible reason not to.
- **[MEDIUM]** "Choose a subscription plan to start running win-back campaigns" — the CTA below this text has no readable label (because of the contrast bug above), so the user can't even tell what clicking it will do.

### Choose a plan page — app.lapsed.ai/app/settings/billing (after CTA)

- **[CRITICAL]** All three tier CTAs (Starter $299 / Growth $799 / Scale $1,499) are black-on-black with invisible text. Three primary conversion actions, all broken. Same root cause as the billing page CTA — design system contrast audit needed.
- **[HIGH]** Plan card content is sparse. Premium SaaS tier pages typically include: who this plan is for ("Best for shops processing <$1M annually"), what's included beyond the headline limits, soft-recommend a tier ("Most popular"), comparison column for clarity. Currently it's three near-identical cards with different numbers.
- **[MEDIUM]** "Pick a subscription tier. Payment is handled securely by Stripe — card details are never stored by lapsed.ai." Good trust copy — keep this.
- **[LOW]** Pricing display format "$299 / month" is fine but "$1,499 / month" has a comma; consistency check (should the smaller numbers also use commas if/when they cross 1,000? — currently won't, but worth noting).

### Settings — app.lapsed.ai/app/settings

- **[HIGH]** Opt-out keywords (STOP, STOPALL, UNSUBSCRIBE, QUIT, END, CANCEL) are displayed as static badges. Premium SaaS expectation: editable list with validation. Merchants in regulated regions or with brand-specific opt-out conventions need to customize.
- **[HIGH]** No way to set the default opt-out keywords the AI agent uses when drafting outbound messages. Product-critical for merchants with regional/legal variation.
- **[HIGH]** Inconsistent edit affordances. Shop name appears editable (text input field). Shop domain appears editable (also a text input). But there's no Save button, no edit/cancel pattern, no indication of which fields are actually mutable. Need consistent edit UX across all settings: either always-editable with inline save, or explicit Edit → Cancel/Save flow.
- **[HIGH]** Hydration race. Brand voice section + "Extract brand voice" button take ~1 second to render after page load. During that window the workspace name "lapsed test" at the bottom of the sidebar is visible — then it disappears once brand voice loads. Visible jank. Needs a proper loading skeleton OR proper SSR for all above-the-fold content.
- **[MEDIUM]** No user management / role-based access. Multi-operator merchants will hit this immediately. Defer to Sprint 12+ but capture now — the spec needs invite, role (admin/editor/viewer), revoke, audit trail.
- **[MEDIUM]** "Last synced: Never" with a Re-sync button. The button is greyed out — appropriate for "never synced" state, but the disabled state should explain why ("Will become available after your first nightly sync") rather than being silently inert.
- **[MEDIUM]** Integrations section shows Shopify CONNECTED and Twilio PENDING. The Twilio PENDING state has subtitle "Pending — connects in Sprint 05". Another internal sprint terminology leak. Replace with merchant-facing copy: "SMS sending will be activated when you launch your first campaign."

### Navigation (cross-cutting)

- **[HIGH]** Bottom-of-sidebar "lapsed test" item has a chevron/dropdown icon that implies an expandable menu or workspace switcher. Clicking it just navigates to settings. Affordance lie. Either make it a real workspace switcher (proper dropdown with workspace list + "Manage workspaces") or remove the icon and let it behave as a direct nav link to settings.
- **[MEDIUM]** Skip-to-main-content link is leaking visually at the top of the sidebar (visible as a cropped "button" linking to `#main-content`). The accessibility intent is correct — keyboard users need a skip link — but the implementation is missing the `sr-only` (or equivalent `position: absolute; left: -9999px`) treatment that should hide it visually until keyboard focus.
- **[MEDIUM]** Sidebar nav items show counts (Lapsed customers 2,847, Campaigns 3, Conversations 4) but these are demo counts. When a real merchant has actual numbers, these become the authoritative counts. Decide and document: counts are real-data only.
- **[LOW]** No breadcrumbs anywhere. Deep pages (campaign detail, conversation detail, attribution detail) will need breadcrumbs for orientation. Capture for Sprint 11.

### Campaigns (still to walk fully)

- **[CRITICAL]** No discoverable way to create a new campaign. The primary product action — the thing the merchant pays $299+/month to do — has no surface. Either a "Create campaign" button in the page header, a "Suggested campaigns" surface that lets the merchant spin one up in a click, or a guided flow.
- **[HIGH]** No "suggested campaigns" surface. The AI knows which cohorts are dormant, which message patterns work historically, and which arms have converged. Surfacing 2-4 proactive recommendations as one-click-to-implement cards is high-leverage onboarding.
- _Still to walk: campaigns list view, campaign detail / approval flow, draft state, paused state._

### Conversations (not yet walked)

- _Still to walk: list view, conversation detail, AI-drafted-reply review, sentiment surface._

### Attribution (not yet walked)

- _Still to walk: per-campaign attribution view, merchant rollup, holdout vs treatment comparison, methodology explainer._

### Mobile responsiveness (not yet walked)

- _Still to walk: every screen at 375px width._

---

## Cross-cutting findings

### Demo data strategy

The demo data layer was wired during early sprints to hydrate empty states, but its surface area is now incoherent. Sidebar badges show demo counts unlabelled. Dashboard cards label demo data explicitly. Pages like Lapsed customers, Billing, and Settings correctly show real empty states. The result is a confusing hybrid that makes the merchant question what's real.

Two coherent options for Sprint 11:

**Option A — Full demo mode until real data arrives.** Every surface shows demo data with consistent labelling until the merchant's first nightly sync. After sync, demo data purges everywhere atomically.

**Option B — Real empty states everywhere.** Demo data is purged immediately on install. Every page shows a thoughtful empty state that previews future structure with explainer copy.

**Recommendation:** Option B. Real empty states are honest, easier to maintain, and align with the "honest numbers" tenet. Demo data should live on the marketing site (lapsed.ai/preview, Sprint 11 demo mode item) where prospects expect it.

### Design system gaps

Per-chunk auditors approved individual screens against `DESIGN-SYSTEM.md` tokens, but the walkthrough surfaces gaps the per-chunk reviews could not catch:

- Multiple instances of black-on-black button text (different from the chunk-10 `danger-700` fix)
- Inconsistent page-content max-width across pages (Billing much narrower than Dashboard)
- Inconsistent loading state patterns (some pages skeleton, some flicker, some block)
- Header bar density inconsistent across pages
- Sidebar badge styling inconsistent with content state

Sprint 11 should include a **global design system audit** that walks every component and confirms tokens applied correctly, in context, across every page.

### Loading & hydration

Multiple hydration races visible during walkthrough:
- Settings page: brand voice section + Extract button render late, workspace name disappears once they appear
- Dashboard: sparkline animates in after the rest of the page
- Sidebar: badge counts appear to flicker on initial load

Sprint 11 should establish a single loading pattern (skeleton → real content, or SSR everything above the fold) and apply consistently.

### Microcopy & tone of voice

The product currently speaks in three voices:
1. **Confident merchant-facing copy** — empty state on Lapsed customers, the "Stripe handles your card details" trust line on billing
2. **Engineering-facing leakage** — "Attribution in Sprint 08", "Pending — connects in Sprint 05"
3. **Placeholder copy** — "Pending first score", "—", "Never"

Sprint 11 microcopy audit: every user-facing string reviewed for tone of voice. Premium SaaS confidence throughout. Internal terminology categorically forbidden. Placeholders replaced with confident future-tense copy explaining what the merchant should expect.

### Accessibility

Beyond the contrast issues already noted:
- Skip-to-content link leaking visually (should be `sr-only` until focus)
- Reduced motion preferences not yet tested
- Keyboard navigation not yet tested through all flows
- Screen reader testing not yet performed
- Focus rings: not verified across components

Sprint 11 should include a real WCAG 2.2 AA audit, not just the per-chunk auditor's component-level review.

---

## Strategic content & metrics opportunities

The walkthrough surfaced a deeper question than UI polish: **does the dashboard justify the price?** At $299–$1,499/month, the merchant needs to feel they're getting their most valuable BI tool, not a marketing-claims confirmer. Below are the content/metrics upgrades that close the gap.

### Dashboard reframe — the 30-second morning standup

Restructure the dashboard around four questions the merchant has every morning: what happened, what's happening now, what needs my attention, what's coming.

**1. Headline outcome (refined "what happened")**
- Keep the restored revenue headline
- Add a **counterfactual line**: "~$31K of this is incremental — revenue that would not have come back without lapsed.ai (vs your holdout cohort)"
- Add **95% confidence interval**: "$24K–$38K incremental"
- Add **comparison toggle**: last 30 days / 90 days / lifetime
- Add a **methodology tooltip** linking to attribution methodology explainer

**2. Active state ("what's happening now")**
- Replace the bare "Active campaigns: 3" with a **lifecycle pipeline view**: how many customers are in each stage (active → at-risk → recently lapsed → deeply lapsed → reactivated). Mini-funnel or sankey.
- Per-campaign **health row**: name, days running, % sent through cohort, current arm posterior, opt-out trend (green/amber/red)

**3. Recommended actions ("what needs your attention") — THE DIFFERENTIATOR**
- AI-surfaced insights and recommendations:
  - "5 new VIP customers became dormant this week — historical win-back rate on this cohort is 38%. [Launch a campaign]"
  - "Your '60-day dormant' campaign's Arm B has converged at 12% reactivation, well below Arm A's 28%. [Retire Arm B] or [Investigate]"
  - "Opt-out rate on the VIP win-back campaign rose to 4.2% (typical: 1–2%). [Review messaging]"
  - "Conversation reply rate has been declining for 3 weeks. [See trend] or [Refresh brand voice]"
- This is where the product becomes consultant-grade. The math is already in your DB (RFM scores, cohort sizes, posterior estimates, opt-out data) — Sprint 11 surfaces it as plain-language nudges.

**4. Forecast ("what's coming")**
- "Projected restored revenue next 30 days: $51K ± $8K (based on current cohort, arm posteriors, seasonal trends)"
- "3 new cohorts will reach 60-day dormancy in the next week"
- "Your top-performing arm needs ~150 more sends to reach 95% confidence — likely by Tuesday"

### Lapsed customers page upgrades

- **Distribution heatmap** at top: recency × value tier. Merchant sees their dormant base shape at a glance.
- **Cohort cards** instead of a flat list: "60-day dormant (812)", "90-day dormant (445)", "VIP at risk (38)", each clickable to filter.
- **Score histogram** showing propensity distribution as a shape, not just a number.
- **Per-customer drilldown**: full timeline (purchases, lapses, campaigns received, replies, score history). Premium hover/click experience.
- **Filter chips** by status, recency, value tier, score band, last-campaign-sent.

### Campaigns page upgrades

- **"Suggested campaigns" cards at top** — AI recommendations the merchant clicks to spin up (matches walkthrough finding).
- **Template library**: proven patterns (60-day winback, VIP recovery, replenishment, etc.) the merchant can adopt.
- **Performance comparison view** — small multiples showing each active campaign's restored revenue, send count, opt-out rate, on a consistent scale.
- **Per-campaign drilldown** with arm-level posteriors, cohort breakdown, attribution timing histogram (when do reactivations actually happen post-send?).

### Conversations page upgrades

- **Sentiment trend chart** — positive/neutral/negative reply mix over time.
- **Top customer concerns** — extracted themes from inbound messages ("shipping cost", "out of stock", "price").
- **AI confidence indicator** — how well-aligned the AI's draft replies are to the merchant's brand voice.
- **Opt-out drill** — which campaigns and arms drive opt-outs, with reasons where stated.
- **Reply rate per arm** — leading indicator before order-level signals mature.

### Attribution page upgrades (defensibility moat)

- **Methodology explainer** at top — clickable: "We use a held-out control group with symmetric intent-to-treat. Read more..." Signals rigor.
- **Incremental waterfall**: total revenue → minus expected (holdout-derived) → equals incremental → 95% CI band.
- **Per-arm contribution breakdown** — which arms are doing the work.
- **LTV restoration projection** — not just revenue restored, but expected future revenue from reactivated customers (using historical cadence).
- **Time-to-purchase distribution** post-send — most win-back products hide this; surfacing it builds trust.
- **Cohort vs cohort comparison** — campaign A's cohort vs campaign B's cohort, controlling for value tier.
- **CFO-shareable PDF export** — clean monthly attribution report with methodology footnote.

### New sections worth adding

- **Insights / Recommendations** — first-class nav item, not buried. The AI-recommended actions from the dashboard expanded into a full inbox-style view. Every recommendation has a clear next action and a state (dismissed / acted / snoozed).
- **Reports** — exportable monthly/quarterly summaries. CSV + PDF. Methodology footnote on every report.
- **Benchmarks** (later, requires merchant critical mass) — "your reactivation rate is in the top quartile of beauty / DTC brands". Massive perceived value.
- **Notifications surface** — bell icon in header is currently decorative. Should be a real notification tray for campaign launched, opt-out spike, payment failed, attribution result ready, recommended action surfaced.

### Premium-feel principles

Three things separate premium SaaS dashboards from cheap-feeling ones, regardless of which specific metrics are surfaced:

1. **Density without clutter.** Every pixel of header/space justified. Add workspace switcher, real-time status indicators (Twilio health, Stripe health, Shopify sync recency), and a global search.

2. **Methodology transparency.** Every number has a "?" or "how is this calculated?" tooltip. Premium products invite scrutiny. Cheap ones hide their methodology.

3. **Tone of voice consistent with confidence.** Replace "Pending first score" / "Attribution in Sprint 08" with confident future-tense copy: "Your first scoring run completes within 24 hours. Until then, customer classifications are pending." Speaks to a merchant, not a debugger.

---

## Categorization for sprints

### Sprint 11 — UX coherence + onboarding polish + premium-feel core

The walkthrough findings + dashboard reframe + 2–3 differentiators that move perceived value from "$99 SaaS" to "$799 SaaS" without doubling engineering scope.

**Foundational fixes (all walkthrough HIGH/CRITICAL findings)**
- All CRITICAL items: Sprint 08 text leak, black-on-black buttons (global contrast audit), no campaign creation surface
- Demo data strategy resolved (recommend Option B: real empty states everywhere; demo mode lives at lapsed.ai/preview)
- Microcopy audit — all user-facing strings, premium tone, no internal terminology
- Loading & hydration pattern unified
- Skip-link visual fix
- Edit affordances on Settings page (opt-out keywords editable, consistent edit pattern)
- Sidebar workspace dropdown either real or de-iconned
- Inconsistent page layout grid fixed
- Empty state pass on every page (preview future structure)

**Premium-feel differentiators**
- Dashboard reframe: counterfactual line, 30-second standup structure, recommended actions surface
- Suggested campaigns surface on campaigns page (top differentiator + onboarding accelerator)
- Methodology transparency: "how is this calculated?" tooltips on every metric
- AI insights/recommendations layer (start with dashboard, expand to standalone Insights view)
- Attribution methodology explainer
- Per-page metric upgrades (distribution charts, cohort cards, drilldowns)

**Onboarding polish**
- First-run tour for new merchants (signup → connect → voice → first group review → first campaign approval guidance)
- Demo mode at lapsed.ai/preview (sample-store data, full dashboard render)
- Install page guidance ("Find lapsed in the Shopify App Store" with real link)
- Empty state CTAs guiding merchant to next action

**Cross-cutting**
- Global design system audit
- Mobile responsiveness pass (every screen at 375px)
- Accessibility audit (WCAG 2.2 AA, keyboard nav, focus rings, reduced motion)
- Loading state consistency
- Cross-page navigation (breadcrumbs, back-buttons, modal handling)
- Performance pass (LCP <1.5s, CLS <0.1)
- Brand polish (favicon, OG, 404/500)
- Tooltips/inline help for complex concepts (attribution, holdouts, bandit confidence)
- Help center stubs (every page has a `?` linking to docs.lapsed.ai stub)

### Sprint 12 — operator + production ops + deferred features

- Operator dashboard (Tim-facing, all-merchants view)
- Per-merchant Twilio numbers
- Sentry monitoring
- Production Stripe key switchover
- Stripe Tax full setup
- Backup verification + restore drill
- Production deploy hardening
- Marketing site
- Legal pages (ToS, Privacy, AUP, Refund)
- User management / roles
- Notifications surface (full notification tray)
- Reports / PDF export (CSV + PDF)
- Data export functionality
- Real-time status indicators in dashboard header

### Post-MVP / v2

- Benchmarks (requires critical mass of merchants for anonymization)
- LTV restoration forecasting (requires more time-series data)
- Advanced cohort comparison views
- Global search across the app
- Keyboard shortcuts for power users
- Dark mode
- Multi-currency invoicing beyond Stripe defaults
- Refund workflow UI
- Coupon codes / discounts
- Free trials
- Custom tax logic (Stripe Tax already handles, only revisit if Stripe Tax limits)
- Email notifications on payment events

---

## What works well (preserve / replicate)

Capture for Sprint 11 to ensure nothing good regresses:

- **Lapsed customers empty state** — "Once your store data syncs, the agent will classify customers by purchase cadence and score them. Check back after the nightly scoring run." Tone, length, and shape are correct. Use as template for other empty states.
- **Stripe trust copy** on billing page — "Payment is handled securely by Stripe — card details are never stored by lapsed.ai." Concise, builds trust, no jargon.
- **`[demo data]` labelling** on dashboard cards — the labelling itself is correct; the inconsistency is the issue. Keep the label pattern, apply everywhere demo data appears.
- **Settings page section structure** — Brand voice → Shop → Opt-out keywords → Integrations is a sensible information architecture. Keep the structure; fix the affordances.
- **Permission display on install page** — Required vs Optional permissions with explanation. Premium pattern; keep.
- **Sidebar information density** — primary nav + account section + counts is a reasonable structure. Fix the counts (demo data leakage); keep the layout.

---

## Open questions for next walkthrough

To capture on the next walkthrough session before Sprint 11 spec is finalised:

1. **Campaigns flow** — full walkthrough of create, approve, monitor, complete
2. **Conversations** — list, thread detail, AI-drafted-reply review
3. **Attribution** — per-campaign + rollup views, methodology surfaces
4. **Mobile responsiveness** — every screen at 375px width
5. **Keyboard navigation** — full app traversal using only Tab/Shift+Tab/Enter/Esc
6. **Marketing site full pass** — every public page on lapsed.ai
7. **Error states** — what happens on Shopify sync failure, Stripe payment failure, Twilio send failure, Sonnet API outage
8. **Notification scenarios** — campaign launched, opt-out spike, payment failed (currently no surface for these)

Resume the walkthrough when fresh. Save the rest of the day's findings for the next session.

---

## Document status

**Created:** 18 May 2026 (post Sprint 09 merge)
**Last updated:** 18 May 2026
**Becomes input to:** SPRINT-11.md
**Owner:** Tim Wilcox
**Status:** ACTIVE — needs continued walkthrough coverage before Sprint 11 scoping is finalized

When ready to scope Sprint 11, this file's contents (plus the additional walkthrough findings from the next session) become the SPRINT-11.md acceptance criteria. Severity tags drive priority within the sprint.
