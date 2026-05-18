-- Migration 0017 — Onboarding state (Sprint 11, Chunk 12)
--
-- Tracks where a merchant is in the first-run tour so the app can
-- redirect new merchants to /app/onboarding and resume interrupted sessions.
--
-- Stored as TEXT with a CHECK constraint rather than a Postgres enum so
-- adding new states in future migrations doesn't require a full enum ALTER.
-- Consistent with how opt_out_keywords and other merchant config columns work.

alter table public.merchants
  add column if not exists onboarding_state text
    not null
    default 'not_started'
    check (onboarding_state in ('not_started', 'in_progress', 'completed', 'skipped'));

comment on column public.merchants.onboarding_state is
  'First-run tour state. not_started → in_progress (on first /app load) → completed or skipped.
   Used to redirect new merchants to /app/onboarding and resume interrupted sessions.
   Sprint 11 / Chunk 12.';
