# Sprint 07 — Conversation Engine (SMS sends, two-way handling, bandit posterior updates)

**Date:** Drafted post-Sprint 06 merge
**Repo:** lapsed (timbowilcox/lapsed)
**Branch:** `sprint-07/conversation-engine`

## Scope

Sprint 07 turns approved campaign proposals into actual SMS conversations and closes the bandit learning loop. The merchant has approved campaigns sitting in `getReadyCampaigns()` from Sprint 06 — this sprint launches them. A campaign cron Thompson-samples a bandit arm per (campaign, customer) pair, sends the variant's message draft via Twilio (filtered through the opt-out registry), and records the outbound in `message_events`. When a customer replies, Twilio webhooks the inbound to our `/api/sms/inbound` route, which synchronously: validates the Twilio signature, classifies the reply sentiment with Sonnet, generates a contextual reply in the merchant's brand voice (Sprint 05's voice profile), and responds via TwiML. Positive/purchase-intent replies fire bandit posterior updates. STOP keywords (and Sonnet-detected opt-out intent) hit both our `customer_opt_outs` table and Twilio's built-in opt-out tracking.

This sprint completes the second half of the v1 product. Sprint 06 closed "from data to approved campaign." Sprint 07 closes "from approved campaign to running conversation."

**Explicitly NOT in scope:**
- Attribution reconciliation against Shopify orders (Sprint 08)
- LTV restoration calculation (Sprint 08)
- Holdout-vs-treated revenue lift math (Sprint 08)
- Stripe billing on incremental revenue (Sprint 09)
- Multi-step / multi-message campaign sequences (v2 — Sprint 07 is single-touch + reply)
- Email channel (post-v1)
- WhatsApp, iMessage, voice/IVR (post-v1)
- Human handoff to live merchant agent (v2)
- Inbound message classification beyond sentiment + opt-out intent (v2)
- Group-level conversation aggregation (Sprint 08 dashboards)

## Load-bearing architectural decisions (new for this sprint)

These extend CLAUDE.md's 15 decisions. Cumulative count after Sprint 07: **19**.

**16. Conversations are per-customer, not per-campaign (Sprint 07).** A customer in multiple campaigns generates ONE conversation thread, not one per campaign. The `conversations` table is keyed by `(merchant_id, customer_id)`. Messages reference both `conversation_id` (which thread they belong to) and an optional `campaign_id` + `arm_id` (which campaign drove the outbound). Inbound replies attach to the conversation, with their bandit posterior update routed to the most recent outbound's arm. Rationale: customers experience a single relationship with the merchant, not a thread per marketing campaign. Cross-campaign context is preserved.

**17. Inbound webhook is synchronous (Sprint 07).** The `/api/sms/inbound` route generates the reply in-band and returns it as TwiML in the webhook response. No queue, no async worker. Latency budget: 5 seconds p99 from Twilio's POST to our TwiML response. If Sonnet hasn't returned by 4 seconds, the route returns a safe fallback ("Thanks — we'll get back to you shortly.") and queues a follow-up generation for the next cron tick. Twilio's webhook timeout is 15 seconds; our budget is conservative. Rationale: synchronous keeps the conversation feeling immediate and avoids the operational complexity of a queue + worker for v1.

**18. Opt-outs are immutable and dual-recorded (Sprint 07).** When a customer opts out (STOP keyword, Sonnet-detected opt-out intent, or merchant manually marks): the opt-out is written to `customer_opt_outs` (append-only, event-sourced) AND Twilio's built-in opt-out tracking is updated. Once opted out, no campaign cron path can ever include that customer again — `assertNotOptedOut` is a mandatory pre-flight before every outbound send, similar to `assertNoPii` in Sprint 05's voice pipeline. Re-engagement requires a fresh customer-initiated message; we never "expire" an opt-out. Rationale: Spam Act compliance (AU), TCPA (US), GDPR (EU) all converge on immediate-and-permanent opt-out semantics. Defense in depth: our table is the application source of truth, Twilio's tracking is the safety net.

**19. Bandit posterior updates fire on sentiment-classified positive intent (Sprint 07).** When an inbound reply is classified by Sonnet as positive sentiment + (purchase intent OR engagement intent), the bandit arm that sourced the outbound message gets `updatePosterior(armId, success=true)`. Negative/neutral/opt-out replies fire `updatePosterior(armId, success=false)`. No-reply (after 7 days) also fires `success=false` via a daily cron. The "real" success signal (completed Shopify order within 14 days) is Sprint 08 territory and will adjust posteriors retroactively. Rationale: sentiment is fast enough for bandit convergence within a campaign cycle; order completion is slow but ground truth — Sprint 08 reconciles the two.

## Acceptance criteria

- [ ] Campaign launcher cron picks up `getReadyCampaigns(merchantId)` proposals and Thompson-samples one bandit arm per customer per proposal
- [ ] Every outbound send pre-flights `assertNotOptedOut(merchantId, customerId)` — opted-out customers are silently excluded (logged, no send)
- [ ] Outbound messages send via Twilio API and record `message_sent` event with twilio_sid, campaign_id, arm_id, body, conversation_id
- [ ] Inbound webhook validates Twilio signature; tampered requests return 403 without further processing
- [ ] Inbound webhook responds within 5s p99 (latency budget enforced via timeout + fallback)
- [ ] Sonnet classifies every inbound reply: `{sentiment: positive|neutral|negative, intent: engagement|purchase|question|complaint|opt_out|other}`
- [ ] Opt-out intent (Sonnet) OR STOP/UNSUBSCRIBE/REMOVE keyword writes to `customer_opt_outs` AND calls Twilio's opt-out API
- [ ] Reply generator (Sonnet) uses voice profile from Sprint 05's active `voice_versions` row + conversation history (last 10 messages) for context
- [ ] Generated replies pass PII redaction pre-flight before send (extends Sprint 05 pattern)
- [ ] Bandit `updatePosterior(armId, success)` fires on every classified inbound: positive+engagement/purchase → success=true; everything else → success=false
- [ ] No-reply daily cron fires `updatePosterior(armId, false)` for outbounds 7+ days old with no inbound on the conversation
- [ ] Conversation UI lists conversations per merchant, full thread view per customer, sentiment tags on inbounds, bandit arm context on outbounds
- [ ] All 4 new tables (`conversations`, `messages`, `message_events`, `customer_opt_outs`) have merchant-scoped RLS with cross-merchant isolation tests
- [ ] E2E test: approved campaign → cron launches → outbound recorded → mock inbound webhook → reply generates → bandit posterior updates
- [ ] HANDOFF.md uses evidence-required self-score format

## 13-chunk sequence

### Chunk 1 — Migration `0008_conversation_engine.sql`

Four new tables + helper indexes:
- `conversations` — `(merchant_id, customer_id) PK`, opened_at, last_message_at, last_inbound_at, message_count
- `messages` — id, conversation_id, direction (`inbound`|`outbound`), body, twilio_sid, campaign_id (FK, nullable), arm_id (FK, nullable), sent_at, status (`pending`|`sent`|`delivered`|`failed`), pii_redacted_body (server-side for logs)
- `message_events` — append-only event log (id, merchant_id, conversation_id, message_id, event_type, payload_jsonb, occurred_at). Event types: `message_outbound_queued`, `message_outbound_sent`, `message_outbound_failed`, `message_inbound_received`, `inbound_classified`, `reply_generated`, `reply_sent`, `opt_out_recorded`, `posterior_updated`. Append-only triggers (reuse `prevent_event_mutation()` from migration 0002).
- `customer_opt_outs` — append-only opt-out registry: customer_id, phone_number, opted_out_at, source (`stop_keyword`|`sonnet_classified`|`merchant_manual`|`twilio_native`), inbound_message_id (FK, nullable)

Indexes:
- `messages(conversation_id, sent_at DESC)` for thread display
- `customer_opt_outs(merchant_id, customer_id)` for the assertNotOptedOut hot path
- `message_events(message_id, occurred_at)` for event replay

All RLS-policed via `auth.jwt() ->> 'shop_domain'` → merchants subquery pattern.

### Chunk 2 — Twilio client wrapper (`packages/core/src/twilio-client.ts`)

- `sendSms(to, from, body, metadata)` — wraps Twilio API; returns twilio_sid; handles Twilio errors (4xx → log + return failure, 5xx → retry up to 3 times with exponential backoff)
- `validateWebhookSignature(url, params, signature)` — Twilio's request signature validation; reusable in the inbound route
- `recordTwilioOptOut(phoneNumber)` — calls Twilio's opt-out API as the safety net for decision 18

All wrapped in a thin testable interface. Mocked extensively in unit tests; integration tests use Twilio's test credentials.

### Chunk 3 — Opt-out registry (`packages/core/src/opt-out-registry.ts`)

- `assertNotOptedOut(merchantId, customerId)` — throws `OptOutError` if opted out. Mirrors `assertNoPii` pattern from Sprint 05's redactor. Pre-flight gate before every outbound send.
- `recordOptOut(merchantId, customerId, source, inboundMessageId?)` — writes to `customer_opt_outs` + calls `recordTwilioOptOut`. Idempotent (re-recording is a no-op).
- `isOptedOut(merchantId, customerId)` — read-only check, used by UI and dashboards.
- STOP/UNSUBSCRIBE/REMOVE/CANCEL/END/QUIT keyword detection: case-insensitive, whitespace-tolerant. Returns the matched keyword for the audit trail.

40+ unit tests covering keyword variants, idempotency, source enum, edge cases (empty inbound body, multi-language opt-out keywords for future).

### Chunk 4 — Sentiment classifier (`packages/core/src/classify-reply.ts`)

Sonnet 4.6 with `tool_choice` structured output:

```typescript
const ReplyClassificationSchema = {
  name: "classify_reply",
  input_schema: {
    type: "object",
    required: ["sentiment", "intent", "confidence"],
    properties: {
      sentiment: { enum: ["positive", "neutral", "negative"] },
      intent: { enum: ["engagement", "purchase", "question", "complaint", "opt_out", "other"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reasoning: { type: "string", maxLength: 200 }
    }
  }
}
```

PII redaction pre-flight on the inbound body before sending to Sonnet (reuse `assertNoPii`). Retry ≤2 attempts (tighter than Sprint 05's voice synthesizer because of the latency budget). Token usage accumulated.

Mocked tests cover: positive/purchase intent, opt-out intent (STOP variants Sonnet should catch), negative complaint, ambiguous neutral, low-confidence cases.

### Chunk 5 — Reply generator (`packages/core/src/generate-reply.ts`)

Sonnet 4.6 with `tool_choice` structured output. Inputs: classified inbound (sentiment + intent), conversation history (last 10 messages), brand voice profile (from Sprint 05's `voice_versions` for the active version), customer context (lifecycle stage, last order, propensity).

```typescript
const ReplyGenerationSchema = {
  name: "generate_reply",
  input_schema: {
    type: "object",
    required: ["body"],
    properties: {
      body: { type: "string", maxLength: 320 },  // 2 SMS segments max
      include_signature: { type: "boolean" },
      suggested_next_action: { enum: ["continue", "offer", "wait", "hand_off"] }
    }
  }
}
```

PII redaction pre-flight on inputs (conversation history may contain customer-pasted PII). The OUTPUT also passes through `assertNoPii` to catch hallucinated phone numbers / email addresses in generated text — defense in depth.

### Chunk 6 — Outbound message engine (`packages/core/src/send-message.ts`)

End-to-end outbound function:
1. Pre-flight: `assertNotOptedOut` (decision 18 gate), `assertNotOnCap` (cost discipline gate — reuse pattern), customer phone number lookup
2. Write `message_outbound_queued` event
3. Call `twilio.sendSms` with metadata `{campaign_id, arm_id, customer_id}`
4. On success: write `message_outbound_sent` event with twilio_sid + insert `messages` row
5. On failure: write `message_outbound_failed` event with twilio error code/message
6. Update `conversations.last_message_at` (idempotent upsert)

Mirrors the orchestrator pattern from Sprint 05 (`run-voice-extraction.ts`) and Sprint 06 (`propose-campaign.ts`).

### Chunk 7 — Inbound webhook handler (`apps/web/app/api/sms/inbound/route.ts`)

**⚠️ Mid-sprint checkpoint evaluator runs after this chunk lands. See CLAUDE.md → Mid-sprint checkpoint protocol.**

The synchronous-reply heart of decision 17. Flow:

1. Parse Twilio POST body (URL-encoded form)
2. Validate Twilio signature via `validateWebhookSignature` → 403 if invalid
3. Resolve `(merchant_id, customer_id, conversation_id)` from the from-number + to-number (Twilio's `From` = customer, `To` = our merchant number)
4. Write `message_inbound_received` event + insert `messages` row (inbound, direction='inbound')
5. **STOP keyword fast path**: if body matches STOP variants, `recordOptOut(source='stop_keyword')`, return TwiML acknowledging opt-out, return early.
6. **Sentiment classification**: call `classifyReply` with 4-second timeout. If timeout: log degraded mode, skip to fallback reply, queue async classification for the daily cron.
7. **Opt-out intent path** (decision 18): if classification returns `intent='opt_out'` with confidence > 0.7, `recordOptOut(source='sonnet_classified')`, return TwiML acknowledging.
8. **Reply generation**: call `generateReply` with timeout. On timeout: return TwiML with fallback body ("Thanks for your message — we'll get back to you shortly.") and queue async reply.
9. **Bandit posterior update**: look up most recent outbound on the conversation → its arm_id → call `updatePosterior(armId, success)` where success = (sentiment === 'positive' && intent ∈ {engagement, purchase}).
10. Return TwiML response with the generated reply body.

Total budget: 5 seconds p99. Structured logging at every step with elapsed-ms.

### Chunk 8 — Campaign launcher cron (`apps/web/app/api/cron/launch-campaigns/route.ts`)

Daily cron (Vercel cron config). For each merchant:
1. Fetch `getReadyCampaigns(merchantId)` — approved proposals not yet launched
2. For each proposal: load `campaign_group_snapshots` (the frozen customer set from Sprint 06 decision 15), exclude holdout customers, exclude opted-out customers
3. For each remaining customer: Thompson-sample an arm from the proposal's bandit_state, call `sendMessage(merchantId, customerId, proposalId, armId, variantBody)`
4. Mark the proposal as `launched_at` (idempotent — re-running the cron doesn't re-launch)
5. Cost discipline: `OUTBOUND_DAILY_CAP_DEFAULT` env var caps sends per merchant per day; cap-exhaustion writes structured log + skips remaining customers (resume next day)

### Chunk 9 — No-reply posterior update cron (`apps/web/app/api/cron/sweep-no-reply/route.ts`)

Daily cron. For each merchant, find outbound messages with no inbound on the conversation 7+ days later. For each such outbound: `updatePosterior(armId, success=false)`. Idempotent via a `posterior_updated_at` flag on the message row.

### Chunk 10 — Conversation list UI (`apps/web/app/app/conversations/page.tsx`)

Per-merchant conversation list. Each row: customer name + handle, latest message preview (truncated), unread indicator (inbounds since last viewed), sentiment chip of latest inbound, message count, sourcing campaigns badges (which campaigns drove outbounds on this thread).

Filter: unread / opted-out / by-campaign. Search: customer name, message body content.

Vellum tokens, vocabulary compliance, WCAG 2.2 AA.

### Chunk 11 — Conversation detail UI (`apps/web/app/app/conversations/[customerId]/page.tsx`)

Single thread view. Inbound messages left-aligned, outbounds right-aligned. Each message: timestamp, body, status badge (delivered/failed for outbounds), sentiment chip + intent chip on inbounds, source campaign badge + bandit arm label on outbounds.

Header: customer summary card (lifecycle, last order, propensity, opt-out status). Action buttons: "Mark opt-out" (manual merchant override), "Open in Shopify" (link out).

No reply composition UI in v1 — replies are AI-generated. Sprint 07b or v2 may add merchant manual reply override.

### Chunk 12 — E2E test (`apps/web/e2e/conversation-engine.spec.ts`)

Playwright flow:
1. Seed: an approved campaign from Sprint 06, a customer in the snapshot
2. Trigger launch-campaigns cron → assert outbound message_event written + Twilio mock called with correct body
3. Mock Twilio inbound webhook POST with a positive-intent reply body
4. Assert: inbound event written, sentiment classified, reply generated and sent back as TwiML, bandit posterior updated (alpha incremented)
5. Mock Twilio inbound with "STOP" body → assert opt-out recorded both in customer_opt_outs and Twilio mock
6. Re-trigger launch-campaigns → assert opted-out customer is excluded

Plus failure paths: invalid Twilio signature returns 403; Sonnet classifier timeout falls back to safe reply; opt-out customer cannot be re-targeted.

### Chunk 13 — HANDOFF.md with evidence-required self-scores

Standard format from CLAUDE.md → "Evidence-required HANDOFF format". Every rubric self-score: file:line implementation + file:line tests + named assertion + test case count.

Include a "Deliberate deviations from SPRINT.md" section if any structural deviations occur during the build (per the Sprint 06 pattern).

## Quality rubric (10 criteria — score each 0–3)

| # | Criterion | What 3/3 looks like |
|---|---|---|
| 1 | **Conversation per-customer integrity** | One conversation row per (merchant, customer); messages thread correctly across campaigns; multi-campaign customer test passes |
| 2 | **Twilio webhook signature validation** | Every inbound validates signature before further processing; tampered request test returns 403; validation logic unit-tested with golden vectors |
| 3 | **Synchronous reply latency** | 5-second p99 budget enforced via timeout + fallback; degraded-mode path tested; structured log includes elapsed_ms at each step |
| 4 | **Sentiment classification** | `tool_choice` structured output; retry ≤2 attempts; PII pre-flight; mocked tests cover all 6 intent values + opt-out variants; confidence threshold documented |
| 5 | **Opt-out immediate honor** | `assertNotOptedOut` gates every outbound; dual-recorded (table + Twilio); STOP keyword + Sonnet intent both tested; opted-out customer excluded from launch-campaigns cron |
| 6 | **Reply generation in brand voice** | Uses active `voice_versions` row; conversation history (last 10) included; output PII-checked; generation tests assert tone descriptors are honored |
| 7 | **PII redaction in reply path** | Dual gate at classifier + generator entry; output of generator also PII-checked (catches hallucinated PII); reuse of Sprint 05 pii-redactor verified |
| 8 | **RLS tenancy isolation** | All 4 new tables have merchant-scoped policies; cross-merchant access tests pass; opt-out table cross-merchant test (don't leak which customers opted out) |
| 9 | **Bandit posterior updates** | Wired from classify-reply output to `updatePosterior`; positive+engagement/purchase = success; no-reply cron sweeps inactive outbounds; deterministic given seed |
| 10 | **Observability + evidence-required HANDOFF** | Structured logs at every phase (queued/sent/inbound/classified/generated/replied); spec-adherence-auditor dispatched per chunk; mid-sprint checkpoint APPROVED at chunk 7; evidence-required self-scores in HANDOFF |

## Required environment variables

| Variable | Default | Notes |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | — | Already in env per pre-sprint check |
| `TWILIO_AUTH_TOKEN` | — | Already in env per pre-sprint check |
| `TWILIO_PHONE_NUMBER` | — | The merchant outbound number; may become per-merchant in v2 |
| `OUTBOUND_DAILY_CAP_DEFAULT` | `200` | Outbound SMS per merchant per UTC day (cost discipline) |
| `INBOUND_REPLY_LATENCY_BUDGET_MS` | `5000` | Total budget for sync reply generation; 4s soft cap before fallback |
| `NO_REPLY_SWEEP_DAYS` | `7` | Days after outbound with no inbound before posterior=false |
| Existing: `SONNET_MODEL`, `ANTHROPIC_API_KEY`, `SUPABASE_*` | — | Reused |

Add to: `apps/web/app/lib/env.ts`, `turbo.json` env array, `scripts/vercel-env-check.mjs`. Surface manual Vercel UI action in HANDOFF.

## Pre-sprint preflight

**Before launching the build session, run `pnpm db:diagnose` to confirm all prior migrations are applied to production Supabase.** Per CLAUDE.md → "Pre-sprint preflight". This was the gap that bit Sprint 06; do not skip.

Also verify Twilio test credentials are configured for the build session's integration tests — Twilio provides a Test Credentials pair that lets you exercise the API without sending real SMS.

## Definition of Done

- [ ] All 13 chunks landed as commits
- [ ] All 10 rubric criteria scored 3/3 with evidence (file:line refs in HANDOFF)
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` exits 0
- [ ] `pnpm build` exits 0 for all 3 apps
- [ ] `pnpm grep:pii` exits 0
- [ ] `pnpm vercel:env:check` exits 0
- [ ] `pnpm db:diagnose` exits 0 (against production Supabase, with migration 0008 applied before merge)
- [ ] No architecture-guardian violations (now enumerating all 19 decisions after this sprint's harness chore)
- [ ] No code-reviewer Critical or High findings
- [ ] No spec-adherence-auditor gaps
- [ ] Mid-sprint checkpoint evaluator returned APPROVE (or ADJUST remediated) at chunk 7
- [ ] Final evaluator returned APPROVE FOR MERGE (or REMEDIATE with only Medium/Low items → BACKLOG.md)
- [ ] HANDOFF.md committed using evidence-required self-score format
- [ ] Migration 0008 applied to production Supabase before PR merges (decision-13/Sprint-06 pre-merge gate pattern)
- [ ] Twilio webhook URL configured to point at production `/api/sms/inbound` route

## Out of scope (carry-forward to later sprints)

- **Sprint 08**: Attribution reconciliation against Shopify orders (the "real" success signal); LTV restoration math; holdout-vs-treated revenue lift; bandit posterior corrections from order data.
- **Sprint 09**: Stripe billing on incremental revenue.
- **v2**: Multi-step / multi-message campaign sequences; email channel; WhatsApp/iMessage; voice/IVR; human handoff; merchant manual reply override in conversation UI; per-merchant Twilio numbers; A/B testing the reply generator itself; conversation-level analytics dashboard.
- **Explicit safety exclusion**: Auto-approval of replies (replies are AI-generated and auto-sent — there is no merchant-in-the-loop reply approval in v1, by design). If product feedback later demands merchant approval before reply send, that's a v2 architectural decision change requiring CLAUDE.md amendment.
