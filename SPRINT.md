# Sprint 05 — Agent Identity + Brand Voice + Storefront Analysis

**Date:** 2026-05-15
**Repo:** lapsed (timbowilcox/lapsed)
**Branch:** `sprint-05/agent-identity-and-brand-voice`

## Scope

On Shopify app install, lapsed.ai analyzes the merchant's storefront (about page, sample product descriptions, recent blog posts, footer copy), synthesizes a structured brand voice profile via Sonnet 4.6, and configures an agent identity. The merchant sees a real-time onboarding progress UI, previews 3–5 sample sentences in their voice, and can re-extract or edit the voice profile from Settings. This is the bridge between "app installed" and "ready to send messages that sound like the brand" — the foundation for the conversation engine landing in Sprint 07.

**Explicitly NOT in scope:**
- Actual message generation (Sprint 07 — conversation engine)
- Bandit-driven message variants (Sprint 06)
- Campaign-level voice overrides
- Multi-language voice profiles (English-only for v1; structure permits future expansion)
- Image / visual brand analysis (text-only)

## Load-bearing architectural decisions (new for this sprint)

These extend the six architectural decisions in CLAUDE.md. Cumulative count: 12.

**7. Brand voice profiles are versioned and immutable.** Re-extraction creates a new `voice_versions` row. Active version is tracked via `agent_profiles.active_voice_version_id`. Prior versions are retained for audit and replay. Editing a voice profile = creating a new version with the edits applied; the old version remains.

**8. Storefront snapshots are persisted before synthesis.** The full input corpus is written to `storefront_snapshots` before any LLM call. This makes voice extraction reproducible — given same snapshot + same model + same prompt = same output. Enables replay if we change the voice algorithm.

**9. Voice synthesis uses Sonnet 4.6 with structured output.** Not Haiku. One-shot, high-leverage call per merchant. Cost (~$0.10 per extraction) is negligible at any scale; voice quality compounds across every conversation that ships afterward. `tool_choice` with strict JSON schema; retry up to 3 attempts; token usage logged.

**10. PII redaction is mandatory before any LLM call.** Storefront content (especially reviews and testimonials) may contain customer names, emails, phone numbers. Redactor runs on every snapshot before Sonnet sees it. Verified by a pre-flight test that fails the call if PII patterns are detected post-redaction.

**11. Agent identity uses functional language only — no personal names.** Per lapsed.ai positioning: the agent is the brand's win-back specialist, not "Sarah from lapsed.ai." Role descriptors are drawn from a defined taxonomy (`win_back_specialist`, `customer_care_agent`, `loyalty_concierge`, etc.) — never freeform. Settings allow tone customization but never persona naming.

**12. Voice events are event-sourced like scoring decisions.** Every voice extraction writes a `voice_extracted` event to a new `voice_events` table via `appendVoiceEvent`. Current voice state in `agent_profiles` is a materialized cache, regeneratable from events. Consistent with decisions 1 and 2 from Sprint 04.

## Acceptance criteria

- [ ] On Shopify `app/install` webhook (wired in Sprint 02), a storefront snapshot is fetched within 30 seconds (excluding Shopify API latency)
- [ ] PII redaction strips email addresses, phone numbers, and detected person-name patterns from the snapshot before any LLM call
- [ ] Voice synthesis produces a structured profile with: 3–5 tone descriptors (from taxonomy), sentence-length preference, vocabulary register, emoji policy, up to 5 signature phrases, exactly 5 sample sentences
- [ ] Voice synthesis cost capped per merchant per day via `VOICE_EXTRACTION_DAILY_CAP_DEFAULT` env var (default 10)
- [ ] Onboarding screen shows real-time progress: `Analyzing storefront` → `Extracting brand voice` → `Generating agent identity` → `Ready`. Each step renders: spinner if active, checkmark if past, neutral if future, error icon + message if failed
- [ ] After voice extraction completes, the onboarding screen previews 5 sample sentences in the synthesized voice
- [ ] Agent identity defaults derived: role descriptor (taxonomy-constrained), preferred channels, fallback-to-human criteria
- [ ] Settings → Brand voice tab shows active version, sample sentences, full profile, "Re-extract" button, version history sub-tab
- [ ] Re-extraction creates a new `voice_events` row + new materialized version; prior versions retained
- [ ] All four new tables have merchant-scoped RLS with cross-merchant isolation tests
- [ ] E2E test: install webhook → backfill complete → voice extracted → preview rendered → identity configured
- [ ] No `voice_extracted` events ever contain PII (verified via test on snapshot post-redaction)
- [ ] HANDOFF.md uses the new evidence-required self-score format (see CLAUDE.md additions)

## 13-chunk sequence

### Chunk 1 — Migration `0006_agent_identity.sql`

Four new tables with merchant-scoped RLS:
- `storefront_snapshots` — raw + redacted fetched content per snapshot
- `voice_events` — append-only event log (types: `storefront_fetched`, `pii_redacted`, `voice_extracted`, `voice_edited`, `extraction_failed`)
- `voice_versions` — materialized voice profile per version (version_number, profile_jsonb, source_snapshot_id, extracted_at, model_version)
- `agent_profiles` — current state per merchant (merchant_id PK, active_voice_version_id, role_descriptor, channel_prefs_jsonb, fallback_criteria_jsonb, updated_at)

