# Sprint 06 — AI Campaign Designer + Bandit State + Approval Surface

**Date:** Drafted post-Sprint 05 merge (HEAD: 5c05df1 on main)
**Repo:** lapsed (timbowilcox/lapsed)
**Branch:** `sprint-06/campaign-designer-and-approval-surface`

## Scope

For each scored customer group from Sprint 04, the AI Campaign Designer (Sonnet 4.6) proposes three campaign variants per group. Each variant specifies: target group, offer type, message draft (in the merchant's voice profile from Sprint 05), send-time window, and expected impact estimate. Variants form bandit arms — Thompson sampling state initialized at proposal time. Merchant reviews proposals in a new approval surface; can approve, reject, or edit any variant. Approved proposals become campaign-ready (no sends yet — Sprint 07 ships the actual conversation engine). Holdout assignment happens at proposal creation: 10% of each group is randomly held out, deterministically seeded by `(campaign_id, customer_id)`.

This sprint completes the "from data to approved campaign" half of the v1 product. Sprint 07 takes approved campaigns and actually runs them via SMS.

**Explicitly NOT in scope:**
- Actual SMS sending (Sprint 07 — conversation engine)
- Twilio integration (Sprint 07)
- Two-way conversation handling (Sprint 07)
- Real-time message generation per customer (Sprint 07 — uses voice profile from Sprint 05)
- Opt-out registry consultation (Sprint 07)
- Bandit posterior updates from actual send data (Sprint 07 — requires real responses)
- Attribution reconciliation (Sprint 08)
- Billing/usage metering (Sprint 09)

## Load-bearing architectural decisions (new for this sprint)

These extend CLAUDE.md's 12 decisions. Cumulative count: 15.

**13. Campaign proposals are merchant-approved before any send (Sprint 06).** No auto-launch path exists. Every campaign requires a recorded approval event from the merchant before downstream sending becomes possible. The approval event is the gate Sprint 07's conversation engine queries — if no approval, no send. "Auto-approve after N hours" or similar timer-based escalation is explicitly out of scope and would violate this decision.

**14. Bandit arms are versioned and immutable (Sprint 06).** Once a proposal is approved, the arms it creates cannot be edited in-place. Editing a campaign creates a new proposal version with new arms; the old arms are retained for performance analysis and audit. Mirrors decision 7 (voice profiles versioned).

**15. Group snapshots frozen at proposal creation (Sprint 06).** When a campaign proposal references a group, the customer set is snapshotted (list of customer IDs persisted in `campaign_group_snapshots`) at proposal time. Subsequent changes to the underlying group definition do NOT change which customers receive the campaign. This is essential for attribution math (Sprint 08): incremental revenue is computed against the snapshotted holdout, not a live recompute.

## Acceptance criteria

- [ ] Campaign Designer can propose ≥3 variants per scored customer group (offers/timing/tone diversity enforced at the schema level)
- [ ] Each proposal includes: target group ID + snapshot, offer type (from enum), message draft (uses voice profile), send-time window, expected impact estimate, bandit arm IDs (one per variant)
- [ ] Proposal generation cost capped per merchant per day via `CAMPAIGN_PROPOSAL_DAILY_CAP_DEFAULT` env var (default 5 proposals)
- [ ] PII redaction runs on any customer data passed to Sonnet (groups may contain example customers for context — pre-flight asserts no PII reaches LLM)
- [ ] Group snapshot writes a deterministic list of customer IDs to `campaign_group_snapshots` at proposal time
- [ ] Holdout assignment writes 10% of each group's customers to `campaign_holdouts` table, deterministically seeded by `hash(campaign_id || customer_id)`
- [ ] Approval surface lists pending proposals for a merchant
- [ ] Each proposal can be approved (writes `campaign_approved` event), rejected (writes `campaign_rejected`), or edited (writes `proposal_edited` + new version)
- [ ] Approved proposals are queryable as "ready to launch" for Sprint 07's conversation engine
- [ ] Bandit state initialized at approval with neutral priors (Beta(1,1) per arm)
- [ ] All new tables (`campaign_proposals`, `campaign_arms`, `campaign_group_snapshots`, `campaign_holdouts`, `campaign_events`, `bandit_state`) have merchant-scoped RLS with cross-merchant isolation tests
- [ ] No `campaign_proposed` event ever contains PII (verified via redaction pre-flight test)
- [ ] E2E test: scored group → proposal generated → 3 variants visible → approve one → status flips to ready
- [ ] HANDOFF.md uses evidence-required self-score format

## 13-chunk sequence

### Chunk 1 — Migration `0007_campaign_proposals.sql`

Six new tables with merchant-scoped RLS:
- `campaign_proposals` — proposal record (id, merchant_id, group_id, version_number, status enum, model_version, generated_at, approved_at, approved_by_user_id)
- `campaign_arms` — one per variant per proposal (id, proposal_id, merchant_id, offer_type, message_draft, send_time_window, expected_impact_jsonb, bandit_arm_id)
- `bandit_state` — Thompson sampling parameters per arm (arm_id PK, alpha, beta, last_updated_at, observation_count) — mirrors decision 4
- `campaign_group_snapshots` — frozen customer set per proposal (proposal_id, customer_id, included_in_holdout boolean) — composite PK (proposal_id, customer_id)
- `campaign_holdouts` — convenience view materializing holdout assignments
- `campaign_events` — append-only event log (id, merchant_id, proposal_id, event_type, payload_jsonb, occurred_at). Event types: `campaign_proposed`, `campaign_approved`, `campaign_rejected`, `proposal_edited`, `arms_initialized`

All tables RLS-policed with `auth.jwt() ->> 'merchant_id'` pattern. Append-only triggers on `campaign_events` block UPDATE/DELETE (mirrors decision 12 for voice events).

### Chunk 2 — Group snapshot helper (`packages/core/src/snapshot-group.ts`)

Pure function: `snapshotGroup(merchantId, groupId, customers): { customerIds, holdoutIds }`. Takes the current materialized group from Sprint 04's customer intelligence module. Computes deterministic holdout assignment via `hash(${proposalId}||${customerId}) % 10 === 0` for ~10% rate. Returns both the full customer set and the holdout subset.

Writes to `campaign_group_snapshots` (full set) and marks `included_in_holdout` for the deterministic 10%. Mirrors `appendVoiceEvent` pattern: Zod-validated input, idempotent given same `(proposalId, groupId)`.

### Chunk 3 — Campaign event helpers + materializer (`packages/core/src/campaign-events.ts`)

`appendCampaignEvent(merchantId, event)` — canonical helper, Zod-validated, writes to `campaign_events`. Mirrors `appendVoiceEvent` from Sprint 05.

`materializeCampaign(proposalId)` — replays events for a proposal, returns current state (status, latest version, approval_at, rejection reason if any). Idempotent.

`getReadyCampaigns(merchantId)` — query helper that returns proposals where the latest event is `campaign_approved`. This is the surface Sprint 07's conversation engine consumes.

### Chunk 4 — Bandit state initializer + Thompson sampling math (`packages/core/src/bandit.ts`)

Pure module:
- `initializeBanditArm(armId): BanditState` — writes Beta(1,1) prior to `bandit_state`
- `thompsonSample(arms: BanditState[]): armId` — draws from each arm's Beta posterior, returns the arm with the highest sample
- `updatePosterior(armId, success: boolean)` — placeholder writer for Sprint 07 to call when observations land. Not called during Sprint 06 — but the function exists and is tested with mocked data so Sprint 07 can wire it in cleanly.

Deterministic given a seed (`seed?: number` parameter for tests). 30+ unit tests covering posterior math, deterministic seeding, edge cases (0-observation arms, equal posteriors).

### Chunk 5 — AI Campaign Designer (`packages/core/src/campaign-designer.ts`)

Sonnet 4.6 client with `tool_choice` structured output. Input: merchant ID, group ID, voice profile (from `voice_versions`), summary of group customers (RFM/lifecycle counts only, NO PII — PII redaction asserts this pre-flight). Output: structured `CampaignProposal` with 3 variants.

Schema:
```typescript
const CampaignProposalSchema = {
  name: "propose_campaign",
  input_schema: {
    type: "object",
    required: ["variants"],
    properties: {
      variants: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          required: ["offer_type", "offer_value", "message_draft", "send_time_window", "tone", "expected_impact"],
          properties: {
            offer_type: { enum: OFFER_TYPE_TAXONOMY },        // ~8 values: percent_discount, free_shipping, bundle, exclusive_access, etc.
            offer_value: { type: "string" },                   // e.g., "10%", "Free over $50"
            message_draft: { type: "string", maxLength: 160 }, // SMS-friendly
            send_time_window: { enum: SEND_TIME_WINDOWS },     // morning, midday, evening, weekend_morning, weekend_evening
            tone: { enum: TONE_TAXONOMY },                     // matches voice profile taxonomy from Sprint 05
            expected_impact: {
              type: "object",
              required: ["estimated_response_rate", "estimated_recovered_revenue"],
              properties: {
                estimated_response_rate: { type: "number", minimum: 0, maximum: 1 },
                estimated_recovered_revenue: { type: "number", minimum: 0 }
              }
            }
          }
        }
      }
    }
  }
}
```

Retries up to 3 times on schema validation failure; accumulates token usage; mocked tests only.

### Chunk 6 — Campaign proposal orchestrator (`packages/core/src/propose-campaign.ts`)

End-to-end orchestrator. Mirrors Sprint 05's `run-voice-extraction.ts` pattern:

1. Pre-flight: daily cap check, voice profile presence check, group existence check
2. Write `proposal_started` event
3. Fetch voice profile, group customers, voice taxonomy
4. PII redaction pre-flight on the LLM input
5. Call campaign designer (Sonnet 4.6)
6. Write `campaign_proposed` event with full proposal payload
7. Snapshot group + assign holdouts
8. Initialize bandit arms (Beta(1,1) priors) for each variant
9. Write `arms_initialized` event

Cap exhaustion writes `proposal_failed` event with `reason: "daily_cap_exhausted"`. Integration test covers full happy path with mocked Sonnet.

### Chunk 7 — Approval state machine + query helpers (`packages/db/src/queries.ts` additions)

**⚠️ Mid-sprint checkpoint evaluator runs after this chunk lands. See CLAUDE.md → Mid-sprint checkpoint protocol.**

Query helpers:
- `getPendingProposals(merchantId)` — proposals where latest event is `campaign_proposed` or `proposal_edited` (no approval/rejection yet)
- `getProposalById(merchantId, proposalId)` — full proposal detail with variants + bandit state + group snapshot count + holdout count
- `getCampaignStatus(proposalId)` — derives current status from latest event: `proposed | approved | rejected | edited`

Approval functions:
- `approveProposal(merchantId, proposalId, userId)` — writes `campaign_approved` event; idempotent (subsequent calls noop with same actor)
- `rejectProposal(merchantId, proposalId, userId, reason)` — writes `campaign_rejected` event with reason text
- `editProposal(merchantId, proposalId, userId, edits)` — writes `proposal_edited` event with diff payload, increments version_number

All functions enforce merchant tenancy via RLS.

### Chunk 8 — Approval API routes (`apps/web/app/api/campaigns/`)

Three routes:
- `GET /api/campaigns/pending` — pending proposals for current merchant
- `GET /api/campaigns/[id]` — full proposal detail
- `POST /api/campaigns/[id]/approve` — body `{ userId }`, returns updated status
- `POST /api/campaigns/[id]/reject` — body `{ userId, reason }`, returns updated status  
- `POST /api/campaigns/[id]/edit` — body `{ userId, edits }`, returns new version

Bearer auth via merchant session token. Cross-merchant access returns 404 (not 403, to avoid leaking existence).

### Chunk 9 — Approval surface UI (`apps/web/app/app/campaigns/page.tsx` + components)

Three sections per the approval flow:
1. **Pending review** — list of proposals awaiting decision, sorted by `generated_at` desc. Each card shows: target group name, customer count, holdout count, 3 variant summaries (offer type + send window + tone chips), expected impact range. Click → detail view.
2. **Detail view** — opens drawer/page showing all 3 variants side-by-side. For each variant: full message draft (with character count), tone descriptors as chips, signature phrase usage, expected impact (response rate + revenue). Three actions per proposal: **Approve all**, **Reject all**, **Edit** (opens editor).
3. **Editor** — inline edits to any variant's message draft (max 160 chars), offer value, send time window. Tone and offer type are read-only (those came from the AI's structural choices). On save: writes `proposal_edited` event + new version, returns to pending list.

