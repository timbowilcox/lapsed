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