All tables RLS-policed with `auth.jwt() ->> 'merchant_id'` pattern from prior migrations. Append-only triggers on `voice_events` block UPDATE/DELETE. `storefront_snapshots` is service-role-only (raw content never leaks to client).

### Chunk 2 — Storefront fetcher (`packages/shopify/src/storefront-fetcher.ts`)

Fetches from Shopify Admin API:
- About page (Pages API; title heuristic: "about", "our story", "who we are")
- Top 5 best-selling product descriptions (Products API ordered by sales)
- 3 most recent blog articles (Blogs/Articles API)
- Email footer / signature from notification settings if available
- Store policies (privacy, refund, shipping — short snippets)

Returns typed `StorefrontSnapshot`. Idempotent given same merchant + same Shopify state. Unit tests with mocked Shopify client only.

### Chunk 3 — PII redactor (`packages/core/src/pii-redactor.ts`)

Pure function: `redact(content: string): { redacted: string; matches: PiiMatch[] }`. Detects and replaces:
- Email addresses (RFC 5322 regex → `[email]`)
- Phone numbers (international + US/AU/UK patterns → `[phone]`)
- Person names (capitalized two-word sequences in review/testimonial contexts → `[name]`)
- Social profile URLs (`twitter.com/`, `instagram.com/` followed by username → `[social]`)

Returns redacted text plus structured `PiiMatch[]` for audit. Pre-flight test asserts redacted output contains no PII patterns; throws if it does. 30+ unit tests covering edge cases.

### Chunk 4 — Voice synthesizer (`packages/core/src/voice-synthesizer.ts`)

Sonnet 4.6 client with `tool_choice` structured output. Schema:

```typescript
const VoiceProfileSchema = {
  name: "extract_brand_voice",
  input_schema: {
    type: "object",
    required: ["tone_descriptors", "sentence_length", "register", "emoji_policy", "signature_phrases", "sample_sentences"],
    properties: {
      tone_descriptors: { type: "array", items: { enum: TONE_TAXONOMY }, minItems: 3, maxItems: 5 },
      sentence_length: { type: "string", enum: ["short", "medium", "long", "varied"] },
      register: { type: "string", enum: ["casual", "conversational", "professional", "formal", "edgy"] },
      emoji_policy: { type: "string", enum: ["never", "rare", "frequent"] },
      forbidden_phrases: { type: "array", items: { type: "string" }, maxItems: 10 },
      signature_phrases: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
      sample_sentences: { type: "array", items: { type: "string" }, minItems: 5, maxItems: 5 },
    }
  }
}
```

Tone taxonomy defined as an enum of ~20 descriptors (`warm`, `witty`, `authoritative`, `playful`, `aspirational`, `down_to_earth`, `irreverent`, `caring`, `direct`, `nostalgic`, etc.). Retries up to 3 times on schema validation failure; accumulates token usage across retries. Mocked tests only.

### Chunk 5 — Voice event helpers + materializer

`appendVoiceEvent(merchantId, event)` — canonical helper, Zod-validated, writes to `voice_events`. Mirrors `appendCustomerEvent` from Sprint 03.

`materializeVoice(merchantId)` — replays `voice_events`, builds latest `voice_versions` row, updates `agent_profiles.active_voice_version_id` atomically. Idempotent. Unit test verifies replay produces same result as direct write.

### Chunk 6 — Agent identity defaults derivation (`packages/core/src/derive-agent-identity.ts`)

Pure function: `deriveAgentIdentity(voiceProfile): AgentIdentityDefaults`. Maps tone descriptors → role descriptor candidate (taxonomy-constrained). Maps register + emoji policy → channel preferences (formal/never-emoji → email-leaning; casual/frequent-emoji → SMS-leaning). Default fallback-to-human criteria from a baseline template.

Returns suggested defaults only; merchant edits override. 15+ unit tests covering taxonomy boundaries.

### Chunk 7 — Install flow integration + extraction orchestrator

**⚠️ Mid-sprint checkpoint evaluator runs after this chunk lands. See CLAUDE.md → Mid-sprint checkpoint protocol.**

On `app/install` (already wired Sprint 02), trigger a background extraction job:
1. Fetch storefront snapshot
2. Insert raw + redacted into `storefront_snapshots`
3. Write `storefront_fetched` event
4. Run PII pre-flight check; write `pii_redacted` event
5. Call voice synthesizer with redacted snapshot
6. Write `voice_extracted` event (or `extraction_failed` with error payload)
7. Materialize voice version
8. Derive agent identity defaults; upsert `agent_profiles`

Daily cap enforced from `VOICE_EXTRACTION_DAILY_CAP_DEFAULT`. Cap exhaustion writes a structured log + an `extraction_failed` event with `reason: "daily_cap_exhausted"`. Integration test covers full happy path with mocked Shopify + mocked Sonnet.

### Chunk 8 — Extraction job status query

