-- Sprint 04: customer intelligence layer — scoring, lifecycle classification,
-- group auto-detection, and cost-capped Haiku scoring runs.
--
-- ARCHITECTURAL DECISIONS ENCODED HERE:
--
-- Decision 1 (event sourcing): scoring outputs write a customer_scored event
--   to customer_events before updating customer_inferred_state. The inferred
--   state table is a regeneratable cache — never the canonical truth.
--
-- Decision 4 (bandit): scoring_runs records the model version and token
--   accounting that Sprint 06's bandit loop will read for outcome attribution.
--
-- Inferred state purity: customer_inferred_state is fully regeneratable by
--   replaying the event log + running classifyLifecycle + assignGroups +
--   the Haiku scoring service. It MUST NOT hold data not derivable from that
--   replay. Any column that cannot be regenerated belongs in customers instead.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enum: lifecycle_stage
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.lifecycle_stage as enum (
    'new',
    'engaged',
    'at_risk',
    'lapsed',
    'won_back',
    'churned'
  );
exception when duplicate_object then null;
end $$;

comment on type public.lifecycle_stage is
  'Deterministic lifecycle classification for a customer. Computed by '
  'classifyLifecycle() in @lapsed/core. Written nightly to customer_inferred_state.';

-- ─────────────────────────────────────────────────────────────────────────────
-- customer_rfm  (materialised RFM scores — regeneratable from order_events)
--
-- Separate from customers (identity) so that nightly refresh only touches
-- scoring columns, not identity columns. Keyed on (merchant_id, shopify_customer_gid).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.customer_rfm (
  id                    uuid          primary key default gen_random_uuid(),
  merchant_id           uuid          not null references public.merchants(id) on delete restrict,
  shopify_customer_gid  text          not null,
  recency_days          int,          -- days since last order (NULL = no orders)
  frequency             int           not null default 0, -- total order count
  monetary_cents        bigint        not null default 0, -- total LTV in cents
  recency_score         smallint,     -- 1–5 derived percentile band (5 = most recent)
  frequency_score       smallint,     -- 1–5 derived percentile band
  monetary_score        smallint,     -- 1–5 derived percentile band
  rfm_combined          smallint,     -- recency_score * 100 + frequency_score * 10 + monetary_score
  lifecycle_stage       public.lifecycle_stage,
  refreshed_at          timestamptz   not null default now(),
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  constraint customer_rfm_merchant_gid_unique unique (merchant_id, shopify_customer_gid)
);

comment on table public.customer_rfm is
  'Materialised RFM scores and lifecycle classification. Fully regeneratable from '
  'order_events by running the nightly RFM batch. Never the canonical source — '
  'the event log is. Updated nightly after materializeCustomer completes.';

comment on column public.customer_rfm.lifecycle_stage is
  'Written by the nightly RFM batch after calling classifyLifecycle(). '
  'NULL until first batch run.';

create trigger customer_rfm_set_updated_at
  before update on public.customer_rfm
  for each row execute function moddatetime(updated_at);

create index customer_rfm_merchant_idx
  on public.customer_rfm (merchant_id);

create index customer_rfm_lifecycle_idx
  on public.customer_rfm (merchant_id, lifecycle_stage)
  where lifecycle_stage is not null;

alter table public.customer_rfm enable row level security;

create policy customer_rfm_merchant_read
  on public.customer_rfm for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- scoring_runs  (audit log for every Haiku scoring invocation per merchant)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.scoring_runs (
  id                uuid          primary key default gen_random_uuid(),
  merchant_id       uuid          not null references public.merchants(id) on delete restrict,
  started_at        timestamptz   not null default now(),
  finished_at       timestamptz,
  model_version     text          not null,
  customers_scored  int           not null default 0,
  tokens_input      int           not null default 0,
  tokens_output     int           not null default 0,
  cost_cents        int           not null default 0,
  status            text          not null default 'running'
                                  check (status in ('running', 'succeeded', 'failed')),
  error_message     text,
  created_at        timestamptz   not null default now()
);

comment on table public.scoring_runs is
  'Audit log of every Haiku scoring run. Provides cost accounting per merchant '
  'and the traceability link for customer_inferred_state.score_run_id. '
  'The Sprint 06 bandit loop reads model_version + token counts for outcome learning.';

comment on column public.scoring_runs.status is
  'running → succeeded or failed. Never updated to anything else.';

create index scoring_runs_merchant_idx
  on public.scoring_runs (merchant_id, started_at desc);

create index scoring_runs_status_idx
  on public.scoring_runs (merchant_id, status)
  where status = 'running';

alter table public.scoring_runs enable row level security;

-- Authenticated merchant may read their own scoring run history.
create policy scoring_runs_merchant_read
  on public.scoring_runs for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- merchant_scoring_caps  (per-merchant daily token budget)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.merchant_scoring_caps (
  id                uuid          primary key default gen_random_uuid(),
  merchant_id       uuid          not null references public.merchants(id) on delete restrict,
  daily_token_cap   int           not null default 10000000,
  period_start      date          not null default current_date,
  tokens_used_today int           not null default 0,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  constraint merchant_scoring_caps_merchant_unique unique (merchant_id)
);

comment on table public.merchant_scoring_caps is
  'Per-merchant daily token budget for Haiku scoring. The scoring job checks '
  'tokens_used_today against daily_token_cap before each batch, and halts if '
  'the cap is reached. Reset daily by the cron job.';

