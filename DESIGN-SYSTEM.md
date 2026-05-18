# DESIGN-SYSTEM.md — lapsed.ai

The lapsed.ai web app applies the Deel mobile aesthetic adapted for desktop. The reference is the live mockup at `mockup-dashboard.html`. Sprint 01 produces a faithful React implementation of these tokens and components.

**Aesthetic codename**: *Vellum* — warm, professional, slightly editorial. Cream surfaces, lavender accent, ink black, with a single serif moment for headline numbers to break the all-sans monotony.

---

## Brand

- **Wordmark**: `lapsed.` (with terminal period, mirroring the `deel.` convention)
- Wordmark font: Geist 700, letter-spacing `-0.04em`, color `--ink-900`
- Tone: confident, plain-spoken, never cute. Sentence case everywhere. Never exclamation marks in product copy.

---

## Color tokens

All colors are hex values committed to. No "near-white" or "off-black" approximations — use these exact stops.

### Lavender (brand accent — primary signal)

| Token | Hex | Usage |
|---|---|---|
| `--lavender-50` | `#F5F1FF` | Hover fills, soft tags |
| `--lavender-100` | `#E8DFFC` | Avatar backgrounds, tag fills |
| `--lavender-200` | `#D4C5F8` | Sub-surface emphasis |
| `--lavender-400` | `#B8A6F4` | Sidebar primary, brand surfaces |
| `--lavender-500` | `#9C85EE` | Chart accents, focus rings |
| `--lavender-700` | `#6B52C9` | Tag text on lavender-100, strong accents |

### Cream (surface — warm white system)

| Token | Hex | Usage |
|---|---|---|
| `--cream-50` | `#FCFAF5` | Panel surfaces |
| `--cream-100` | `#F8F5EE` | App background |
| `--cream-200` | `#F2EDE2` | Hover states, subtle wells |
| `--cream-300` | `#E8E1D2` | Inputs, dividers |
| `--cream-400` | `#D6CCB7` | Strong borders |

### Ink (text + primary buttons)

| Token | Hex | Usage |
|---|---|---|
| `--ink-900` | `#0A0A0B` | Primary text, primary CTA, wordmark |
| `--ink-700` | `#2E2C2A` | Secondary heading, sidebar nav text |
| `--ink-500` | `#5F5C57` | Body secondary, metric labels |
| `--ink-300` | `#94918A` | Hints, timestamps, disabled |

### Status (semantic only — never decorative)

| Token | Hex | Usage |
|---|---|---|
| `--success-500` | `#2D8A4E` | Live status, positive deltas, converted tag text |
| `--success-100` | `#DDF0E2` | Live badge fill, converted tag fill |
| `--warning-500` | `#C8941E` | Paused status, scheduled-soon |
| `--warning-100` | `#F8ECCD` | Paused badge fill |
| `--danger-500` | `#C04848` | Notifications dot, churned, errors |
| `--danger-100` | `#F4DCDC` | Error fills |

### Border

| Token | Hex | Usage |
|---|---|---|
| `--border` | `#ECE6D6` | Default panel and divider |
| `--border-strong` | `#D8D0BC` | Emphasised borders, input rings |

---

## Typography

Two fonts. No third font. No system fallbacks except for monospace.

### Faces

- **Geist** (Google Fonts), weights 300, 400, 500, 600, 700 — the entire UI runs on this
- **Instrument Serif** (Google Fonts), regular and italic — used *only* for hero numbers and stat moments that need editorial weight

### Type scale

| Token | Size | Line height | Weight | Tracking | Usage |
|---|---|---|---|---|---|
| `text-hero` | 64px | 1.0 | 400 (Instrument Serif) | -0.03em | Hero stat values only |
| `text-display` | 28px | 1.1 | 500 | -0.02em | Metric values, page-level numbers |
| `text-h1` | 22px | 1.2 | 600 | -0.015em | Page titles |
| `text-h2` | 18px | 1.3 | 600 | -0.01em | Section titles in main canvas |
| `text-h3` | 15px | 1.35 | 600 | normal | Panel titles, card headers |
| `text-body` | 14px | 1.5 | 400 | normal | Default body |
| `text-body-strong` | 14px | 1.5 | 500 | normal | Emphasis within body |
| `text-meta` | 13px | 1.4 | 400 | normal | Helper text under inputs, secondary metadata |
| `text-label` | 13px | 1.3 | 500 | normal | Metric labels, form labels |
| `text-mini` | 12px | 1.35 | 500 | normal | Statuses, sub-row metadata |
| `text-micro` | 11px | 1.4 | 600 | 0.04em | Section labels, tag text (uppercase) |