WCAG 2.2 AA via axe. Vellum tokens only (no hex bypasses). Vocabulary compliance enforced.

### Chunk 10 — Campaign list / dashboard surface

Single page at `apps/web/app/app/campaigns/list/page.tsx`:
- Tabs: **Pending review** (default), **Approved** (ready for Sprint 07), **Rejected**, **All**
- Each campaign card: status badge, target group, variant count, approval date if approved, rejection reason if rejected
- Search by group name; filter by status

This surface is what merchants see day-to-day after Sprint 06 ships and before Sprint 07's conversation engine starts running campaigns.

### Chunk 11 — Bandit state inspector (`apps/web/app/app/campaigns/[id]/bandit/page.tsx`)

Per-proposal view of the bandit arms initialized for an approved campaign. Each arm:
- Alpha + Beta posterior parameters
- Mean response rate prior (Beta(α,β) mean = α / (α+β))
- 95% credible interval
- Observation count (always 0 for Sprint 06 — no real data yet)
- Last updated timestamp

Read-only in Sprint 06. Sprint 07 will populate observations and update posteriors.

This surface validates decision 4 (bandit state is first-class data) — merchants can see the bandit math, not just the marketing-speak.

### Chunk 12 — E2E test (`apps/web/e2e/campaign-approval.spec.ts`)

