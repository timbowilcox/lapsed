-- Sprint 06: AI Campaign Designer — campaign proposals, bandit arms, group
-- snapshots, holdout assignment, and the append-only campaign event log.
--
-- ARCHITECTURAL DECISIONS ENCODED HERE:
--
-- Decision 4 (bandit state as first-class data): bandit_state holds the
--   Thompson-sampling Beta(alpha, beta) posterior per arm. One row per
--   campaign_arms.bandit_arm_id. Initialized at Beta(1,1) at approval time.
--   Posterior statistic updates (Sprint 07) write alpha/beta/observation_count
--   on the existing row — that is NOT a violation of decision 14 (the arm's
--   identity/contract is immutable; only its statistics move).
--
-- Decision 13 (merchant-approved before any send): campaign_proposals.status
--   is a materialized cache. The canonical record is campaign_events. A
--   proposal is "ready" only when its latest campaign_events row is
--   `campaign_approved`. There is no auto-approval path — no timer column,
--   no escalation column, nothing the DB could use to self-approve.
--
-- Decision 14 (bandit arms versioned + immutable): campaign_arms rows are
--   write-once. Editing a campaign creates a NEW campaign_proposals row
--   (version_number + 1, supersedes_proposal_id set) with NEW campaign_arms.
--   The old arms + bandit_state are retained for audit. No UPDATE policy is
--   granted on campaign_arms; the immutability is convention + absence of a
--   write path, mirroring voice_versions (decision 7).
--
-- Decision 15 (group snapshots frozen at proposal creation):
--   campaign_group_snapshots is written once, at proposal time, with the
--   full customer set for the referenced group. Subsequent changes to the
--   group definition do not change these rows. included_in_holdout marks the
--   deterministic ~10% holdout. campaign_holdouts is a convenience view over
--   the held-out subset. Attribution math (Sprint 08) reads the snapshot,
--   never a live recompute.
--
-- Decision 12 mirror (event sourcing): campaign_events is append-only,
--   trigger-enforced via prevent_event_mutation() from migration 0002.
--   campaign_proposals + bandit_state are materialized caches regeneratable
--   by replaying campaign_events.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enum: campaign_proposal_status
-- ─────────────────────────────────────────────────────────────────────────────
-- Materialized status derived from the campaign_events log. `proposed` and
-- `edited` are both pending-review states; `approved`/`rejected` are terminal.

do $$ begin
  create type public.campaign_proposal_status as enum (
    'proposed',
    'approved',
    'rejected',
    'edited'
  );
exception when duplicate_object then null;
end $$;

comment on type public.campaign_proposal_status is
  'Materialized review status of a campaign proposal. Derived from the latest '
  'campaign_events row by materializeCampaign() in @lapsed/core. proposed/edited '
  'are pending-review; approved/rejected are terminal.';

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_proposals  (one row per proposal version — materialized cache)
-- ─────────────────────────────────────────────────────────────────────────────
-- Editing a campaign creates a NEW row (version_number + 1) with
-- supersedes_proposal_id pointing at the prior version. The prior row is
-- retained. status / approved_at / rejected_at / rejection_reason are
-- materialized from campaign_events — never the canonical truth.

create table if not exists public.campaign_proposals (
  id                      uuid          primary key default gen_random_uuid(),
  merchant_id             uuid          not null references public.merchants(id) on delete restrict,
  group_slug              text          not null,
    -- one of the system GroupSlug values from @lapsed/core customer-groups
  version_number          int           not null default 1,
  supersedes_proposal_id  uuid          references public.campaign_proposals(id) on delete restrict,
    -- null for a first proposal; set to the prior version when created by an edit
  status                  public.campaign_proposal_status not null default 'proposed',
  model_version           text          not null,
  generated_at            timestamptz   not null default now(),
  approved_at             timestamptz,
  approved_by_user_id     text,
  rejected_at             timestamptz,
  rejection_reason        text,
  created_at              timestamptz   not null default now(),
  constraint campaign_proposals_version_positive check (version_number >= 1)
);

comment on table public.campaign_proposals is
  'One row per campaign proposal version. Editing creates a new row '
  '(version_number + 1, supersedes_proposal_id set); the prior row is retained '
  'for audit (decision 14). status is materialized from campaign_events.';

comment on column public.campaign_proposals.group_slug is
  'System group identifier (lapsed_vips, at_risk_regulars, ...) from '
  '@lapsed/core customer-groups. Not an FK — groups are code-defined, not rows.';

comment on column public.campaign_proposals.status is
  'Materialized review status. Canonical truth is the campaign_events log; '
  'this column is a regeneratable cache (materializeCampaign).';