### Numerals

All numeric values in metrics, tables, conversation timestamps, and revenue displays use `font-variant-numeric: tabular-nums` so columns align.

### Instrument Serif rule (hero numbers only)

`font-serif` (Instrument Serif) is used **exactly once per page** — in the `<HeroMetric>` component for the single largest stat on that page (e.g. "Revenue restored $47,283" on Dashboard and Attribution, "$799 / mo" on Billing). All other numbers use Geist Sans with `tabular-nums`. Never add `font-serif` ad hoc in app route files; always go through `<HeroMetric>`.

---

## Spacing, radius, shadow

### Spacing scale (Tailwind-compatible)

`0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64` px. No arbitrary values; if a value isn't on the scale, the design is wrong.

### Radius

| Token | Px | Usage |
|---|---|---|
| `--radius-sm` | 8px | Buttons, inputs, small chips |
| `--radius-md` | 12px | Cards, metric cards, panels |
| `--radius-lg` | 16px | Hero card, modal containers |
| `--radius-xl` | 20px | Onboarding cards, marketing surfaces |
| pill | 999px | Status badges, tags |

### Shadow

The Vellum aesthetic is shadow-free. The only shadow allowed is the focus ring:

```css
box-shadow: 0 0 0 3px rgba(156, 133, 238, 0.25); /* lavender-500 @ 25% */
```

No drop shadows on cards or panels. Elevation is communicated through subtle 1px borders on cream surfaces, not depth.

---

## Layout shell

The merchant app uses a fixed two-pane layout at all viewports ≥1024px.

| Region | Width | Background | Border |
|---|---|---|---|
| Sidebar | 248px | `--lavender-400` | right: 1px `--border` |
| Topbar | 100% – 248px, 64px tall | `--cream-100` | bottom: 1px `--border` |
| Content | 100% – 248px, fills remaining | `--cream-100` | none |
| Content max-width | 1280px, centered with 32px gutters | — | — |

Below 1024px the sidebar collapses to a drawer triggered from the topbar. v1 does not optimise for sub-1024 viewports but layout does not break.

### Content container rule

Every page renders inside a `<div class="content-container">` within the AppShell's main content area. This class is defined in `tokens.css` as `width: 100%; max-width: 1280px` and ensures consistent layout grid across all pages. **Never add a per-page `max-w-*` override to an individual page's root element** — use the container class instead. Narrow layouts (auth forms, modals) are exempt but must be documented.

### Contrast token guard

Run `pnpm grep:contrast` locally to check all Vellum `bg-*/text-*` class pairs against WCAG 2.2 AA (4.5:1 for normal text, 3.0:1 for large). The script is advisory (exits 0) but violations are blocking before merge. Verified pairs to date: ink-900/cream-50 (21.0:1), ink-700/cream-50 (13.7:1), lavender-700/lavender-50 (5.1:1), ink-500/cream-50 (5.1:1).

---

## Components (shadcn/ui mapping)

Sprint 01 installs shadcn/ui and overrides the default theme with Vellum tokens. Every component below has a story in Storybook.