Playwright: seed a scored customer group → trigger campaign proposal → assert 3 variants generated → navigate to approval surface → approve one proposal → assert it appears in "Approved" tab → assert bandit arms initialized in inspector → assert `getReadyCampaigns(merchantId)` returns the approved proposal.

Plus failure path: cap exhaustion test asserts 429 + clear merchant-facing error message.

### Chunk 13 — HANDOFF.md with evidence-required self-scores

Same format as Sprint 05 chunk 13. Every rubric self-score must include:
- Primary file path:line range
- Test file path:line range
- Number of test cases
- Named assertion(s) that prove the criterion is met

Self-scores without all three are treated as 0/3 by the final evaluator.

## Quality rubric (10 criteria — score each 0–3)

| # | Criterion | What 3/3 looks like |
|---|---|---|
| 1 | **Campaign proposal versioning purity** | New version row per edit; prior versions retained; status derivation is event-sourced; idempotency tests pass |
| 2 | **Bandit arm immutability** | Arms never UPDATE'd post-approval; editing = new proposal version with new arms; pre-existing arms retained |
| 3 | **Thompson sampling correctness** | Deterministic given seed; 30+ unit tests covering posterior math; equal-posterior tie-break documented |
| 4 | **AI Campaign Designer structured output** | `tool_choice` with strict schema; minItems=3 maxItems=3 enforced; retry up to 3 attempts; token accumulation; mocked tests only |
| 5 | **Cost discipline** | `CAMPAIGN_PROPOSAL_DAILY_CAP_DEFAULT` env var wired through env.ts + turbo.json + vercel-env-check; cap-exhaustion writes structured log + event |
| 6 | **PII redaction** | Pre-flight test asserts no PII reaches Sonnet during proposal generation; assertNoPii at orchestrator boundary; redactor reused from Sprint 05 |
| 7 | **RLS tenancy isolation** | All 6 new tables have merchant-scoped policies; cross-merchant access tests pass; cross-merchant proposal access returns 404 not 403 |
| 8 | **Approval flow correctness** | No campaign is "ready" without recorded approval event; idempotent approve; reject + edit paths tested; getReadyCampaigns excludes rejected/edited-without-reapproval |
| 9 | **Group snapshot integrity** | Customer set frozen at proposal time; subsequent group changes do not affect proposal customer list; holdout assignment deterministic and tested for ~10% rate |
| 10 | **Observability + evidence-required HANDOFF** | Structured logs at every phase; spec-adherence-auditor dispatched per chunk; mid-sprint checkpoint ran and APPROVED at chunk 7; evidence-required self-scores in HANDOFF |

