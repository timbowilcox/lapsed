-- Sprint 05: agent identity, storefront analysis, and brand voice synthesis.
--
-- ARCHITECTURAL DECISIONS ENCODED HERE:
--
-- Decision 7 (versioned + immutable voice profiles): voice_versions rows
--   are write-once. Re-extraction creates a NEW row with version_number =
--   max(version_number) + 1. Editing creates another new row. The CHECK on
--   voice_versions has no UPDATE policy and authenticated reads only.
--
-- Decision 8 (snapshot before synthesis): storefront_snapshots is written
--   BEFORE any LLM call. Same snapshot + same model + same prompt = same
--   output. The raw_content column never leaves the service role — REVOKE
--   from authenticated/anon. Merchant UI surfaces synthesized output only.
--
-- Decision 9 (Sonnet 4.6 structured output): model_version recorded per
--   voice_versions row so we can replay any extraction. Synthesis itself
--   lives in @lapsed/core; this schema only persists the result.
--
-- Decision 10 (PII redaction mandatory): redacted_content is written to
--   storefront_snapshots after the redactor runs. voice_events.payload
--   for `pii_redacted` records the count of matches per type, never the
--   matched strings. The chunk-3 redactor is the gate.
--
-- Decision 11 (functional language, no personal names): agent_profiles.
--   role_descriptor references a TEXT column constrained by application
--   code to the taxonomy enum exported from @lapsed/core. Postgres does
--   not enforce the enum so the type-level rejection lives in TypeScript.
--   CHECK constraint ensures the value is non-empty and from a small set
--   of bytes (lowercase + underscore) to mirror taxonomy shape.
--
-- Decision 12 (event-sourced voice events): voice_events is append-only,
--   trigger-enforced via the existing prevent_event_mutation() helper
--   from migration 0002. agent_profiles and voice_versions are
--   materialized caches — regeneratable by replaying voice_events.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- storefront_snapshots  (raw + redacted storefront corpus, SERVICE-ROLE ONLY)
-- ─────────────────────────────────────────────────────────────────────────────
-- The raw_content column may contain customer testimonials / reviews with
-- PII. Redactor runs over it before any LLM call; redacted_content is the
-- only field that ever reaches Sonnet. Both columns are blocked from
-- authenticated reads (REVOKE + deny-policy). Merchant UI never queries
-- this table directly.

create table if not exists public.storefront_snapshots (
  id                  uuid          primary key default gen_random_uuid(),
  merchant_id         uuid          not null references public.merchants(id) on delete restrict,
  raw_content         jsonb         not null,
    -- {about: string, products: [{title, body}], blog: [{title, body}],
    --  policies: {privacy, refund, shipping}, footer: string}
  redacted_content    jsonb         not null,
    -- same shape as raw_content but with PII tokens replaced ([email], [phone], [name], [social])
  pii_match_summary   jsonb         not null default '{}',
    -- {email: int, phone: int, name: int, social: int} — counts only, never matched strings
  source_hash         text          not null,
    -- sha256 of canonical(raw_content) — enables idempotent re-fetch detection
  fetched_at          timestamptz   not null default now(),
  created_at          timestamptz   not null default now()
);

comment on table public.storefront_snapshots is
  'Raw + PII-redacted storefront corpus per fetch. Service-role only — raw '
  'content may include customer reviews with PII even after redaction safeguards. '
  'Persisted BEFORE Sonnet synthesis so extractions are reproducible (decision 8).';

comment on column public.storefront_snapshots.raw_content is
  'Unredacted fetched corpus. NEVER reaches the LLM. NEVER readable by the '
  'authenticated role. Retained for audit + replay if the redactor changes.';

comment on column public.storefront_snapshots.redacted_content is
  'PII-stripped version used as Sonnet input. Pre-flight test in @lapsed/core '
  'asserts no email/phone/name patterns remain before calling the LLM.';

comment on column public.storefront_snapshots.source_hash is
  'SHA-256 of canonicalized raw_content. Used to dedup identical fetches and '
  'to verify replay reproducibility.';

create index storefront_snapshots_merchant_idx
  on public.storefront_snapshots (merchant_id, fetched_at desc);

create unique index storefront_snapshots_merchant_hash_unique
  on public.storefront_snapshots (merchant_id, source_hash);

alter table public.storefront_snapshots enable row level security;

-- Authenticated and anon roles are denied ALL access. Service role bypasses RLS.
create policy storefront_snapshots_deny_authenticated
  on public.storefront_snapshots for all to authenticated
  using (false) with check (false);

create policy storefront_snapshots_deny_anon
  on public.storefront_snapshots for all to anon
  using (false) with check (false);

-- Belt and braces: also revoke privileges so a missing/disabled policy can't leak rows.
revoke all on public.storefront_snapshots from authenticated;
revoke all on public.storefront_snapshots from anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- voice_events  (append-only event log — decision 12)
-- ─────────────────────────────────────────────────────────────────────────────
-- Event types (enforced in application layer, not the DB, to match the
-- pattern of customer_events / merchant_events):
--   extraction_started   — payload: {} (occurred_at + source are the signal)
--   storefront_fetched   — payload: {snapshot_id, byte_count, source_hash}
--   pii_redacted         — payload: {snapshot_id, pii_match_summary}
--   voice_extracted      — payload: {version_id, model_version, tokens_input, tokens_output, retries}
--   voice_edited         — payload: {version_id, previous_version_id, fields_changed: []}
--   voice_activated      — payload: {version_id, previous_version_id} (install run + Settings -> Activate)
--   extraction_failed    — payload: {phase, reason, attempt, error_class}
--
-- payload NEVER contains raw storefront text or LLM-generated content.
-- Materialized state lives in voice_versions + agent_profiles.

create table if not exists public.voice_events (
  id            uuid        primary key default gen_random_uuid(),
  merchant_id   uuid        not null references public.merchants(id) on delete restrict,
  event_type    text        not null,
  source        text        not null,    -- 'install_orchestrator' | 'settings_reextract' | 'settings_edit' | 'settings_activate'
  payload       jsonb       not null default '{}',
  occurred_at   timestamptz not null,
  ingested_at   timestamptz not null default now()
);

comment on table public.voice_events is
  'Append-only event log for brand voice lifecycle. Materialized state in '
  'voice_versions + agent_profiles is regeneratable from this log. '
  'payload NEVER contains raw storefront text or LLM output — only IDs, '
  'counts, and metadata.';

alter table public.voice_events
  add constraint voice_events_dedup_unique
  unique (merchant_id, event_type, source, occurred_at);

create index voice_events_merchant_idx
  on public.voice_events (merchant_id, occurred_at desc);

create index voice_events_merchant_type_idx
  on public.voice_events (merchant_id, event_type, occurred_at desc);

-- Append-only enforcement — uses prevent_event_mutation() helper from 0002.
create trigger voice_events_no_update
  before update on public.voice_events
  for each row execute function prevent_event_mutation();

create trigger voice_events_no_delete
  before delete on public.voice_events
  for each row execute function prevent_event_mutation();

create trigger voice_events_no_truncate
  before truncate on public.voice_events
  for each statement execute function prevent_event_mutation();

alter table public.voice_events enable row level security;

-- Authenticated merchant may read their own voice events (powers extraction status UI).
-- Service role writes via @lapsed/core appendVoiceEvent helper.
create policy voice_events_merchant_read
  on public.voice_events for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- voice_versions  (materialized voice profile per version — decision 7)
-- ─────────────────────────────────────────────────────────────────────────────
-- version_number is per merchant, monotonically increasing. Re-extraction
-- always creates a NEW row; rows are never updated in-place. The active
-- version pointer lives in agent_profiles.active_voice_version_id.