`getExtractionStatus(merchantId)` in `packages/db/src/queries.ts` returns: `{ phase: 'analyzing' | 'extracting' | 'generating' | 'ready' | 'failed', startedAt, completedAt | null, errorMessage | null, voiceVersionId | null }`. Derived from latest `voice_events`. Used by onboarding progress UI to poll. Test coverage on all phase transitions.

### Chunk 9 — Onboarding progress UI (`apps/web/app/onboarding/_extraction-progress.tsx`)

Four-step indicator: `Analyzing storefront` → `Extracting brand voice` → `Generating agent identity` → `Ready`. Polls `getExtractionStatus` every 2 seconds while phase ∈ {analyzing, extracting, generating}. Stops on `ready` or `failed`. WCAG 2.2 AA via axe.

### Chunk 10 — Voice preview component (reused in Settings)

Renders the 5 sample sentences from the active voice profile. Tone descriptors as chips, register as a label, signature phrases as small accent text. "Re-extract" button (Settings only — disabled in onboarding context).

### Chunk 11 — Settings → Brand voice tab

Three sections:
1. **Active voice** — preview component + tone/register chips + sample sentences
2. **Version history** — collapsible list of all `voice_versions` for merchant, sorted desc by `extracted_at`. Each row: version number, extracted date, model used. Actions: "View" (read-only modal), "Activate" (writes new event setting this version as active)
3. **Re-extract** — button triggers new extraction; respects daily cap; shows inline progress

### Chunk 12 — E2E test (`apps/web/e2e/voice-extraction.spec.ts`)

Playwright: mock Shopify install → trigger extraction → assert 4-phase progress UI → assert voice preview renders 5 sentences → Settings → assert active voice matches extraction output → trigger re-extract → assert new version appears in history.

### Chunk 13 — HANDOFF.md with evidence-required self-scores

HANDOFF.md follows the **new** template from CLAUDE.md additions — every rubric self-score must include file:line implementation references AND test file:line references AND the specific assertions proving the criterion. No "3/3 — looks complete" entries permitted.

## Quality rubric (10 criteria — score each 0–3)

| # | Criterion | What 3/3 looks like |
|---|---|---|
| 1 | **Voice profile versioning purity** | New version row per extraction; prior versions never mutated; active pointer updated atomically; idempotency test passes |
| 2 | **Snapshot reproducibility** | Same snapshot + same model = same voice profile (snapshot test); raw snapshot persisted before LLM call |
| 3 | **PII redaction completeness** | Pre-flight test asserts no PII reaches LLM; 30+ redactor unit tests cover email/phone/name/social patterns; `voice_extracted` events verified PII-free |
| 4 | **Voice synthesis structured output** | `tool_choice` with strict schema; retry up to 3 attempts; token usage accumulated across retries; malformed-output retry test passes |
| 5 | **Cost discipline** | `VOICE_EXTRACTION_DAILY_CAP_DEFAULT` wired through env.ts + turbo.json + vercel-env-check; cap-exhaustion writes structured log + event; per-extraction `voice_extraction_complete` log emitted |
| 6 | **Agent identity constraint** | Role descriptor drawn from defined enum; freeform persona names rejected at type level; settings UI uses radio buttons not text input for role |
| 7 | **RLS tenancy isolation** | All 4 new tables have merchant-scoped policies; cross-merchant access tests pass; `storefront_snapshots` is service-role only |
| 8 | **Onboarding UX completeness** | 4-phase indicator with polling; error state with retry; sample preview renders; WCAG 2.2 AA; loading skeletons + Suspense boundaries |
| 9 | **Re-extraction flow** | New version on each re-extract; atomic active-version swap; full version history viewable; no data loss; activate-prior-version path works |
| 10 | **Observability + evidence-required HANDOFF** | Structured logs at every phase transition; evidence-required self-scores in HANDOFF; spec-adherence-auditor dispatched per chunk; mid-sprint checkpoint evaluator APPROVED at chunk 7 |

## Required environment variables

| Variable | Default | Notes |
|---|---|---|
| `VOICE_EXTRACTION_DAILY_CAP_DEFAULT` | `10` | Per merchant per UTC day |
| `SONNET_MODEL` | `claude-sonnet-4-6-latest` | Pinned model for voice synthesis |

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
- [ ] No architecture-guardian violations
- [ ] No code-reviewer Critical or High findings
- [ ] No spec-adherence-auditor gaps (new subagent — see CLAUDE.md additions)
- [ ] Mid-sprint checkpoint evaluator returned APPROVE at chunk 7
- [ ] Final evaluator returned APPROVE (or REMEDIATE with only Medium/Low items → BACKLOG.md)
- [ ] HANDOFF.md committed using evidence-required self-score format
- [ ] PR open against `main`

## Out of scope

- Conversation generation using the voice profile (Sprint 07)
- A/B testing voice variants (Sprint 06 — bandit infrastructure)
- Image / visual brand analysis (logos, color palettes)
- Multi-language voice profiles
- Voice profile sharing across merchants (each isolated by RLS)
- Manual voice profile authoring without storefront analysis
- Campaign-level voice overrides (deferred until conversation engine ships)