create index campaign_proposals_merchant_idx
  on public.campaign_proposals (merchant_id, generated_at desc);

create index campaign_proposals_merchant_status_idx
  on public.campaign_proposals (merchant_id, status, generated_at desc);

create index campaign_proposals_supersedes_idx
  on public.campaign_proposals (supersedes_proposal_id)
  where supersedes_proposal_id is not null;

alter table public.campaign_proposals enable row level security;

create policy campaign_proposals_merchant_read
  on public.campaign_proposals for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_arms  (one row per variant per proposal — write-once, decision 14)
-- ─────────────────────────────────────────────────────────────────────────────
-- A proposal has exactly 3 arms (enforced at the application layer by the
-- minItems=3 maxItems=3 designer schema). bandit_arm_id is the stable
-- identity the bandit_state row is keyed on.

create table if not exists public.campaign_arms (
  id                uuid          primary key default gen_random_uuid(),
  proposal_id       uuid          not null references public.campaign_proposals(id) on delete restrict,
  merchant_id       uuid          not null references public.merchants(id) on delete restrict,
  variant_index     smallint      not null,
    -- 0, 1, 2 — position within the proposal's 3 variants
  offer_type        text          not null,
  offer_value       text          not null,
  message_draft     text          not null,
  send_time_window  text          not null,
  tone              text          not null,
  expected_impact   jsonb         not null default '{}',
    -- {estimated_response_rate: number, estimated_recovered_revenue: number}
  bandit_arm_id     uuid          not null default gen_random_uuid(),
  created_at        timestamptz   not null default now(),
  constraint campaign_arms_proposal_variant_unique unique (proposal_id, variant_index),
  constraint campaign_arms_bandit_arm_unique unique (bandit_arm_id),
  constraint campaign_arms_variant_range check (variant_index >= 0 and variant_index <= 2),
  constraint campaign_arms_message_sms_length check (char_length(message_draft) <= 160)
);

comment on table public.campaign_arms is
  'One row per campaign variant. Write-once (decision 14): a campaign edit '
  'creates a new proposal version with new arms; existing arms are never '
  'UPDATE''d. bandit_arm_id is the stable key for the bandit_state posterior.';

comment on column public.campaign_arms.message_draft is
  'SMS-length message draft (<= 160 chars, CHECK-enforced). Written in the '
  'merchant''s active voice profile by the AI Campaign Designer (Sonnet 4.6).';

create index campaign_arms_proposal_idx
  on public.campaign_arms (proposal_id, variant_index);

create index campaign_arms_merchant_idx
  on public.campaign_arms (merchant_id);

alter table public.campaign_arms enable row level security;

create policy campaign_arms_merchant_read
  on public.campaign_arms for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- bandit_state  (Thompson-sampling Beta posterior per arm — decision 4)
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per campaign_arms.bandit_arm_id, written at approval time with the
-- neutral Beta(1,1) prior. Sprint 07 updates alpha/beta/observation_count as
-- real responses land — that statistic mutation is permitted; the arm's
-- identity (which bandit_arm_id, which proposal) never changes.

create table if not exists public.bandit_state (
  arm_id              uuid          primary key references public.campaign_arms(bandit_arm_id) on delete restrict,
  merchant_id         uuid          not null references public.merchants(id) on delete restrict,
  proposal_id         uuid          not null references public.campaign_proposals(id) on delete restrict,
  alpha               numeric       not null default 1,
  beta                numeric       not null default 1,
  observation_count   int           not null default 0,
  last_updated_at     timestamptz   not null default now(),
  created_at          timestamptz   not null default now(),
  constraint bandit_state_alpha_positive check (alpha > 0),
  constraint bandit_state_beta_positive check (beta > 0),
  constraint bandit_state_observations_nonneg check (observation_count >= 0)
);

comment on table public.bandit_state is
  'Thompson-sampling Beta(alpha, beta) posterior per campaign arm (decision 4). '
  'Initialized at Beta(1,1) when a proposal is approved. Sprint 07 updates the '
  'posterior statistics in-place as real responses arrive.';

create index bandit_state_proposal_idx
  on public.bandit_state (proposal_id);

create index bandit_state_merchant_idx
  on public.bandit_state (merchant_id);

alter table public.bandit_state enable row level security;

create policy bandit_state_merchant_read
  on public.bandit_state for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_group_snapshots  (frozen customer set per proposal — decision 15)