create table if not exists public.voice_versions (
  id                  uuid          primary key default gen_random_uuid(),
  merchant_id         uuid          not null references public.merchants(id) on delete restrict,
  version_number      int           not null,
  source_snapshot_id  uuid          not null references public.storefront_snapshots(id) on delete restrict,
  profile             jsonb         not null,
    -- {tone_descriptors: string[], sentence_length: string, register: string,
    --  emoji_policy: string, forbidden_phrases: string[],
    --  signature_phrases: string[], sample_sentences: string[]}
  model_version       text          not null,    -- e.g. 'claude-sonnet-4-6-20251022'
  prompt_version      text          not null,    -- prompt template hash for replay
  tokens_input        int           not null default 0,
  tokens_output       int           not null default 0,
  retries             smallint      not null default 0,
  extracted_at        timestamptz   not null default now(),
  created_at          timestamptz   not null default now(),
  constraint voice_versions_merchant_version_unique
    unique (merchant_id, version_number)
);

comment on table public.voice_versions is
  'Materialized brand voice profile per version. Append-only by convention: '
  'voice profile edits or re-extractions create a NEW row with version_number = '
  'max(version_number) + 1 for the merchant. Decision 7 (versioned + immutable).';

comment on column public.voice_versions.profile is
  'Structured voice profile output from Sonnet 4.6. Schema enforced at '
  'application layer by the VoiceProfileSchema Zod validator in @lapsed/core.';

comment on column public.voice_versions.prompt_version is
  'Hash of the system prompt template used for this extraction. Enables '
  'replay if the prompt algorithm changes (decision 8).';

create index voice_versions_merchant_idx
  on public.voice_versions (merchant_id, extracted_at desc);

create index voice_versions_merchant_version_idx
  on public.voice_versions (merchant_id, version_number desc);

alter table public.voice_versions enable row level security;

create policy voice_versions_merchant_read
  on public.voice_versions for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- agent_profiles  (current state per merchant — materialized cache)
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per merchant. active_voice_version_id is updated atomically by the
-- materializer when a new voice version is activated. role_descriptor must be
-- drawn from the taxonomy enum exported from @lapsed/core (decision 11) —
-- a CHECK constraint enforces shape (lowercase letters and underscores only,
-- 1–48 chars) so freeform persona names ("Sarah") cannot be inserted.

create table if not exists public.agent_profiles (
  merchant_id              uuid          primary key references public.merchants(id) on delete cascade,
  active_voice_version_id  uuid          references public.voice_versions(id) on delete set null,
  role_descriptor          text          not null default 'win_back_specialist',
  channel_prefs            jsonb         not null default '{}',
    -- {primary: 'sms'|'email'|'voice', fallback?: 'sms'|'email'|'voice'}
  fallback_criteria        jsonb         not null default '{}',
    -- {confidence_threshold: number, escalate_after_turns?: number, escalate_on_intents: string[]}
  created_at               timestamptz   not null default now(),
  updated_at               timestamptz   not null default now(),
  constraint agent_profiles_role_descriptor_shape
    check (role_descriptor ~ '^[a-z][a-z_]{0,47}$')
);

comment on table public.agent_profiles is
  'Materialized agent identity per merchant. role_descriptor is taxonomy-'
  'constrained at the application layer (decision 11): freeform persona '
  'names are rejected at the TypeScript type level via @lapsed/core. The DB '
  'CHECK constraint enforces only shape (snake_case identifier) as a backstop.';

comment on column public.agent_profiles.role_descriptor is
  'Functional role descriptor from the taxonomy enum in @lapsed/core: '
  'win_back_specialist | customer_care_agent | loyalty_concierge | ... '
  'Never a personal name (decision 11).';

create trigger agent_profiles_set_updated_at
  before update on public.agent_profiles
  for each row execute function moddatetime(updated_at);

alter table public.agent_profiles enable row level security;

create policy agent_profiles_merchant_read
  on public.agent_profiles for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );
