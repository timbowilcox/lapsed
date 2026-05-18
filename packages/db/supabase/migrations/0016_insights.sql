-- Sprint 11, Chunk 8: AI Insights/Recommendations engine (decision 36).
--
-- ARCHITECTURAL DECISION ENCODED HERE:
--
-- Decision 36 (Recommendations engine is deterministic): The insights table
--   is the append-only output of a deterministic signal-evaluation engine.
--   No LLM calls. Recommendations are derived from existing DB signals
--   (RFM scores, cohort sizes, bandit posteriors, opt-out trends, reply
--   rates, payment/subscription status). No ML models, no new LLM calls.
--
-- APPEND-ONLY SEMANTICS:
--   State changes (dismiss, act, snooze) write new rows rather than
--   mutating existing ones. `getActiveInsights` uses DISTINCT ON
--   (merchant_id, insight_key) ordered by created_at DESC to resolve the
--   current state per key. A dismissed insight naturally re-activates if the
--   signal crosses the threshold again on a later evaluation cycle.
--
--   expires_at is set to now() + 18h at insertion time. The background job
--   runs every 6 hours; a non-expired active row suppresses re-insertion
--   (idempotency). If the signal un-crosses its threshold, no re-insertion
--   happens and the insight expires naturally after 18h.
--
-- WRITE POLICY: only the service role writes (cron job via
--   /api/cron/insights, state-change routes). The authenticated role
--   receives a SELECT-only RLS policy. No INSERT/UPDATE/DELETE policy is
--   granted to authenticated — RLS denies by default.
--
-- NOTE ON EMBEDDING COLUMNS: Decision 2's pgvector requirement applies to
--   narrative-content tables (customer_events, conversations, messages).
--   The insights table is purely quantitative signal state — no narrative
--   text to embed. Same rationale as attribution_results and
--   merchant_subscriptions.

create table if not exists public.insights (
  id            uuid        primary key default gen_random_uuid(),
  merchant_id   uuid        not null references public.merchants(id) on delete restrict,
  insight_key   text        not null,
    -- Stable, merchant-scoped identifier for the recommendation type.
    -- e.g. "cohort:lapsed_vip_dormancy", "arm:performance_gap:{proposal_id}".
    -- Used by DISTINCT ON to resolve current state per signal type.
  priority      text        not null,
  category      text        not null,
  signal_metric text        not null,
  signal_value  numeric     not null,
  threshold     numeric     not null,
  merchant_copy text        not null,
  cta_action    jsonb       not null,
  state         text        not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  constraint insights_priority_check
    check (priority in ('HIGH', 'MEDIUM', 'LOW')),
  constraint insights_category_check
    check (category in ('cohort', 'arm', 'opt_out', 'conversation', 'payment')),
  constraint insights_state_check
    check (state in ('active', 'dismissed', 'acted', 'snoozed'))
);

comment on table public.insights is
  'AI Insights/Recommendations engine output (decision 36). Append-only: '
  'state changes write new rows. Current state resolved via DISTINCT ON '
  '(merchant_id, insight_key) ORDER BY created_at DESC. No LLM calls.';

comment on column public.insights.insight_key is
  'Stable merchant-scoped recommendation type key. Used for DISTINCT ON '
  'resolution and idempotency suppression within the 18-hour expiry window.';

comment on column public.insights.merchant_copy is
  'Rendered merchant-facing recommendation text (decision 35: no internal '
  'terminology). Never contains sprint names, table names, or code ids.';

comment on column public.insights.cta_action is
  'JSON {route: string, params?: Record<string,string>} for the CTA button.';

comment on column public.insights.expires_at is
  'When this active row''s signal validity ends. Set to now() + 18h at '
  'creation; re-inserted every 6h if the threshold remains crossed. When '
  'the signal un-crosses, no refresh happens and the insight expires here.';

-- Query pattern for getActiveInsights:
--   SELECT DISTINCT ON (merchant_id, insight_key) * FROM insights
--   WHERE merchant_id = $1
--   ORDER BY merchant_id, insight_key, created_at DESC
--   (filtered to state='active' AND (expires_at IS NULL OR expires_at > now()))
create index insights_merchant_key_idx
  on public.insights (merchant_id, insight_key, created_at desc);

create index insights_merchant_state_idx
  on public.insights (merchant_id, state, created_at desc);

alter table public.insights enable row level security;

-- SELECT-only: authenticated merchant reads own insights.
-- Writes are service-role only (cron + state-change routes bypass RLS).
create policy insights_merchant_read
  on public.insights for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );
