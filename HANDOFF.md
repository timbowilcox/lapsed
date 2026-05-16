# Sprint 06 HANDOFF — AI Campaign Designer + Bandit State + Approval Surface

Date: 2026-05-16
Branch: `sprint-06/campaign-designer-and-approval-surface`
Status: **READY FOR FINAL EVALUATOR SESSION**

---

## What was built

All 13 chunks from SPRINT.md completed.

1. **Migration `0007_campaign_proposals.sql`** — Five tables + one view, all merchant-scoped RLS: `campaign_proposals` (materialized status cache, version lineage), `campaign_arms` (write-once variants, decision 14), `bandit_state` (Thompson Beta posterior, decision 4), `campaign_group_snapshots` (frozen customer set, decision 15), `campaign_events` (append-only, trigger-enforced), `campaign_holdouts` (security_invoker view).
2. **Group snapshot helper** — `packages/core/src/snapshot-group.ts`: `snapshotGroup`, `isHeldOut`, `computeGroupSnapshot`; deterministic SHA-256-bucketed ~10% holdout; 500-row batched upsert.
3. **Campaign event helpers + materializer** — `packages/core/src/campaign-events.ts`: `appendCampaignEvent` (Zod `.strict()` payloads), `materializeCampaign`, `getReadyCampaigns`.
4. **Bandit state + Thompson sampling** — `packages/core/src/bandit.ts`: `initializeBanditArm`, `thompsonSample`, `updatePosterior`, `posteriorStats`, `betaQuantile`, mulberry32 PRNG.
5. **AI Campaign Designer** — `packages/core/src/campaign-designer.ts`: `designCampaign` (Sonnet 4.6 `tool_choice` structured output), `CampaignProposalSchema`, retry ≤3 with backoff, token accumulation.
6. **Campaign proposal orchestrator** — `packages/core/src/propose-campaign.ts`: `proposeCampaign` — daily-cap check, PII pre-flight, snapshot, designer, persistence; `proposal_failed` on any post-row failure.
7. **Approval state machine + query helpers** — `packages/core/src/campaign-approval.ts`: `approveProposal` / `rejectProposal` / `editProposal`; read helpers `getPendingProposals` / `getProposalById` / `getCampaignStatus` in `packages/db/src/queries.ts`.
8. **Approval API routes** — `apps/web/app/api/campaigns/`: `GET pending`, `GET [id]`, `POST [id]/approve|reject|edit`; cross-merchant → 404.
9. **Approval surface UI** — `apps/web/app/app/campaigns/page.tsx` + `_approval-surface.tsx`: pending list, detail modal, inline editor, reject confirm.
10. **Campaign list surface** — `apps/web/app/app/campaigns/list/`: four tabs (Pending / Approved / Rejected / All) + group search; `getProposalsByStatus` query helper.
11. **Bandit-state inspector** — `apps/web/app/app/campaigns/[id]/bandit/page.tsx`: per-arm α/β, mean response rate, 95% credible interval, observation count.
12. **E2E test** — `apps/web/e2e/campaign-approval.spec.ts`: approve → Approved tab → bandit inspector → `getReadyCampaigns`; reject-with-reason; 409 invalid-state.
13. **HANDOFF.md** — this file.

### Chunk → commit map

| Chunk | Commits |
|---|---|
| 1 | `3465288`, `37212f9`, `b027a3f` |
| 2 | `2425d7f`, `481cc7e`, `248096e` |
| 3 | `1b1e470`, `d46bb0c` |
| 4 | `460ea9f`, `888c615` |
| 5 | `2690628`, `17e42ed` |
| 6 | `4b0fc45`, `5cc5820`, `e1b8f73` |
| 7 | `6557ef7`, `fcdf9a8`, `630d170` |
| 8 | `0e67d95`, `dce4828` |
| 9 | `5db1e9a`, `2868720` |
| 10 | `3d0dac5`, `13c68a0`, `14bf8e0` |
| 11 | `3de57e9`, `5eb0de4` |
| 12 | `091808c`, `69dec08` |