-- ─────────────────────────────────────────────────────────────────────────────
-- Written once, at proposal time, with the full customer set of the
-- referenced group. included_in_holdout marks the deterministic ~10% holdout.
-- Composite PK (proposal_id, customer_id) makes the snapshot write idempotent.

create table if not exists public.campaign_group_snapshots (
  proposal_id           uuid          not null references public.campaign_proposals(id) on delete restrict,
  merchant_id           uuid          not null references public.merchants(id) on delete restrict,
  customer_id           text          not null,
    -- shopify_customer_gid of a customer in the snapshotted group
  included_in_holdout   boolean       not null default false,
  created_at            timestamptz   not null default now(),
  constraint campaign_group_snapshots_pk primary key (proposal_id, customer_id)
);

comment on table public.campaign_group_snapshots is
  'Frozen customer set for a proposal, captured at proposal time (decision 15). '
  'Subsequent changes to the group definition do not alter these rows. '
  'included_in_holdout marks the deterministic holdout subset.';

create index campaign_group_snapshots_merchant_idx
  on public.campaign_group_snapshots (merchant_id);

create index campaign_group_snapshots_holdout_idx
  on public.campaign_group_snapshots (proposal_id)
  where included_in_holdout = true;

alter table public.campaign_group_snapshots enable row level security;

create policy campaign_group_snapshots_merchant_read
  on public.campaign_group_snapshots for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_holdouts  (convenience view over the held-out subset)
-- ─────────────────────────────────────────────────────────────────────────────
-- security_invoker = true so the view runs with the querying role's RLS —
-- the campaign_group_snapshots merchant-read policy applies through the view.

create or replace view public.campaign_holdouts
  with (security_invoker = true)
  as
  select proposal_id, merchant_id, customer_id, created_at
  from public.campaign_group_snapshots
  where included_in_holdout = true;

comment on view public.campaign_holdouts is
  'Convenience view materializing the deterministic holdout subset of each '
  'proposal''s group snapshot. security_invoker so RLS on the underlying '
  'campaign_group_snapshots table applies to view reads.';

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_events  (append-only event log — decision 12 mirror)
-- ─────────────────────────────────────────────────────────────────────────────
-- Event types (enforced in the application layer, not the DB, matching the
-- voice_events / customer_events pattern):
--   proposal_started   — payload: {} (orchestrator run begins)
--   campaign_proposed  — payload: {variant_count, model_version, tokens_input, tokens_output, retries}
--   arms_initialized   — payload: {arm_count}
--   campaign_approved  — payload: {user_id}
--   campaign_rejected  — payload: {user_id, reason}
--   proposal_edited    — payload: {user_id, new_proposal_id, fields_changed: []}
--   proposal_failed    — payload: {phase, reason}
--
-- payload NEVER contains customer PII or LLM-generated message text — only
-- IDs, counts, and metadata (mirrors the voice_events decision-10 contract).

create table if not exists public.campaign_events (
  id            uuid        primary key default gen_random_uuid(),
  merchant_id   uuid        not null references public.merchants(id) on delete restrict,
  proposal_id   uuid        not null references public.campaign_proposals(id) on delete restrict,
  event_type    text        not null,
  payload       jsonb       not null default '{}',
  occurred_at   timestamptz not null,
  ingested_at   timestamptz not null default now()
);

comment on table public.campaign_events is
  'Append-only event log for the campaign proposal lifecycle. Materialized '
  'state in campaign_proposals + bandit_state is regeneratable from this log. '
  'payload NEVER contains customer PII or generated message text.';

alter table public.campaign_events
  add constraint campaign_events_dedup_unique
  unique (merchant_id, proposal_id, event_type, occurred_at);

create index campaign_events_merchant_idx
  on public.campaign_events (merchant_id, occurred_at desc);

create index campaign_events_proposal_idx
  on public.campaign_events (proposal_id, occurred_at desc);

create index campaign_events_merchant_type_idx
  on public.campaign_events (merchant_id, event_type, occurred_at desc);

-- Append-only enforcement — reuses prevent_event_mutation() from migration 0002.
create trigger campaign_events_no_update
  before update on public.campaign_events
  for each row execute function prevent_event_mutation();

create trigger campaign_events_no_delete
  before delete on public.campaign_events
  for each row execute function prevent_event_mutation();

create trigger campaign_events_no_truncate
  before truncate on public.campaign_events
  for each statement execute function prevent_event_mutation();

alter table public.campaign_events enable row level security;

-- Authenticated merchant may read their own campaign events (powers the
-- approval surface status derivation). Service role writes via the
-- appendCampaignEvent helper in @lapsed/core.
create policy campaign_events_merchant_read
  on public.campaign_events for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );
