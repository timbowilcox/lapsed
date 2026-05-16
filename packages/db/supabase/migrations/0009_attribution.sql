-- Sprint 08: Attribution + Holdouts + LTV Restoration.
--
-- ARCHITECTURAL DECISIONS ENCODED HERE (20–26):
--
-- Decision 20 (attribution window per-merchant, immutable per proposal):
--   `merchant_attribution_config` holds the per-merchant `attribution_window_days`
--   (default 14) and `ltv_evaluation_window_days` (default 30). The window value
--   is STAMPED onto `campaign_proposals.attribution_window_days` at approval time
--   and is immutable thereafter. Changing the merchant default affects only
--   future approvals.
--
-- Decision 21 (single-attribution per order): `attribution_decisions` carries a
--   partial UNIQUE on `(order_id)` — exactly one final attribution per order.
--   Multi-campaign customers attribute to the most-recent-preceding outbound;
--   that selection lives in @lapsed/core attribution-treatment.
--
-- Decision 22 (bandit dual-signal posterior): `bandit_state` gains
--   `order_alpha`/`order_beta`/`order_observation_count`/`order_last_updated_at`.
--   Sprint 07's `alpha`/`beta` are renamed to `sentiment_alpha`/`sentiment_beta`
--   (RENAME COLUMN preserves all row data). The sentiment counters
--   (`observation_count`, `last_updated_at`) keep their names. Selection routes
--   to the order posterior when `order_observation_count >= 30`. Decision 14
--   still holds: arm identity is never mutated, only posterior counters move.
--
-- Decision 23 (LTV = cohort-relative delta): `ltv_snapshots` records per-customer
--   pre/post 30-day revenue markers. No stay-probability modelling.
--
-- Decision 24/25 (order events append-only / Shopify webhook ingestion): the
--   `orders` + `order_events` tables PRE-EXIST from migration 0002 (Sprint 03)
--   and are already append-only-triggered (order_events) and HMAC-ingested via
--   the unified /api/shopify/webhooks route's orders/paid handler. This sprint
--   EXTENDS them in place rather than recreating — see HANDOFF deliberate
--   deviations. No structural change to orders/order_events is required here;
--   attribution lookups are served by the new indexes below.
--
-- Decision 26 (attribution computed nightly, materialised): `attribution_results`
--   is written ONLY by /api/cron/attribution-batch. The UNIQUE on
--   `(campaign_id, window_close_date)` makes the recompute idempotent.
--
-- RLS WRITE POLICY: every new table below enables RLS with a merchant-scoped
-- SELECT policy ONLY. No INSERT/UPDATE/DELETE policy is granted to the
-- authenticated role — by design. All writes go through the service role
-- (the attribution batch cron, the proposal-approval pipeline), which bypasses
-- RLS entirely. The absence of a write policy is the enforcement: a
-- merchant-scoped client physically cannot write these tables. This mirrors
-- the campaign_proposals / bandit_state pattern from migration 0007.
--
-- NO EMBEDDING COLUMNS ON THESE TABLES. Decision 2's pgvector requirement
-- applies to narrative-content tables (customer_events, conversations, messages,
-- voice_profile, campaign_proposals). Sprint 08's tables are purely quantitative
-- (orders, attribution_decisions, attribution_results, ltv_snapshots,
-- merchant_attribution_config) — they carry no narrative text to embed. This is
-- noted explicitly so the architecture-guardian does not false-flag the absence.

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_proposals.attribution_window_days  (decision 20)
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT 14: the default backfills every existing proposal row
-- (including already-approved proposals) to the v1 window of 14 days. The
-- approval pipeline OVERWRITES this with the merchant's current configured
-- value exactly once, at approval time, after which it is immutable (decision
-- 20). No code path may UPDATE this column after the campaign_approved event.

alter table public.campaign_proposals
  add column if not exists attribution_window_days int not null default 14;

comment on column public.campaign_proposals.attribution_window_days is
  'Attribution window in days, stamped from merchant_attribution_config at '
  'approval time and immutable thereafter (decision 20). DEFAULT 14 backfills '
  'pre-Sprint-08 proposals and seeds not-yet-approved proposals.';

-- ─────────────────────────────────────────────────────────────────────────────
-- bandit_state dual-signal posterior  (decision 22)
-- ─────────────────────────────────────────────────────────────────────────────
-- Sprint 07 shipped a single Beta(alpha, beta) posterior fired by inbound
-- sentiment classification. Sprint 08 adds a second, independent Beta posterior
-- fired by attributed-order arrival (ground truth, lagging). The two posteriors
-- NEVER cross-contaminate: a sentiment update touches sentiment_*, an order
-- update touches order_*. RENAME COLUMN preserves the existing posterior data.

alter table public.bandit_state rename column alpha to sentiment_alpha;
alter table public.bandit_state rename column beta to sentiment_beta;

alter table public.bandit_state
  rename constraint bandit_state_alpha_positive to bandit_state_sentiment_alpha_positive;
alter table public.bandit_state
  rename constraint bandit_state_beta_positive to bandit_state_sentiment_beta_positive;

alter table public.bandit_state
  add column if not exists order_alpha numeric not null default 1,
  add column if not exists order_beta numeric not null default 1,
  add column if not exists order_observation_count int not null default 0,
  add column if not exists order_last_updated_at timestamptz;

alter table public.bandit_state
  add constraint bandit_state_order_alpha_positive check (order_alpha > 0),
  add constraint bandit_state_order_beta_positive check (order_beta > 0),
  add constraint bandit_state_order_observations_nonneg
    check (order_observation_count >= 0);

comment on column public.bandit_state.sentiment_alpha is
  'Beta posterior alpha fired by inbound sentiment classification (Sprint 07). '
  'Renamed from alpha. Leading signal — fast but noisy.';
comment on column public.bandit_state.order_alpha is
  'Beta posterior alpha fired by attributed-order arrival (Sprint 08, decision '
  '22). Lagging signal — slow but ground truth. Never cross-contaminates the '
  'sentiment posterior.';
comment on column public.bandit_state.order_observation_count is
  'Count of order-signal observations folded into the order posterior. Arm '
  'selection uses the order posterior once this reaches 30, else sentiment.';

-- ─────────────────────────────────────────────────────────────────────────────
-- merchant_attribution_config  (decision 20)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.merchant_attribution_config (
  merchant_id                uuid          primary key references public.merchants(id) on delete restrict,
  attribution_window_days    int           not null default 14,
  ltv_evaluation_window_days int           not null default 30,
  created_at                 timestamptz   not null default now(),
  updated_at                 timestamptz   not null default now(),
  constraint merchant_attribution_config_window_positive
    check (attribution_window_days >= 1 and attribution_window_days <= 90),
  constraint merchant_attribution_config_ltv_window_positive
    check (ltv_evaluation_window_days >= 1 and ltv_evaluation_window_days <= 365)
);

comment on table public.merchant_attribution_config is
  'Per-merchant attribution settings (decision 20). attribution_window_days is '
  'stamped onto a proposal at approval time; subsequent changes here affect '
  'only future approvals. A merchant with no row falls back to the defaults '
  '(14 / 30) in @lapsed/core attribution-config.';

create trigger merchant_attribution_config_set_updated_at
  before update on public.merchant_attribution_config
  for each row execute function moddatetime(updated_at);

alter table public.merchant_attribution_config enable row level security;

create policy merchant_attribution_config_merchant_read
  on public.merchant_attribution_config for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- attribution_decisions  (append-only audit — decision 21)
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per attributed order (decision_type = 'attributed', order_id set) OR
-- one row per treatment-cohort customer who placed no order before window-close
-- (decision_type = 'no_order', order_id NULL, customer_id set). The partial
-- UNIQUE on (order_id) enforces single-attribution: an order is decided exactly
-- once. The partial UNIQUE on (attributed_campaign_id, customer_id) for
-- 'no_order' rows makes the window-close failure-signal sweep idempotent.

create table if not exists public.attribution_decisions (
  id                      uuid        primary key default gen_random_uuid(),
  merchant_id             uuid        not null references public.merchants(id) on delete restrict,
  order_id                uuid        references public.orders(id) on delete restrict,
  customer_id             text,
  decision_type           text        not null default 'attributed',
  attributed_campaign_id  uuid        references public.campaign_proposals(id) on delete restrict,
  attributed_message_id   uuid        references public.messages(id) on delete restrict,
  attribution_window_days int         not null,
  decided_at              timestamptz not null default now(),
  constraint attribution_decisions_type_check
    check (decision_type in ('attributed', 'no_order')),
  -- An 'attributed' decision must reference an order; a 'no_order' decision
  -- must reference a customer and a campaign (and never an order). The
  -- campaign is mandatory on no_order rows so the partial UNIQUE on
  -- (attributed_campaign_id, customer_id) actually enforces one-row-per
  -- (campaign, customer) — a NULL campaign would defeat that idempotency.
  constraint attribution_decisions_shape_check check (
    (decision_type = 'attributed' and order_id is not null)
    or (
      decision_type = 'no_order'
      and order_id is null
      and customer_id is not null
      and attributed_campaign_id is not null
    )
  )
);

comment on table public.attribution_decisions is
  'Append-only attribution audit (decision 21). One row per attributed order '
  '(most-recent-preceding outbound wins) plus one row per no-order treatment '
  'customer at window-close. The order_id partial UNIQUE guarantees an order '
  'is attributed exactly once.';

-- Decision 21: exactly one final attribution per order.
create unique index attribution_decisions_order_unique
  on public.attribution_decisions (order_id)
  where order_id is not null;

-- Idempotent window-close no-order failure-signal sweep (chunk 9).
create unique index attribution_decisions_no_order_unique
  on public.attribution_decisions (attributed_campaign_id, customer_id)
  where decision_type = 'no_order';

create index attribution_decisions_campaign_idx
  on public.attribution_decisions (attributed_campaign_id, decided_at desc);

create index attribution_decisions_merchant_idx
  on public.attribution_decisions (merchant_id, decided_at desc);

-- Append-only enforcement — reuses prevent_event_mutation() from migration 0002.
create trigger attribution_decisions_no_update
  before update on public.attribution_decisions
  for each row execute function prevent_event_mutation();

create trigger attribution_decisions_no_delete
  before delete on public.attribution_decisions
  for each row execute function prevent_event_mutation();

create trigger attribution_decisions_no_truncate
  before truncate on public.attribution_decisions
  for each statement execute function prevent_event_mutation();

alter table public.attribution_decisions enable row level security;

create policy attribution_decisions_merchant_read
  on public.attribution_decisions for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- attribution_results  (materialised — decision 26)
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per (campaign, window-close-date). Written ONLY by the attribution
-- batch cron. All currency in integer cents (bigint) — never float dollars.
-- CI columns are NULL when insufficient_evidence = true (cohort < 30).

create table if not exists public.attribution_results (
  id                        uuid        primary key default gen_random_uuid(),
  merchant_id               uuid        not null references public.merchants(id) on delete restrict,
  campaign_id               uuid        not null references public.campaign_proposals(id) on delete restrict,
  window_close_date         date        not null,
  treatment_cohort_size     int         not null,
  holdout_cohort_size       int         not null,
  treatment_revenue_cents   bigint      not null,
  holdout_revenue_cents     bigint      not null,
  incremental_revenue_cents bigint      not null,
  incremental_ci_low_cents  bigint,
  incremental_ci_high_cents bigint,
  ltv_restored_cents        bigint      not null,
  ltv_ci_low_cents          bigint,
  ltv_ci_high_cents         bigint,
  insufficient_evidence     boolean     not null default false,
  computed_at               timestamptz not null default now(),
  constraint attribution_results_campaign_window_unique
    unique (campaign_id, window_close_date),
  constraint attribution_results_cohort_sizes_nonneg
    check (treatment_cohort_size >= 0 and holdout_cohort_size >= 0)
);

comment on table public.attribution_results is
  'Materialised per-campaign attribution result (decision 26). The attribution '
  'batch cron is the ONLY write path; the UNIQUE on (campaign_id, '
  'window_close_date) makes recompute idempotent. UI reads from here, never '
  'from computeIncrementalRevenue directly. All amounts are integer cents.';

create index attribution_results_merchant_window_idx
  on public.attribution_results (merchant_id, window_close_date desc);

create index attribution_results_campaign_idx
  on public.attribution_results (campaign_id, window_close_date desc);

alter table public.attribution_results enable row level security;

create policy attribution_results_merchant_read
  on public.attribution_results for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- ltv_snapshots  (per-customer LTV markers — decision 23)
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per (campaign, treatment customer). delta_cents is the per-customer
-- restoration delta against the holdout baseline. UNIQUE makes the chunk-8
-- recompute idempotent. All amounts integer cents.

create table if not exists public.ltv_snapshots (
  id                     uuid        primary key default gen_random_uuid(),
  merchant_id            uuid        not null references public.merchants(id) on delete restrict,
  campaign_id            uuid        not null references public.campaign_proposals(id) on delete restrict,
  customer_id            text        not null,
  pre_30d_revenue_cents  bigint      not null,
  post_30d_revenue_cents bigint      not null,
  delta_cents            bigint      not null,
  snapshot_at            timestamptz not null default now(),
  constraint ltv_snapshots_campaign_customer_unique
    unique (campaign_id, customer_id)
);

comment on table public.ltv_snapshots is
  'Per-customer pre/post 30-day revenue markers feeding the cohort-relative LTV '
  'restoration delta (decision 23). delta_cents = post_30d_revenue_cents minus '
  'the holdout cohort mean. UNIQUE (campaign_id, customer_id) keeps recompute '
  'idempotent.';

create index ltv_snapshots_merchant_campaign_idx
  on public.ltv_snapshots (merchant_id, campaign_id);

alter table public.ltv_snapshots enable row level security;

create policy ltv_snapshots_merchant_read
  on public.ltv_snapshots for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Attribution lookup indexes on the pre-existing orders table
-- ─────────────────────────────────────────────────────────────────────────────
-- The treatment/holdout engines scan orders by (merchant, customer, placed-at)
-- and by (merchant, placed-at). shopify_created_at is the placed-at timestamp.

create index if not exists orders_merchant_customer_placed_idx
  on public.orders (merchant_id, shopify_customer_gid, shopify_created_at);

create index if not exists orders_merchant_placed_idx
  on public.orders (merchant_id, shopify_created_at);