| Component | shadcn primitive | Vellum overrides |
|---|---|---|
| Button (primary) | `Button` | bg `--ink-900`, text `--cream-50`, radius `--radius-sm`, height 40px |
| Button (secondary) | `Button` variant outline | bg transparent, border `--cream-300`, hover bg `--cream-200` |
| Button (ghost) | `Button` variant ghost | text `--ink-700`, hover bg `--cream-200` |
| Input | `Input` | bg `--cream-50`, border `--cream-300`, height 40px, focus ring lavender |
| Select | `Select` | matches Input |
| Card | `Card` | bg `--cream-50`, border `--border`, radius `--radius-md` |
| Panel | composed | bg `--cream-50`, border `--border`, radius `--radius-lg`, header with bottom border |
| Badge | `Badge` | pill shape, semantic fills from status tokens |
| Tag (uppercase mini) | composed | pill, `text-micro`, semantic fills |
| Avatar | `Avatar` | bg `--lavender-100`, text `--lavender-700`, radius 50% |
| Dialog | `Dialog` | radius `--radius-lg`, 32px padding, cream-50 surface |
| Sheet (mobile drawer) | `Sheet` | lavender-400 sidebar contents |
| Toast | `Sonner` | ink-900 bg, cream-50 text, radius `--radius-md` |
| Table | composed | row border `--border`, hover bg `--cream-100` |
| Tabs | `Tabs` | underline style, active ink-900, inactive ink-500 |

### Custom composed components (not in shadcn)

- **HeroMetric** — the large recovered-revenue card with serif numeral, pulse dot, mini chart
- **MetricCard** — small metric tile with label + value + trend
- **CampaignRow** — three-column row with name/meta, status badge, revenue
- **ConversationRow** — avatar + name/time + preview + tag
- **StatusDot** — coloured dot in pill shape with text
- **SidebarItem** — nav item with icon, label, optional count badge, active state
- **ShopSwitcher** — sidebar footer card with shop avatar, name, plan, chevron

---

## Iconography

- **Library**: Lucide React (installed as `lucide-react`)
- **Stroke width**: 1.75 (override the default 2)
- **Sizes**: 18px in nav, 20px in buttons, 14–16px inline in meta rows
- Never use filled variants
- Decorative icons get `aria-hidden`; icon-only buttons get `aria-label`

---

## Motion

Restrained. The Vellum aesthetic moves quietly.

- Hover transitions: 150ms ease for backgrounds and colors
- Page transitions: none (server-rendered, no SPA-style fades in v1)
- Pulse animation on the live-revenue dot only — 2s infinite, scale + opacity
- Page-load reveal: staggered 80ms delay on hero → metrics → panels, fade-up 12px
- Toast slide-in: 180ms ease-out from top-right
- No bouncy springs. No parallax. No scroll-triggered animations in v1.

---

## v1 page inventory

Sprint 01 builds a static React route for every page below. Each route renders the components with seed data (committed JSON fixtures). No backend, no fetch calls. By end of Sprint 01 every screen below is navigable end-to-end as a click-through prototype.

| Route | Page | Key components |
|---|---|---|
| `/` | Marketing landing (placeholder) | Hero, three-column features, footer |
| `/app/auth/install` | Pre-install Shopify install prompt | Install button, scope explanation |
| `/app` | Merchant dashboard | HeroMetric, MetricCard × 3, Campaigns panel, Conversations panel |
| `/app/lapsed` | Lapsed customers list | Filter bar, table, score column, action menu |
| `/app/lapsed/[id]` | Customer detail | Profile header, order history timeline, conversation history |
| `/app/campaigns` | Campaigns list | Table of campaigns with status, recovered, recipients |
| `/app/campaigns/new` | Campaign creation wizard | 4-step flow: audience → offer → message → review |
| `/app/campaigns/[id]` | Campaign detail | Performance header, conversation feed, audience breakdown |
| `/app/conversations` | All conversations | Filter (tag, status, date), table |
| `/app/conversations/[id]` | Conversation thread | SMS thread view, customer sidebar, attribution panel |
| `/app/attribution` | Attribution report | Recovered revenue chart, breakdown by campaign, reconciliation status |
| `/app/billing` | Billing | Current plan card, usage meter, invoice history, plan switcher |
| `/app/settings` | Settings | Shop info, brand voice, opt-out keywords, integrations |
| `/app/onboarding` | First-run onboarding | 3-step flow: connect, set cadence, launch first campaign |

---

## Accessibility minimum

- All interactive elements reachable by keyboard
- Focus rings visible on every focusable element (the lavender ring above)
- Color contrast ≥4.5:1 for body text and ≥3:1 for large text against backgrounds — verified against Vellum tokens (passes)
- All icons either have text labels or `aria-label`
- All form inputs have associated `<label>`
- No reliance on color alone to convey status (status always pairs dot + text)

---

## Voice & tone

