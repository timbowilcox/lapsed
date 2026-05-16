# HANDOFF — Sprint 07: Conversation Engine

**Branch:** `sprint-07/conversation-engine`
**Scope:** SMS sends, two-way conversation handling, opt-out registry, bandit posterior updates.
**Status:** All 13 chunks landed. `pnpm typecheck` / `lint` / `test` / `grep:pii` green (core 871 tests, web 186, db 143 + 84 RLS-integration tests skipped without a live DB). Mid-sprint checkpoint returned ADJUST → Fix 1 applied. `vercel:env:check` is RED pending a manual action — see "Manual actions" below.

This sprint turns approved campaign proposals into running SMS conversations. A daily cron Thompson-samples a bandit arm per customer and sends the variant via Twilio; inbound replies hit `/api/sms/inbound`, which synchronously classifies sentiment, generates a brand-voice reply, fires the bandit posterior, and returns TwiML. STOP keywords and Sonnet-classified opt-out intent both dual-record to `customer_opt_outs` + Twilio.

---

## Quality rubric — evidence-required self-scores

### Criterion 1: Conversation per-customer integrity

**Self-score:** 3/3

**Implementation evidence:**
- Primary: `packages/db/supabase/migrations/0008_conversation_engine.sql:60-118` — `conversations` keyed by `constraint conversations_pk primary key (merchant_id, customer_id)` (line 72); a surrogate `id` is `UNIQUE` so `messages`/`message_events` FK one column.
- Supporting: `packages/core/src/message-events.ts:200-262` (`ensureConversation` — get-or-create on the `(merchant_id, customer_id)` pair, 23505-race re-read); `messages.campaign_id`/`arm_id` are nullable per-message attribution.

**Test evidence:**
- Test file: `packages/core/__tests__/message-events.test.ts` (`ensureConversation` describe); `packages/core/__tests__/conversation-engine.flow.test.ts`.
- Number of test cases: 5 (4 `ensureConversation` cases + 1 end-to-end flow test).
- Key assertion: "returns the existing conversation without creating a second (decision 16)" asserts `tables.conversations` length stays 1; `rls.test.ts` "conversations_pk rejects a second thread for the same (merchant_id, customer_id)" asserts the PK violation.

---

### Criterion 2: Twilio webhook signature validation

**Self-score:** 3/3

