# CLAUDE-md-additions-sprint-11.md

Apply these additions to `CLAUDE.md` and `.claude/agents/architecture-guardian.md` during the harness chore commit BEFORE launching Sprint 11. Pattern matches prior sprints (decisions 27-33 added before Sprint 09 kickoff).

---

## Additions to CLAUDE.md

Append these as decisions 34, 35, 36 in the architectural decisions list.

### Decision 34 — Demo mode pattern

Demo mode renders the merchant dashboard against a fixture dataset (`packages/core/src/demo-fixtures/`), not against live DB. Demo routes are public at `/preview` (both `lapsed.ai/preview` marketing entry and `app.lapsed.ai/preview` direct). No demo data ever bleeds into live merchant pages — every authenticated `/app` route shows real data or a real empty state. Demo fixtures are versioned (`demo-fixtures/v{N}.json`) alongside the math; breaking changes to UI layouts require updated fixtures.

Rationale: prospects can preview before installing; the founder/team can review populated screens without seeding real data; sales and onboarding demos work consistently. The strict separation between demo routes and live routes prevents the Sprint 09 walkthrough finding (sidebar badges showing demo counts while pages showed real empty states) from recurring.

### Decision 35 — Vocabulary audit in CI

User-facing strings never contain internal terminology. Internal terms include but are not limited to: sprint names (`Sprint NN`), chunk numbers (`Chunk N`), code identifiers (`arm_id`, `merchant_id`, table names like `attribution_results`, `bandit_state`), and engineering jargon (`posterior`, `holdout`, `cohort`) in user-visible paths. Internal use of these terms in code, tests, comments, and internal docs is unaffected — only user-rendered strings are gated.

A new CI gate (`pnpm grep:vocab`) enforces this with a deny-list scoped to user-facing paths: `apps/web/app/**`, `apps/marketing/app/**`, `packages/ui/**` (rendered components only). The deny-list is maintained in `scripts/vocab-deny-list.json` and reviewed at each sprint kickoff.

Placeholder copy uses confident future-tense when explaining latency or pending state ("Your first scoring run completes within 24 hours" NOT "Pending first score"). The full tone-of-voice guidelines live in `DESIGN-SYSTEM.md` under "Voice & tone".

Rationale: Sprint 11 walkthrough surfaced two CRITICAL leaks ("Attribution in Sprint 08" on dashboard, "Pending — connects in Sprint 05" in settings integrations). Future sprints will inevitably introduce more without a CI gate. The gate is cheap; the embarrassment is expensive.

### Decision 36 — Recommendations engine is deterministic

The AI Insights/Recommendations layer (`packages/core/src/insights-engine.ts`) derives recommendations from existing DB signals (RFM scores, cohort sizes, bandit posteriors, opt-out trends, send-rate, attribution windows, payment status). No new ML models, no LLM calls for recommendation generation. Every recommendation has a stable schema: `id`, `priority` (HIGH/MEDIUM/LOW), `category` (cohort | arm | opt-out | conversation | payment), `signal_metric`, `signal_value`, `threshold`, `merchant_copy` (rendered text), `cta_action` (route + params), `created_at`, `expires_at`, `state` (active | dismissed | acted | snoozed).

Recommendations are evaluated by a scheduled background job (every 6 hours, in vercel.json) and written to a new `insights` table (migration 0011). The table is append-only — state changes write new rows rather than mutating existing ones, preserving full audit history.

Rationale: deterministic recommendations are debuggable (always traceable to a signal + threshold), reproducible (same inputs always yield same outputs), affordable (no LLM tokens per evaluation), and merchant-explainable ("Why was I shown this?" → "Because metric X crossed threshold Y"). LLM-generated recommendations would be opaque, expensive, and impossible to audit at scale. The deterministic constraint also forces clearer product thinking — every recommendation must be defensible as a numeric trigger.

---

## Additions to .claude/agents/architecture-guardian.md

Append these to the existing decision-enumeration block (where decisions 27-33 were added before Sprint 09):

### Sprint 11 additions (decisions 34-36)

**Decision 34 — Demo mode pattern.** Verify:
- `/preview` routes exist at marketing site root and `app.lapsed.ai/preview`
- Demo fixtures imported from `packages/core/src/demo-fixtures/` only
- No code path causes demo data to render on authenticated `/app/*` routes
- `useDemoData()` hook (or equivalent) is the single source of demo data routing
- Demo fixtures versioned in `demo-fixtures/v{N}.json`

Common violations to flag:
- Importing demo fixtures from a non-canonical location
- Conditional rendering of demo data in authenticated routes based on `merchant.has_synced` or similar (this would bleed demo into live)
- Hard-coded demo counts in sidebar badge component
- Demo banner text varying between marketing and app entries (should be consistent)

**Decision 35 — Vocabulary audit in CI.** Verify:
- `pnpm grep:vocab` runs as a CI gate and exits 0
- `scripts/vocab-deny-list.json` exists and contains the required terms
- Deny-list is scoped to user-facing paths only (not full repo)
- New user-facing strings added in any chunk run clean against the deny-list

Common violations to flag:
- New copy added in chunks containing forbidden terms
- Scoping the deny-list too broadly (would gate internal code/tests)
- Bypassing the gate via `// vocab-ignore` comments without justification

**Decision 36 — Recommendations engine is deterministic.** Verify:
- `packages/core/src/insights-engine.ts` contains no imports from `@anthropic-ai/sdk`, `openai`, `langchain`, or any ML/LLM library
- Every recommendation has the full stable schema
- Background job scheduled in vercel.json
- State transitions are append-only (new rows in `insights` table, not UPDATEs)
- Each category has explicit signal + threshold + copy template + CTA mapping

Common violations to flag:
- LLM call sneaking into `insights-engine.ts` for "smarter" recommendation copy
- Mutable updates to existing insights rows
- Missing fields in the recommendation schema
- Recommendation copy hardcoded inline instead of templated against signal values

---

## Harness chore commit sequence

Before launching Sprint 11, apply these in a single chore commit on `main`:

1. Copy `SPRINT-11.md` to `SPRINT.md` (replacing the Sprint 09 spec)
2. Append decisions 34-36 to `CLAUDE.md` (after decision 33)
3. Append the Sprint 11 additions block to `.claude/agents/architecture-guardian.md`
4. Verify `WALKTHROUGH-FINDINGS.md` is on main (should already be)

Commit message:
```
chore(sprint-11): kickoff — add decisions 34-36, replace SPRINT.md, sync architecture-guardian
```

Then launch the build session with the kickoff prompt (separate document).