lapsed.ai speaks plainly and confidently to merchants. The interface is a tool, not a companion. Four rules govern all user-facing copy.

### 1 — Confident future-tense for pending states

When the system is waiting on a process, name the outcome and give a timeframe. Never say "pending" or "loading" without saying what comes next.

| Avoid | Use instead |
|---|---|
| `Pending first score` | `Your first scoring run completes within 24 hours of installing` |
| `No data yet` (alone) | `Figures appear here once a campaign's attribution window closes` |
| `Connecting…` | `SMS sending activates with your first campaign` |

### 2 — Concrete subjects, not vague reassurance

Say what the number measures. Avoid filler phrases that describe feelings or relationship metaphors.

| Avoid | Use instead |
|---|---|
| `We'd love to welcome you back` | `Here's 15% off for returning customers` |
| `We miss you!` | `There's a free sample waiting for you on your next purchase` |
| `Wonderful!` | `Your discount code is VIPBACK15 — valid for 7 days` |

### 3 — When/then framing for empty states

Empty states explain the trigger, not just the absence. Tell the merchant what action or event will populate the screen.

Pattern: *"[Content] appears here once [trigger]."*

Examples:
- `Attribution will appear here once this campaign's 30-day attribution window closes and the nightly batch has run.`
- `No attribution results yet. Figures appear here once a campaign's attribution window closes and the nightly batch has run.`
- `No campaigns in this period.` (acceptable for a filtered view — filter removal is the implied action)

### 4 — Merchant-second-person throughout

Address the merchant as "you". The AI agent acts on behalf of the merchant's brand — it is not a separate personality. Never use "we" to describe the lapsed.ai system.

| Avoid | Use instead |
|---|---|
| `We've detected 4 lapsed customers` | `4 customers are ready to reactivate` |
| `We'll notify you when…` | `You'll see results here once…` |
| `Our agent will reach out…` | `Your agent will reach out…` |

---

## Loading & skeleton pattern

### The rule: skeleton → real content, no flicker

Every async boundary in the app follows one pattern:

1. Show a skeleton with the **exact structural shape** of the final content.
2. Replace the skeleton with real content once data is ready.
3. Never show a blank page, a spinner without content shape, or a CLS-inducing appearance of content that shifts layout.

### Skeleton primitives (`packages/ui/src/components/skeleton.tsx`)

```tsx
import { Skeleton } from "@lapsed/ui";

// Base: any shape
<Skeleton className="h-[200px] w-full" />

// Text line(s)
<Skeleton.Text />              // single line at ~60% width
<Skeleton.Text lines={3} />   // 3 lines, last one at 40%

// List row (avatar + two text lines)
<Skeleton.Row />

// Card (label + value + sub-line)
<Skeleton.Card />
```

All skeleton elements use `bg-cream-300` as the fill and `motion-safe:animate-pulse` for the shimmer. Do not use `bg-ink-100` or `bg-cream-200` — those tokens are for content, not skeleton fills.

### `useFirstRender()` hook (`packages/ui/src/hooks/use-first-render.ts`)

```tsx
import { useFirstRender } from "@lapsed/ui";

function MyComponent() {
  const isFirst = useFirstRender();
  if (isFirst) return <Skeleton.Card />;  // SSR + hydration pass
  return <RealContent />;
}
```

Use this when a client component needs to render different content on the server pass vs. after mounting, to avoid hydration mismatches.

### `loading.tsx` convention

Every route segment in `apps/web/app/app/*` must have a `loading.tsx` that matches the structural shape of the page. Next.js App Router shows the nearest `loading.tsx` automatically during server-component fetch. Shape the skeleton to match the page's grid/panel layout so the transition from skeleton to content has zero layout shift.

### Focus ring token

The `--focus-ring` CSS variable uses a two-layer box-shadow:
```css
--focus-ring: 0 0 0 2px #FCFAF5, 0 0 0 4px #6B52C9;
```
- Inner 2px ring: `cream-50` (creates visual gap between element and ring)
- Outer 2px ring: `lavender-700` (#6B52C9, 5.4:1 contrast on cream-50, meets WCAG 2.4.11)

All interactive elements use `focus-visible:shadow-focus` — never bare `focus:` which also fires on mouse clicks.