**Implementation evidence:**
- Primary: `packages/core/src/twilio-client.ts:233-243` (`validateWebhookSignature` — wraps Twilio's official `validateRequest`, fails closed on a thrown error).
- Supporting: `apps/web/app/api/sms/inbound/route.ts:54-70` — signature validated and a `403` returned before any DB write or LLM call (form parsing is the only prerequisite).

**Test evidence:**
- Test file: `packages/core/__tests__/twilio-client.test.ts` (`validateWebhookSignature` describe + "agrees with Twilio's own signer"); route boundary in `apps/web/e2e/conversation-engine.spec.ts`.
- Number of test cases: 7 unit + 2 Playwright.
- Key assertion: "accepts a correctly-signed request (golden vector)" + "rejects a tampered body" + the cross-check that the wrapper validates a signature minted by Twilio's own `getExpectedTwilioSignature`; the Playwright spec asserts `403` on an absent and a forged signature.

---

### Criterion 3: Synchronous reply latency

**Self-score:** 3/3

**Implementation evidence:**
- Primary: `packages/core/src/handle-inbound.ts:122-360` (`handleInboundMessage`) — `softDeadlineMs = startMs + latencyBudgetMs - LATENCY_RESERVE_MS` (line 133); both Sonnet calls race `withDeadline` (lines 231, 311); a timeout/error writes a `degraded_mode` event (`appendDegradedEvent`, line 635) and returns `DEGRADED_FALLBACK_REPLY`. `elapsed_ms` is tracked per step via `mark()`.
- Supporting: `withDeadline` (line 397) clears its timer in `finally`.

**Test evidence:**
- Test file: `packages/core/__tests__/handle-inbound.test.ts` ("degraded mode" + "genuine timeouts" describes); `packages/core/__tests__/conversation-engine.flow.test.ts`.
- Number of test cases: 4 degraded/timeout cases.
- Key assertion: "degrades when the classify call hangs past the soft deadline" uses a hanging mock + `latencyBudgetMs: 1050` to exercise the real `setTimeout` race, asserts `outcome === "degraded"` and a `degraded_mode` event with `phase: "classify"`.

---

### Criterion 4: Sentiment classification

**Self-score:** 3/3

**Implementation evidence:**
- Primary: `packages/core/src/classify-reply.ts:194-280` (`classifyReply`) — Sonnet 4.6 `tool_choice` structured output (`additionalProperties: false`), `MAX_CLASSIFY_ATTEMPTS = 2` (line 34, documented as total attempts), token usage accumulated, `assertNoPii` PII pre-flight (line 220). `OPT_OUT_CONFIDENCE_THRESHOLD = 0.7` (line 46) documented.

**Test evidence:**
- Test file: `packages/core/__tests__/classify-reply.test.ts`.
- Number of test cases: 31.
- Key assertion: all 6 intent values + 3 sentiments classified; "exhausts retries on a persistent transient API error with reason transient_api"; "short-circuits on a name-based permanent error"; "throws pii_leak when the body still contains an un-redacted phone number" asserts the API is never called.

---

### Criterion 5: Opt-out immediate honor

**Self-score:** 3/3

**Implementation evidence:**
- Primary: `packages/core/src/opt-out-registry.ts:137-145` (`assertNotOptedOut` — throws `OptOutError`), `:195-260` (`recordOptOut` — writes `customer_opt_outs` then the Twilio leg; table failure throws, Twilio failure is a critical structured log, not thrown), `:66-78` (`detectOptOutKeyword`).
- Supporting: `packages/core/src/send-message.ts:95` (`assertNotOptedOut` is the first pre-flight before every outbound); migration `0008:300-352` (`customer_opt_outs` append-only, trigger-enforced).

**Test evidence:**
- Test file: `packages/core/__tests__/opt-out-registry.test.ts` (72 tests); `packages/core/__tests__/send-message.test.ts` ("opt-out gate" describe); `packages/db/__tests__/rls.test.ts` (`customer_opt_outs` append-only UPDATE/DELETE/TRUNCATE rejection).
- Number of test cases: 72 + 1 (send gate) + 3 (append-only).
- Key assertion: "skips an opted-out customer without calling Twilio" asserts `sendCalls` length 0; "a second recordOptOut is a no-op that returns alreadyOptedOut:true" asserts no second `customer_opt_outs` row; both STOP-keyword and Sonnet-`opt_out`-intent paths are covered in `handle-inbound.test.ts`.

---

### Criterion 6: Reply generation in brand voice

**Self-score:** 3/3

**Implementation evidence:**
- Primary: `packages/core/src/generate-reply.ts:174-300` (`generateReply`) — Sonnet 4.6 `tool_choice`, consumes the active `voice_versions` profile, the last `REPLY_HISTORY_LIMIT` (10) thread messages, and PII-free customer context; `body` capped at `REPLY_BODY_MAX_CHARS` (320). `buildSystemPrompt` embeds tone descriptors / register / emoji policy / forbidden + signature phrases.
- Supporting: `handle-inbound.ts` `loadVoiceProfile` resolves the merchant's active voice via `getActiveVoiceProfile`, with a conservative default fallback.

**Test evidence:**
- Test file: `packages/core/__tests__/generate-reply.test.ts`.
- Number of test cases: 32.
- Key assertion: "uses only the last REPLY_HISTORY_LIMIT messages of a long thread"; the `buildSystemPrompt` tests assert tone descriptors, forbidden phrases, and signature phrases are embedded; the schema rejects an over-cap body.

---

### Criterion 7: PII redaction in reply path

**Self-score:** 3/3

**Implementation evidence:**
- Three gates, all reusing Sprint 05's `assertNoPii` (`packages/core/src/pii-redactor.ts`):
  1. Classifier input: `classify-reply.ts:220` — `assertNoPii(body)` before the first Anthropic call.
  2. Generator input: `generate-reply.ts:205-215` — `assertNoPii` on every conversation-history body (`input_pii_leak`).
  3. Generator output: `generate-reply.ts:255-263` — `assertNoPii(parsed.data.body)` catches hallucinated PII; the attempt is retried, exhaustion throws `output_pii_leak`.
- Inbound bodies stored raw (`body`) + PII-redacted (`pii_redacted_body`) — `handle-inbound.ts` `insertInboundMessage`; logs use only the redacted column / `maskPhone`.

**Test evidence:**
- Test file: `classify-reply.test.ts` (PII-gate describe), `generate-reply.test.ts` ("PII gates" describe).
- Number of test cases: 6 (classifier) + 5 (generator input + output).
- Key assertion: "retries when the generated body contains a hallucinated phone number, then succeeds"; "throws output_pii_leak when every attempt hallucinates PII"; "does not call the API when the input PII gate fails".

---

### Criterion 8: RLS tenancy isolation

**Self-score:** 3/3

**Implementation evidence:**
- Primary: migration `0008_conversation_engine.sql` — all four new tables carry a merchant-scoped SELECT policy via the `auth.jwt() ->> 'shop_domain'` → merchants subquery: `conversations_merchant_read` (line 110), `messages_merchant_read` (222), `message_events_merchant_read` (295), `customer_opt_outs_merchant_read` (356). Writes are service-role only (no INSERT/UPDATE/DELETE policy granted).

**Test evidence:**
- Test file: `packages/db/__tests__/rls.test.ts` — RLS describes for `conversations`, `messages`, `message_events`, `customer_opt_outs` (3 cross-tenant cases each), plus append-only triggers and the dedup/PK idempotency tests.
- Number of test cases: 20 (12 RLS isolation + 6 append-only + 2 idempotency) — live-DB integration tests, skipped when no Supabase is configured (the established `rls.test.ts` pattern).
- Key assertion: "merchant A cannot see merchant B's messages" asserts `[]`; "wrong JWT secret returns zero rows"; the `customer_opt_outs` cross-merchant test confirms one merchant's opt-out list does not leak.

---

### Criterion 9: Bandit posterior updates

**Self-score:** 3/3

**Implementation evidence:**
- Primary: `packages/core/src/handle-inbound.ts:300-303` — `success = sentiment === "positive" && (intent === "engagement" || intent === "purchase")`; `routeBanditPosterior` (line 668) routes to the conversation's most-recent outbound arm, is idempotent (skips an already-stamped outbound), and stamps `posterior_updated_at`.
- Supporting: `packages/core/src/conversation-sweep.ts:67-118` (`sweepNoReplyPosteriors` — fires `updatePosterior(arm, false)` for outbounds `NO_REPLY_SWEEP_DAYS` old with no posterior yet). `updatePosterior` (Sprint 06 `bandit.ts`) moves only `alpha`/`beta`/`observation_count` — never arm identity (decision 14).

**Test evidence:**
- Test file: `handle-inbound.test.ts` ("bandit posterior" describe — 8 cases), `conversation-sweep.test.ts` (`sweepNoReplyPosteriors` — 7 cases), `conversation-engine.flow.test.ts`.
- Number of test cases: 8 + 7 + flow.
- Key assertion: "a positive engagement reply increments the arm's alpha"; "a negative reply increments beta"; "does NOT re-fire the posterior when a classify-phase retry fails at generate twice" asserts `alpha` stays at 2; the no-reply sweep is deterministic given the cutoff.

---

### Criterion 10: Observability + evidence-required HANDOFF

**Self-score:** 3/3

**Implementation evidence:**
- Structured single-line JSON logs at every phase, no PII: `send-message.ts` (`send_message_sent`/`failed`/`skipped`), `handle-inbound.ts` (`inbound_replied`/`degraded`/`opt_out`, per-step `elapsed_ms` in `timings`), `launch-campaigns.ts`, `conversation-sweep.ts`, `twilio-client.ts` (`maskPhone` on every log path). `grep:pii` passes.
- The `message_events` append-only log (`message_outbound_queued/sent/failed`, `message_inbound_received`, `inbound_classified`, `reply_generated/sent`, `degraded_mode`, `opt_out_recorded`, `posterior_updated`) is the regeneratable source of truth.

**Test evidence:**
- `twilio-client.test.ts` "structured logs never contain a raw phone number" asserts `maskPhone` output is present and the raw number absent; `opt-out-registry.test.ts` "the twilio-leg-failure log masks the phone and never contains it raw".
- This HANDOFF uses the evidence-required format. Every chunk was reviewed by the specialist subagent panel per chunk type (backend chunks: architecture-guardian + code-reviewer + test-coverage-analyzer + spec-adherence-auditor; UI chunks 10-11: all seven), and every Critical/High/GAP finding was remediated and re-reviewed clean.

**Notes:** SPRINT.md's "3/3 looks like" wording for this criterion says "mid-sprint checkpoint APPROVED at chunk 7." The checkpoint did not return a bare APPROVE — it returned **ADJUST** with one surgical fix (the `messages.twilio_sid` partial unique index). Per CLAUDE.md's checkpoint decision rule, an ADJUST is remediated and the build proceeds with no re-run required; the checkpoint evaluator explicitly stated "Apply Fix 1, then proceed to chunk 8 — no checkpoint re-run needed." The fix landed (commit `f428e7a`). The 3/3 is claimed on that basis — a successfully-completed checkpoint with its one directive satisfied — and surfaced transparently here for the final evaluator's judgment rather than asserted as a clean APPROVE.

---

## Deliberate deviations from SPRINT.md

1. **Chunk 1 — dropped the 0002 stub tables.** Migration 0002 forward-declared `conversations` + `conversation_messages` stub tables that Sprints 03–06 never used. Chunk 1 `DROP`s both and recreates `conversations` with the decision-16 `(merchant_id, customer_id)` composite key, plus `vector(1536)` embedding columns on `conversations` and `messages` to honor decision 2. Surfaced as a blocker and explicitly human-approved before the migration was written. `db-diagnose.mjs` was extended to parse `DROP TABLE` so the dropped stub is not false-flagged as missing.

2. **Chunk 3 — `recordOptOut` signature.** Gained a `phoneNumber` parameter (the `customer_opt_outs.phone_number` column and the Twilio opt-out leg need it; relaxed to allow empty for a no-phone merchant-manual opt-out — see #6). Added `STOPALL` to the keyword set (a Twilio-native + AU Spam Act / US TCPA-recognized opt-out keyword). The Twilio leg's `recordOptOut` is a documented structured-log seam — Twilio has no public REST endpoint to suppress an arbitrary number, and it natively records STOP-keyword opt-outs; `customer_opt_outs` is the application source of truth (decision 18).

3. **Chunk 6 — `message-events.ts` event taxonomy laid forward.** The full 10-type event taxonomy (including `inbound_classified`, `reply_generated`, `degraded_mode`, `posterior_updated` used by chunks 7–9) was built in chunk 6, the first chunk to write `message_events`. One shared event-log module rather than per-chunk fragments.

4. **Chunk 8 — no `launched_at` column.** SPRINT.md says "mark the proposal as launched_at". There is no `launched_at` column or `campaign_launched` event — idempotency is per-customer via `sendMessage`'s `already_sent` guard (a re-run of the launch cron skips every already-messaged `(campaign, customer)`). This achieves "re-running the cron doesn't re-launch" without a schema change or a Sprint-06 `campaign_events` taxonomy change.

5. **Chunk 11 — route param is the conversation UUID.** SPRINT.md names the route `[customerId]`; the implementation uses `[id]` = `conversations.id` (UUID), because shopify customer gids (`gid://shopify/Customer/123`) contain slashes and are not URL-safe path segments. Per decision 16 the conversation is 1:1 with the customer, so the UUID is a clean stable handle to the same thread.

6. **Chunk 11 — manual opt-out is never blocked.** The opt-out route does not 409 when a customer has no phone on file; `recordOptOut`'s `phoneNumber` is empty-tolerant, the `customer_opt_outs` row is written regardless, and only the best-effort Twilio leg is skipped — decision 18 requires an opt-out to always be recordable.

7. **Chunk 12 — full-flow E2E is a core-layer integration test.** `packages/core/__tests__/conversation-engine.flow.test.ts` exercises the entire launch → inbound → reply → posterior → STOP → re-launch sequence with the in-memory Supabase fake + fake Twilio + mock Anthropic. A browser-level Playwright run of the full flow is not feasible because the API routes construct their Twilio/Anthropic clients from env with no injection seam. `apps/web/e2e/conversation-engine.spec.ts` covers the route-level security boundaries (signature 403, cron 401) that only the real route can demonstrate. Adding a route-level DI seam for a true browser E2E is a v2 follow-up.

8. **Checkpoint Fix 1.** The mid-sprint checkpoint added a partial unique index `messages_inbound_twilio_sid_unique` on `messages(twilio_sid) WHERE direction = 'inbound'` to migration 0008 — a DB-enforced backstop for the chunk-7 application-level webhook-retry idempotency guard.

---

## Manual actions required before merge

1. **Add six env vars to the Vercel `lapsed-web` project** (all three environments): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `OUTBOUND_DAILY_CAP_DEFAULT`, `INBOUND_REPLY_LATENCY_BUDGET_MS`, `NO_REPLY_SWEEP_DAYS`. They are already wired into `env.ts`, `turbo.json`, and `vercel-env-check.mjs`; `pnpm vercel:env:check` is RED until they exist on Vercel.
2. **Apply migration `0008_conversation_engine.sql` to production Supabase** before the PR merges (decision-13/Sprint-06 pre-merge gate pattern). `pnpm db:diagnose` exits 0 once applied.
3. **Configure the Twilio inbound webhook URL** to point at the production `https://app.lapsed.ai/api/sms/inbound` route.
4. **Register the two new Vercel cron schedules**: `/api/cron/launch-campaigns` and `/api/cron/sweep-no-reply` (daily).

---

## Known limitations / post-v1 follow-ups

- `getConversationList` assembles in memory from a bounded scan (`MESSAGE_SCAN_LIMIT = 5000`); a merchant exceeding that would see stale previews on the least-active threads — move the latest-message-per-conversation reduction into SQL post-v1.
- `hasUnread` is "the latest message is inbound" — there is no per-merchant read-state tracking; it is effectively "awaiting agent reply".
- An `INBOUND_REPLY_LATENCY_BUDGET_MS` of 5s for two sequential Sonnet calls is optimistic under real p50s — raise the budget if the degrade rate is high in production.
- The conversation-engine route layer has no DI seam for Twilio/Anthropic — see deviation #7.
- A partial unique index on `messages.twilio_sid` covers inbound idempotency; outbound Twilio send SIDs are not uniquely constrained (each send is distinct).
