# Backlog

Deferred items from completed sprints. None block v1 launch; revisit before launch or fold into future sprints as relevant.

## Sprint 05

### M-S05-01: materializeVoice tie-break ordering
- **File:** `packages/core/src/voice-events.ts` (materializeVoice function)
- **Issue:** Orders voice_activated events by `occurred_at DESC` with no secondary key. Pre-existing chunk-5 behavior, not introduced by chunk-7 remediation. Cross-run correctness relies on wall-clock monotonicity.
- **Risk:** Low — re-extractions are minutes apart and from distinct sources.
- **Fix when revisited:** Add a deterministic tie-break — either `ingested_at`, `version_number`, or a row sequence.
- **Origin:** Sprint 05 chunk 7 mid-sprint checkpoint remediation (code-reviewer Medium finding).

### L-S05-02: VoiceFailurePhase missing 'start' value
- **File:** `packages/core/src/run-voice-extraction.ts`
- **Issue:** When `extraction_started` append fails, orchestrator returns `phase: "fetch"` because VoiceFailurePhase enum has no "start" member. Semantically inaccurate but functionally correct.
- **Risk:** Cosmetic only — affects extraction_failed event payload accuracy in the rare append-failure case.
- **Fix when revisited:** Add `"start"` to VoiceFailurePhase enum and update the catch path. Trivial change.
- **Origin:** Sprint 05 chunk 7 mid-sprint checkpoint remediation (code-reviewer Low finding).

### L-S05-03: getExtractionStatus cap-exhaustion blind spot
- **File:** `packages/db/src/queries.ts` (getExtractionStatus function)
- **Issue:** When a voice extraction run hits the daily cap (VOICE_EXTRACTION_DAILY_CAP_DEFAULT), the orchestrator writes `extraction_failed` with `reason: "daily_cap_exhausted"` but no `extraction_started` event (cap check runs before the started event is emitted by design — see chunk-7 remediation). The boundary query in getExtractionStatus filters `voice_events` by `>= extraction_started.occurred_at`, so a cap-failed run with no started event reports `phase: "analyzing"` instead of `phase: "failed"`.
- **Risk:** Low. Unreachable on first install (no prior cap-failed runs exist for a new merchant). The Settings re-extract path has its own 429 pre-flight gate that prevents this state from being user-visible in normal flows.
- **Fix when revisited:** Either (a) treat `extraction_failed` with no preceding `extraction_started` as a terminal failure phase, or (b) emit `extraction_started` BEFORE the cap check and accept a stray started event paired with extraction_failed.
- **Origin:** Sprint 05 final evaluator (Low finding); disclosed in HANDOFF.md.

### L-HARNESS-01: architecture-guardian subagent doc drift
- **File:** `.claude/agents/architecture-guardian.md`
- **Issue:** Subagent definition still enumerates only the original 6 architectural decisions. CLAUDE.md now has 12 (decisions 7–12 were added in Sprint 05). The subagent reads CLAUDE.md as its primary source so it does pick up decisions 7–12 in practice, but the subagent's own rules document is stale.
- **Risk:** Low — purely doc hygiene. The architecture-guardian subagent has been correctly enforcing decisions 7–12 throughout Sprint 05 (verified by its zero-violations verdicts) because it reads CLAUDE.md, not the subagent doc.
- **Fix when revisited:** Append decisions 7–12 to the architecture-guardian.md rules section to match CLAUDE.md.
- **Origin:** Sprint 05 final evaluator (Low finding); pre-existing harness doc drift, not introduced by Sprint 05.