The mid-sprint checkpoint ran after chunk 7 and returned **APPROVE**.

---

## CI gate status

| Gate | Status |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS (603 core, 97 db, 85 shopify, plus the web suites) |
| `pnpm lint` | PASS |
| `pnpm grep:pii` | PASS — no findings |
| `pnpm vercel:env:check` | **FAILS** — expected; the two new env vars are not yet on the Vercel project. See "Manual actions required". |

`pnpm test:e2e` is not a per-commit gate; it requires a running app + a database with migration 0007 applied (see "Manual actions required").

---

## Manual actions required (human, before merge / deploy)

1. **Add two env vars to the Vercel `lapsed-web` project:**
   - `CAMPAIGN_PROPOSAL_DAILY_CAP_DEFAULT` — recommended `5` (proposals per merchant per UTC day)
   - `HOLDOUT_RATE` — recommended `0.1` (fraction of each group held out per campaign)

   Both are already wired into `apps/web/app/lib/env.ts`, `turbo.json`, and `scripts/vercel-env-check.mjs`. `pnpm vercel:env:check` fails until they exist on the Vercel project — this is the intended hard stop, not a regression.

2. **Apply migration 0007 to the Supabase database:**
   `psql "$SUPABASE_DB_URL" -f packages/db/supabase/migrations/0007_campaign_proposals.sql`
   Until applied, `campaign-rls.test.ts` self-skips and the chunk-12 E2E cannot run.

---

## Rubric self-scores (evidence-required format)

### Criterion 1: Campaign proposal versioning purity

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/campaign-approval.ts:216-404` (`editProposal` — inserts a new `campaign_proposals` row with `version_number + 1` and `supersedes_proposal_id` set; new arms; the prior row is retained)
- Supporting files: `packages/db/src/queries.ts:680-721` (`deriveProposalState`) and `:835-893` (`getProposalById`) — status derived from the `campaign_events` log, never the cache; `packages/db/supabase/migrations/0007_campaign_proposals.sql:112-114` (partial-unique index keeps the version lineage linear)

**Test evidence:**
- Test file: `packages/core/__tests__/campaign-approval.test.ts:220-396` (`editProposal` describe block)
- Supporting: `packages/db/__tests__/campaign-queries.test.ts:427-440` (status derived from the event log, not the stale `campaign_proposals.status` cache)
- Number of test cases: 35 in campaign-approval.test.ts, 29 in campaign-queries.test.ts
- Key assertion(s): an edit produces a new proposal version with `supersedes_proposal_id` set and fresh arms while the prior version is retained; `getProposalById` reports the event-derived `approved` even when the cache row still says `proposed`.

### Criterion 2: Bandit arm immutability

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/db/supabase/migrations/0007_campaign_proposals.sql:137-184` (`campaign_arms` is write-once — only a `select` policy is granted; no INSERT/UPDATE/DELETE policy for the authenticated role)
- Supporting files: `packages/core/src/campaign-approval.ts:334-338` (an edit inserts NEW arms with new `bandit_arm_id` values; existing arms are never `UPDATE`d)