## Required environment variables

| Variable | Default | Notes |
|---|---|---|
| `CAMPAIGN_PROPOSAL_DAILY_CAP_DEFAULT` | `5` | Proposals per merchant per UTC day |
| `HOLDOUT_RATE` | `0.1` | Fraction of each group held out per campaign |
| Existing: `SONNET_MODEL`, `ANTHROPIC_API_KEY` | — | Reused from Sprint 05 |

Add to: `apps/web/app/lib/env.ts`, `turbo.json` env array, `scripts/vercel-env-check.mjs`. Surface manual Vercel UI action in HANDOFF.

## Definition of Done

- [ ] All 13 chunks landed as commits
- [ ] All 10 rubric criteria scored 3/3 with evidence (file:line refs in HANDOFF)
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0 (RLS tests skip cleanly if `SUPABASE_AVAILABLE=false`)
- [ ] `pnpm build` exits 0 for all 3 apps
- [ ] `pnpm grep:pii` exits 0
- [ ] `pnpm vercel:env:check` exits 0
- [ ] No architecture-guardian violations (now enumerating all 15 decisions after this sprint's harness chore)
- [ ] No code-reviewer Critical or High findings
- [ ] No spec-adherence-auditor gaps
- [ ] Mid-sprint checkpoint evaluator returned APPROVE at chunk 7
- [ ] Final evaluator returned APPROVE (or REMEDIATE with only Medium/Low items → BACKLOG.md)
- [ ] HANDOFF.md committed using evidence-required self-score format
- [ ] PR open against `main`

## Out of scope

- Actual SMS sending (Sprint 07)
- Twilio integration (Sprint 07)
- Two-way conversation handling (Sprint 07)
- Real-time per-customer message generation (Sprint 07 — uses voice profile + selected bandit arm)
- Opt-out registry consultation (Sprint 07)
- Bandit posterior UPDATES from real observations (Sprint 07)
- Attribution reconciliation against Shopify orders (Sprint 08)
- Performance/incremental revenue math (Sprint 08)
- Stripe billing on incremental revenue (Sprint 09)
- Auto-approval / timer-based escalation (explicitly excluded — violates decision 13)
- Multi-step / multi-message campaigns (v2 — Sprint 06 is single-touch)
- Email channel campaigns (post-v1)