comment on column public.merchant_scoring_caps.period_start is
  'The date this token count applies to. If period_start < current_date, '
  'the scoring job resets tokens_used_today to 0 before adding new usage.';

create trigger merchant_scoring_caps_set_updated_at
  before update on public.merchant_scoring_caps
  for each row execute function moddatetime(updated_at);

alter table public.merchant_scoring_caps enable row level security;

-- Authenticated merchant may read their own cap row.
create policy merchant_scoring_caps_merchant_read
  on public.merchant_scoring_caps for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- customer_inferred_state  (scoring + grouping cache — fully regeneratable)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.customer_inferred_state (
  id                            uuid          primary key default gen_random_uuid(),
  merchant_id                   uuid          not null references public.merchants(id) on delete restrict,
  shopify_customer_gid          text          not null,
  -- Scoring outputs from Haiku
  propensity_30d                numeric(5,4),   -- 0.0000 – 1.0000; NULL until scored
  propensity_60d                numeric(5,4),
  propensity_90d                numeric(5,4),
  predicted_residual_ltv_cents  bigint,
  top_signal                    text,           -- ≤ 100 chars debug string from Haiku
  -- Lifecycle + group assignments (written by nightly batch, derived from events)
  lifecycle_stage               public.lifecycle_stage,
  group_memberships             text[]          not null default '{}',
  -- Scoring run provenance
  score_model_version           text,
  score_run_id                  uuid            references public.scoring_runs(id) on delete set null,
  last_scored_at                timestamptz,
  last_engagement_event_at      timestamptz,    -- checkpoint for incremental scoring skip logic
  created_at                    timestamptz     not null default now(),
  updated_at                    timestamptz     not null default now(),
  constraint customer_inferred_state_merchant_gid_unique
    unique (merchant_id, shopify_customer_gid)
);

comment on table public.customer_inferred_state is
  'Scoring and grouping cache. Fully regeneratable by running classifyLifecycle() '
  '+ assignGroups() + the Haiku propensity service against the event log. '
  'NEVER use this as the canonical source for business decisions — cross-reference '
  'the event log. Updated nightly after scoring run completes.';

comment on column public.customer_inferred_state.propensity_30d is
  'Probability of placing an order in the next 30 days (0–1), from Haiku. '
  'NULL until first scoring run.';

comment on column public.customer_inferred_state.top_signal is
  'One-line human-readable signal from Haiku (≤ 100 chars). For debugging and '
  'UI display only. Not used for any business logic.';

comment on column public.customer_inferred_state.last_engagement_event_at is
  'Checkpoint: timestamp of the most recent customer_events row for this customer '
  'when the last scoring run started. Used by incremental scoring: if this matches '
  'the current latest event timestamp and lifecycle_stage is unchanged, the scoring '
  'job skips this customer.';

create trigger customer_inferred_state_set_updated_at
  before update on public.customer_inferred_state
  for each row execute function moddatetime(updated_at);

create index customer_inferred_state_merchant_idx
  on public.customer_inferred_state (merchant_id);

create index customer_inferred_state_propensity_idx
  on public.customer_inferred_state (merchant_id, propensity_30d desc nulls last)
  where propensity_30d is not null;

create index customer_inferred_state_lifecycle_idx
  on public.customer_inferred_state (merchant_id, lifecycle_stage)
  where lifecycle_stage is not null;

-- GIN index for group_memberships array queries (e.g., WHERE 'lapsed_vips' = ANY(group_memberships))
create index customer_inferred_state_groups_idx
  on public.customer_inferred_state using gin (group_memberships);

alter table public.customer_inferred_state enable row level security;

create policy customer_inferred_state_merchant_read
  on public.customer_inferred_state for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- merchant_aggregates  (nightly materialized view — percentile / median context
--                       for group template evaluation)
-- ─────────────────────────────────────────────────────────────────────────────

create materialized view if not exists public.merchant_aggregates as
select
  c.merchant_id,
  count(*)                                              as total_customers,
  count(*) filter (where c.lapsed_at is not null)       as total_lapsed,
  percentile_cont(0.5) within group (
    order by c.total_ltv_cents
  )::bigint                                             as median_ltv_cents,
  percentile_cont(0.5) within group (
    order by case
      when c.total_order_count > 0
        then c.total_ltv_cents::numeric / c.total_order_count
    end
  )::bigint                                             as median_aov_cents,
  -- LTV decile thresholds (used for Lapsed VIP detection — top 10%)
  percentile_cont(0.90) within group (
    order by c.total_ltv_cents
  )::bigint                                             as ltv_p90_cents,
  percentile_cont(0.75) within group (
    order by c.total_ltv_cents
  )::bigint                                             as ltv_p75_cents,
  now()                                                 as refreshed_at
from public.customers c
where c.total_order_count > 0
group by c.merchant_id;

comment on materialized view public.merchant_aggregates is
  'Nightly merchant-level aggregate statistics used by the group auto-detection '
  'templates (median AOV, LTV deciles, etc.). Refreshed by the nightly scoring '
  'job after materializeCustomer completes. Must NOT be used for billing math '
  '(see CLAUDE.md decision 6 — billing uses incrementality-adjusted attribution).';

-- Unique index on merchant_id so REFRESH CONCURRENTLY is possible in the future.
create unique index if not exists merchant_aggregates_merchant_idx
  on public.merchant_aggregates (merchant_id);