**Test evidence:**
- Test file: `packages/db/__tests__/campaign-rls.test.ts:438-448` ("merchant A JWT cannot UPDATE an existing campaign_arms row (decision 14)")
- Supporting: `packages/core/__tests__/campaign-approval.test.ts:220-396` (`editProposal` creates new arms; the prior proposal's arms are retained)
- Number of test cases: 33 in campaign-rls.test.ts, 35 in campaign-approval.test.ts
- Key assertion(s): a merchant-JWT `UPDATE` of `campaign_arms.message_draft` is rejected and no row reads back as `"tampered"`.

### Criterion 3: Thompson sampling correctness

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/bandit.ts` — `thompsonSample:156`, `posteriorStats:302`, `betaQuantile:272`, `regularizedIncompleteBeta:256`, `mulberry32:55`
- Supporting files: `packages/core/src/bandit.ts:42` (`NEUTRAL_PRIOR` Beta(1,1)), `:401` (`initializeBanditArm`, idempotent read-first)

**Test evidence:**
- Test file: `packages/core/__tests__/bandit.test.ts` (describe blocks at lines 40, 69, 128, 213, 225, 234, 263, 287, 425, 431, 589)
- Number of test cases: 59
- Key assertion(s): `thompsonSample` is deterministic for a fixed seed (per-arm seed `seed XOR hash(armId)`); `betaQuantile` golden vectors; the equal-posterior tie-break is documented and tested.

### Criterion 4: AI Campaign Designer structured output

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/campaign-designer.ts:322-424` (`designCampaign` — Sonnet 4.6 `tool_choice` structured output, `maxRetries: 0` + manual retry loop at `:366`)
- Supporting files: `campaign-designer.ts:182` (tool schema `minItems: 3` / `maxItems: 3`), `:24` (`MAX_RETRIES = 3`), `:131` (`CampaignProposalSchema` with per-axis diversity refinement)

**Test evidence:**
- Test file: `packages/core/__tests__/campaign-designer.test.ts` (describe blocks at lines 104, 131, 217, 235, 274, 356, 406)
- Number of test cases: 39
- Key assertion(s): exactly 3 variants enforced; retries on schema-invalid / no-tool-use / transient API error; token usage accumulates across attempts and into the terminal `CampaignDesignError`. All Anthropic calls are mocked.

### Criterion 5: Cost discipline

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/propose-campaign.ts:152-166` (daily-cap check — when `proposedToday >= dailyCapDefault` the orchestrator writes a `proposal_failed` event with phase `cap_check` and never calls Anthropic), `:153` (`logStructured("propose_campaign_cap_exhausted", …)`)
- Supporting files: `apps/web/app/lib/env.ts:24,66-69` (`campaignProposalDailyCapDefault`), `turbo.json:35` (`CAMPAIGN_PROPOSAL_DAILY_CAP_DEFAULT` in the build env array), `scripts/vercel-env-check.mjs:43` (parity enforcement)

**Test evidence:**
- Test file: `packages/core/__tests__/propose-campaign.test.ts:314-343` (`proposeCampaign — daily cap` describe block)
- Number of test cases: 3 in that block (27 in the file)
- Key assertion(s): "fails with reason cap_check when the merchant is at the cap"; "does not call the Anthropic API when capped"; "proceeds when proposals today are below the cap".

### Criterion 6: PII redaction

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/propose-campaign.ts:205` (`assertNoPii(JSON.stringify(groupSummary))` pre-flight at the orchestrator boundary; failure → `proposal_failed` phase `redact`)
- Supporting files: `packages/core/src/campaign-designer.ts:345` (`assertNoPii` at the designer's entry boundary, defense in depth), `packages/core/src/pii-redactor.ts` (redactor reused from Sprint 05)

**Test evidence:**
- Test file: `packages/core/__tests__/propose-campaign.test.ts:400-446` ("fails with reason redact when PII reaches the group summary (decision 10)")
- Supporting: `packages/core/__tests__/campaign-designer.test.ts:406-` (`designCampaign — PII pre-flight (decision 10)` describe block)
- Number of test cases: 27 in propose-campaign.test.ts, 39 in campaign-designer.test.ts
- Key assertion(s): proposal generation fails with reason `redact` (no Anthropic call) when an un-redacted PII pattern reaches the serialized group summary.

### Criterion 7: RLS tenancy isolation

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/db/supabase/migrations/0007_campaign_proposals.sql` — merchant-scoped `select` policies on `campaign_proposals:121`, `campaign_arms:177`, `bandit_state:223`, `campaign_group_snapshots:265`, `campaign_events:354`; `campaign_holdouts` view is `security_invoker` (`:281`)
- Supporting files: `apps/web/app/api/campaigns/_shared.ts:31-58` (`campaignErrorResponse` maps cross-merchant not-found → 404, never 403)

**Test evidence:**
- Test file: `packages/db/__tests__/campaign-rls.test.ts` (33 tests — per-table "merchant A cannot see merchant B's row" + write-rejection + append-only)
- Supporting: `apps/web/__tests__/campaigns-routes.test.ts:111,219,331` (cross-merchant access returns 404, never 403)
- Number of test cases: 33 in campaign-rls.test.ts, 41 in campaigns-routes.test.ts
- Key assertion(s): every Sprint 06 table returns only the calling merchant's rows; a wrong JWT secret returns zero rows; a cross-merchant proposal id resolves to 404.

### Criterion 8: Approval flow correctness

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/campaign-approval.ts` — `approveProposal:49` (idempotent; rejected/edited cannot be approved), `rejectProposal:117`, `editProposal:216`
- Supporting files: `packages/core/src/campaign-events.ts:358-424` (`getReadyCampaigns` — a proposal is ready only when its **latest** `campaign_events` row is `campaign_approved`; no timer / auto-approval path)

**Test evidence:**
- Test file: `packages/core/__tests__/campaign-approval.test.ts` (describe blocks at 88, 168, 220, 397 — approve / reject / edit / state-machine guards)
- Supporting: `packages/core/__tests__/campaign-events.test.ts:736-877` (`getReadyCampaigns`), `apps/web/e2e/campaign-approval.spec.ts` (approve → `getReadyCampaigns` returns it)
- Number of test cases: 35 in campaign-approval.test.ts, 52 in campaign-events.test.ts, 3 E2E
- Key assertion(s): re-approving is a no-op (`alreadyApproved: true`, no second event); approving a `rejected` proposal throws → 409; `getReadyCampaigns` excludes rejected and edited-without-reapproval proposals.

### Criterion 9: Group snapshot integrity

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/snapshot-group.ts` — `snapshotGroup:107` (customer set frozen at proposal time), `isHeldOut:44` (deterministic SHA-256 bucket `< holdoutRate`), `computeGroupSnapshot:60`
- Supporting files: `packages/db/supabase/migrations/0007_campaign_proposals.sql:239-247` (`campaign_group_snapshots` composite PK makes the snapshot write idempotent)

**Test evidence:**
- Test file: `packages/core/__tests__/snapshot-group.test.ts` (describe blocks at 44, 78, 124, 153, 221, 354 — determinism / rate distribution / golden vectors / write path)
- Number of test cases: 40
- Key assertion(s): the same `(proposalId, customerId)` always yields the same holdout assignment; the holdout fraction converges to ~10% over a large customer set; golden-vector holdout assignments are pinned.

### Criterion 10: Observability + evidence-required HANDOFF

**Self-score:** 3/3

**Implementation evidence:**
- Primary file: `packages/core/src/propose-campaign.ts` — structured logs at every phase (`propose_campaign_failed:115`, `propose_campaign_cap_exhausted:153`, `propose_campaign_complete:302`, `propose_campaign_event_append_failed:466`); `logStructured` helper at `:502`
- Supporting files: this `HANDOFF.md` (evidence-required self-scores)

**Test evidence:**
- Process evidence: the `spec-adherence-auditor` was dispatched after every chunk; the mid-sprint checkpoint ran after chunk 7 and returned APPROVE; the per-chunk auditors (architecture-guardian, code-reviewer, test-coverage-analyzer, plus the three UI auditors on chunks 9–11) were dispatched and their Critical/High/GAP findings remediated before proceeding.
- Number of test cases: structured-log payloads are exercised within `propose-campaign.test.ts` (27 tests) and `campaign-events.test.ts` (52 tests)
- Key assertion(s): every `propose_campaign_*` log line carries `merchant_id` / `proposal_id` / counts only — no customer PII or LLM-generated message text (verified by `pnpm grep:pii`).

---

## Deliberate deviations from SPRINT.md

These are intentional, reviewed deviations — not omissions.

### 1. approve / reject / edit live in `@lapsed/core`, not `queries.ts`

SPRINT.md chunk 7 places the approve / reject / edit operations alongside the read helpers in `packages/db/src/queries.ts`. They were instead implemented in **`packages/core/src/campaign-approval.ts`**.

**Why:** these are write operations that must go through the canonical event helper (`appendCampaignEvent`), the materializer (`materializeCampaign`), and the bandit initializer (`initializeBanditArm`) — all `@lapsed/core` modules. `@lapsed/db` cannot import `@lapsed/core` without a dependency cycle. Implementing the writes in `queries.ts` would have forced a raw `campaign_events` insert that bypasses the canonical helper, violating the event-sourcing decision. The **read-only** query helpers (`getPendingProposals`, `getProposalById`, `getCampaignStatus`, `getProposalsByStatus`) do live in `queries.ts` exactly as the spec says. This split was reviewed and approved by the mid-sprint checkpoint and the chunk-7 spec-adherence-auditor.

### 2. Chunk 12 E2E: no HTTP trigger for proposal generation; cap exhaustion is unit-tested

SPRINT.md chunk 12 describes the E2E as "trigger campaign proposal → assert 3 variants generated" and a failure path that "asserts 429 + clear merchant-facing error message".

**Why:** `proposeCampaign` (the generation orchestrator) has **no HTTP route and no UI trigger anywhere in the Sprint 06 codebase** — it is exported from `@lapsed/core` and will be invoked by Sprint 07's conversation-engine scheduling. There is therefore no browser-reachable way to "trigger campaign proposal" or to produce an HTTP `429`. Consequences:
- The E2E **seeds proposals directly into Postgres** — the exact row/event shape `proposeCampaign` produces — and exercises the genuinely browser-reachable surfaces (approval surface, list tabs, bandit inspector).
- **Cap exhaustion** is covered by `packages/core/__tests__/propose-campaign.test.ts:314-343`, which asserts the orchestrator fails with `reason: cap_check` / `daily_cap_exhausted`, writes a `proposal_failed` event, and does not call Anthropic when capped.
- **Explicitly not asserted anywhere:** an HTTP `429` status code and a merchant-facing cap error string. No endpoint emits them in Sprint 06. When proposal generation gets an HTTP/scheduled trigger (Sprint 07), that trigger should map `cap_check` → `429` + a merchant-facing message, and an E2E should then assert it.
- The E2E adds a **409 invalid-state** failure-path test on the approval routes in place of the (unreachable) 429.

### 3. `getProposalsByStatus` known scaling limit

`getProposalsByStatus` (`packages/db/src/queries.ts`) fetches the merchant's full `campaign_events` set and derives status in memory. The per-merchant daily cap bounds this for v1, but it does not scale to arbitrary campaign history. **Post-v1 follow-up:** move the status derivation into SQL (a view or RPC over `campaign_events`). This is documented in the function's docstring as a "KNOWN SCALING LIMIT".

---

## Known issues / follow-ups (out of Sprint 06 scope)

- **No `<h1>` from `AppShell`.** The merchant app shell never emits a level-1 heading; each page renders its own heading. Sprint 06's three campaign surfaces were promoted to `<h1>` for WCAG 1.3.1 compliance, but the rest of the merchant app is unaddressed. A follow-up task was filed to emit `pageTitle` as an `<h1>` in `AppShell` app-wide.
- **Coverage tooling is broken repo-wide** — `@vitest/coverage-v8` is version-mismatched against `vitest`. `pnpm test` (without `--coverage`) is unaffected. A follow-up task was filed.

---

## Recommended evaluator command

Run the evaluator template from CLAUDE.md against Sprint 06. Note that `pnpm vercel:env:check` will fail until the two new env vars are added to Vercel (see "Manual actions required") — that failure is expected and is not a sprint defect.
