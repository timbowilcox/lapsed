# PRODUCT.md — lapsed.ai product principles

> This file defines what lapsed.ai is, what it is not, how it should feel to use, and the vocabulary it uses to talk about itself. Every agent, UI change, and copy review should start here. Read alongside CLAUDE.md (which covers stack and conventions) and DESIGN-SYSTEM.md (which covers visual tokens).

---

## What lapsed.ai is

AI-driven dormant customer recovery SaaS for Shopify merchants. The product identifies customers who have stopped buying, engages them via two-way SMS conversations powered by an LLM, and attributes recovered revenue back to specific campaigns.

**ICP**: Shopify DTC merchants doing $2M–$50M in revenue.

**Positioning**: focused win-back specialist, not a generalist SMS platform. The differentiation is the AI conversation engine and the closed-loop revenue attribution against Shopify orders. We do one thing and we do it provably well.

---

## What lapsed.ai is not

- A broadcast SMS platform. We do not send blasts. We run conversations.
- A segment builder. Merchants do not define audiences from scratch. The agent identifies who to contact.
- A workflow builder. Merchants do not create drip sequences. The agent proposes and executes.
- A dashboard product. The UI exists to surface agent decisions and let the merchant approve or override them — not to make the merchant do analysis.

---

## The eight modules

The product ships as eight integrated modules. Each module is scoped to a sprint (see CLAUDE.md sprint sequence). Modules are listed here to establish vocabulary and ownership boundaries.

1. **Win-back engine** — identifies lapsed customers against configurable recency thresholds
2. **Group designer** — automated cohort identification using scoring signals; merchant approves, not builds
3. **Conversation engine** — two-way SMS conversations driven by LLM, opt-out compliant, channel-agnostic by design
4. **Campaign orchestrator** — ties groups to conversation templates + offers; runs with holdout control groups baked in
5. **Revenue attribution** — reconciles Shopify orders against open conversation threads; computes incremental (not gross) attribution
6. **Brand voice** — merchant-approved system prompt that shapes conversation tone and vocabulary; AI-suggested from storefront analysis
7. **Billing and metering** — Stripe integration with tiered subscription + 3% performance kicker on incremental recovered revenue
8. **Analytics** — closed-loop reporting: restored LTV per group, per campaign, holdout-adjusted; no vanity metrics

---

## Design philosophy — the eight tenets

These are binding. Every UI change is audited against them (see `.claude/agents/design-tenet-auditor.md`).

### 1. The agent is the product. The UI is for oversight.

The merchant's job is to approve, review, and occasionally override. Not to build, configure, or author. Any UI that requires the merchant to do work the agent should do is a violation.

### 2. One decision per surface.

Each screen or panel presents exactly one thing for the merchant to decide. Combining decisions on one surface creates hesitation and abandonment. If a surface has two calls to action of equal weight, one of them should not be there.

### 3. Show your work.

Every agent decision surfaces the reasoning behind it in plain language. Not "we recommend contacting this group" — "we recommend contacting this group because their average order value is $340 and their last purchase was 112 days ago, which is 2.1× their median reorder interval." The reasoning is not optional metadata. It is the product.

### 4. Honest numbers over impressive numbers.

Metrics shown to the merchant are holdout-validated where applicable, and incremental rather than gross where the distinction matters. We do not show "attributed revenue: $47,283" when the incrementality-adjusted number is $31,000. The honest number is the headline.

### 5. Approval over authoring.

When something requires merchant input, we present a drafted option for approval, not a blank canvas for authoring. The merchant taps "approve", "edit", or "reject" — they do not compose from scratch. Override mode is a fallback, not the primary flow.

### 6. Progressive disclosure, mercilessly.

Start with one number. Let the merchant tap to see three numbers. Let them tap again to see the full table. Never lead with the full table. Ruthlessly collapse depth until the merchant asks for it.

### 7. Calm, never urgent.

No red badges. No growing notification counts. No "X items need your attention" pressure language. No animated alerts. The product operates on behalf of the merchant in the background. When there is something to review, it waits. Urgency belongs to a pager, not to a recovery tool.

### 8. Professional register, not friendly-AI register.

The product speaks like a confident analyst briefing a founder, not like a chatbot trying to be liked. No first-person warmth phrasings ("We'd love to help you...", "Hey there!", "Let's get started!"). No decorative emoji in product UI. No personal name for the agent in operator-facing surfaces — functional language only ("the agent", "lapsed.ai"). Concise, direct, precise.

---

## The simplicity test

Before adding any UI element, control, field, or screen, ask these three questions:

1. **Could the agent decide this instead?** If yes, remove the control and let the agent decide. Surface the agent's decision for approval.
2. **Could this be one number instead of a chart?** If yes, use the number. The chart earns its place only when the trend matters more than the value.
3. **Could this be invoked instead of navigated?** If yes, surface it via a contextual action rather than a separate screen the merchant must navigate to.

If any answer is "yes", cut the element until the answer becomes "no."

---

## Vocabulary

Vocabulary is enforced during review by `.claude/agents/vocabulary-auditor.md`. These rules apply to all user-facing copy: JSX text nodes, button labels, headings, placeholders, error messages, toasts, and marketing copy.

### Use in user-facing copy

| Use this | Not this | Notes |
|---|---|---|
| **group** | cohort, segment, audience | "cohort" and "segment" are technical terms that leak internal abstractions into the UI |
| **restored** (in LTV/revenue contexts) | recovered | "LTV restored $47k", "restored revenue". "Recovered" is reserved for discrete order events ("recovered orders") |
| **conversation history** or **customer's history** | customer journey | "journey" is marketing-automation vocabulary |
| the agent, lapsed.ai | personal agent name | No names in operator-facing UI |

### Never use in user-facing copy

- **blast** — implies impersonal bulk sending; undermines the conversation positioning
- **drip** — workflow-builder vocabulary; implies sequences the merchant authors
- **nurture sequence** — same category
- **recovered revenue** (as a headline metric) — use "restored revenue" to reinforce that we restore LTV, not extract from a crisis
- friendly-AI phrasings ("Hey there!", "We'd love...", "You're all set!", "Let's go!") — see tenet 8

### Code exceptions (not violations)

- "segment" is acceptable in server-side adapter code that maps directly to Shopify or Klaviyo segment APIs. It must never surface in UI strings.
- "cohort_id" as a database column name is acceptable as an internal identifier; it must never render in the UI.
- Test descriptions and fixture data do not require vocabulary compliance.
- Code comments and variable names are developer-facing and are not audited.
