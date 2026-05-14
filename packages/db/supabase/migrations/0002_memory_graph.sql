-- Sprint 03: customer memory graph, order events, conversations with pgvector,
-- and the webhook delivery log.
--
-- ARCHITECTURAL DECISIONS ENCODED HERE:
--
-- 1. Event-sourced memory graph (Decision 1): customer_events and order_events
--    are append-only. A BEFORE trigger on each raises an exception for any
--    UPDATE or DELETE, even from service_role. Materialised profiles in
--    `customers` and `orders` are regenerated from the event log; they are
--    never the canonical source of truth.
--
-- 2. pgvector from Sprint 03 (Decision 2): conversations and
--    conversation_messages both carry a vector(1536) embedding column with an
--    ivfflat index. Adding vector search to an existing schema is expensive;
--    getting it right on first build is not.
--
-- 3. Channel-agnostic conversation engine (Decision 3): `channel` is a TEXT
--    column, not an enum and not a hardcoded 'sms' constraint. The default is
--    'sms' because v1 ships SMS-only, but the type system never closes the door.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists vector;         -- pgvector
create extension if not exists moddatetime;   -- updated_at auto-stamp (also in 0001; idempotent)

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: prevent any mutation of an append-only table.
-- Both UPDATE and DELETE triggers on event tables call this function.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function prevent_event_mutation() returns trigger
  language plpgsql as $$
begin
  raise exception
    'Table % is append-only. UPDATE and DELETE are not permitted.',
    tg_table_name;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- customer_events  (append-only canonical record of customer state changes)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.customer_events (
  id                    uuid          primary key default gen_random_uuid(),
  merchant_id           uuid          not null references public.merchants(id) on delete restrict,
  shopify_customer_gid  text          not null,
  event_type            text          not null,
  source                text          not null,
  payload               jsonb         not null default '{}',
  occurred_at           timestamptz   not null,
  ingested_at           timestamptz   not null default now()
);

comment on table public.customer_events is
  'Append-only event log. Every customer state change is inserted here. '
  'No UPDATE, DELETE, or TRUNCATE is permitted — enforced by triggers and RLS.';

-- Dedup constraint: backfill may run multiple times; ON CONFLICT DO NOTHING on insert.
alter table public.customer_events
  add constraint customer_events_dedup_unique
  unique (merchant_id, shopify_customer_gid, event_type, source, occurred_at);

create index customer_events_merchant_customer_idx
  on public.customer_events (merchant_id, shopify_customer_gid);

create index customer_events_occurred_at_idx
  on public.customer_events (merchant_id, occurred_at desc);

create trigger customer_events_no_update
  before update on public.customer_events
  for each row execute function prevent_event_mutation();

create trigger customer_events_no_delete
  before delete on public.customer_events
  for each row execute function prevent_event_mutation();

-- TRUNCATE fires neither row-level trigger; block it explicitly at statement level.
create trigger customer_events_no_truncate
  before truncate on public.customer_events
  for each statement execute function prevent_event_mutation();

alter table public.customer_events enable row level security;

-- Authenticated merchant can read their own events.
-- Service_role bypasses RLS for writes (the security boundary is HMAC + auth).
create policy customer_events_merchant_read
  on public.customer_events for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- customers  (materialised profile — regenerated from customer_events nightly)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.customers (
  id                    uuid          primary key default gen_random_uuid(),
  merchant_id           uuid          not null references public.merchants(id) on delete restrict,
  shopify_customer_gid  text          not null,
  email                 text,
  phone                 text,
  first_name            text,
  last_name             text,
  tags                  text[]        not null default '{}',
  total_order_count     int           not null default 0,
  total_ltv_cents       bigint        not null default 0,
  last_order_at         timestamptz,
  last_order_days_ago   int,
  lapsed_score          numeric,
  lapsed_at             timestamptz,
  restored_at           timestamptz,
  sms_opt_out           boolean       not null default false,
  sms_opt_out_at        timestamptz,
  profile_version       int           not null default 1,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  constraint customers_merchant_gid_unique unique (merchant_id, shopify_customer_gid)
);

comment on table public.customers is
  'Materialised customer profile. Regenerated from customer_events by the '
  'nightly batch job (Sprint 04) and eagerly after each webhook event (Sprint 03). '
  'lapsed_score and lapsed_at are null until Sprint 04 runs the scoring engine.';

comment on column public.customers.lapsed_score is
  'NULL until Sprint 04 scoring engine populates this. Do not read before then.';

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function moddatetime(updated_at);

create index customers_merchant_idx
  on public.customers (merchant_id);

create index customers_merchant_lapsed_idx
  on public.customers (merchant_id, lapsed_score desc nulls last)
  where lapsed_at is not null;

alter table public.customers enable row level security;

create policy customers_merchant_read
  on public.customers for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- order_events  (append-only)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.order_events (
  id                    uuid          primary key default gen_random_uuid(),
  merchant_id           uuid          not null references public.merchants(id) on delete restrict,
  shopify_customer_gid  text          not null,
  shopify_order_gid     text          not null,
  event_type            text          not null,
  source                text          not null,
  payload               jsonb         not null default '{}',
  occurred_at           timestamptz   not null,
  ingested_at           timestamptz   not null default now()
);

comment on table public.order_events is
  'Append-only event log for order lifecycle events. Same append-only enforcement '
  'as customer_events. The orders table is materialised from these events.';

-- Dedup constraint: backfill may run multiple times; ON CONFLICT DO NOTHING on insert.
alter table public.order_events
  add constraint order_events_dedup_unique
  unique (merchant_id, shopify_order_gid, event_type, source, occurred_at);

create index order_events_merchant_customer_idx
  on public.order_events (merchant_id, shopify_customer_gid);

create index order_events_merchant_order_idx
  on public.order_events (merchant_id, shopify_order_gid);

create trigger order_events_no_update
  before update on public.order_events
  for each row execute function prevent_event_mutation();

create trigger order_events_no_delete
  before delete on public.order_events
  for each row execute function prevent_event_mutation();

-- TRUNCATE fires neither row-level trigger; block it explicitly at statement level.
create trigger order_events_no_truncate
  before truncate on public.order_events
  for each statement execute function prevent_event_mutation();

alter table public.order_events enable row level security;

create policy order_events_merchant_read
  on public.order_events for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- orders  (materialised from order_events)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.orders (
  id                    uuid          primary key default gen_random_uuid(),
  merchant_id           uuid          not null references public.merchants(id) on delete restrict,
  shopify_order_gid     text          not null,
  shopify_customer_gid  text          not null,
  total_price_cents     bigint        not null,
  financial_status      text          not null,
  fulfilled_at          timestamptz,
  shopify_created_at    timestamptz   not null,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  constraint orders_merchant_gid_unique unique (merchant_id, shopify_order_gid)
);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function moddatetime(updated_at);

create index orders_merchant_customer_idx
  on public.orders (merchant_id, shopify_customer_gid);

alter table public.orders enable row level security;

create policy orders_merchant_read
  on public.orders for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- products  (denormalised snapshot — not event-sourced; products are reference
--            data for scoring, not a customer memory construct)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.products (
  id                    uuid          primary key default gen_random_uuid(),
  merchant_id           uuid          not null references public.merchants(id) on delete restrict,
  shopify_product_gid   text          not null,
  title                 text          not null,
  handle                text          not null,
  product_type          text          not null default '',
  price_cents           bigint        not null default 0,
  inventory_quantity    int           not null default 0,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  constraint products_merchant_gid_unique unique (merchant_id, shopify_product_gid)
);

create trigger products_set_updated_at
  before update on public.products
  for each row execute function moddatetime(updated_at);

create index products_merchant_idx
  on public.products (merchant_id);

alter table public.products enable row level security;

create policy products_merchant_read
  on public.products for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- conversations  (channel-agnostic; embedding for semantic search)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.conversations (
  id                        uuid          primary key default gen_random_uuid(),
  merchant_id               uuid          not null references public.merchants(id) on delete restrict,
  shopify_customer_gid      text          not null,
  campaign_id               uuid,
  channel                   text          not null default 'sms',
  status                    text          not null default 'active',
  last_message_at           timestamptz,
  message_count             int           not null default 0,
  attributed_order_gid      text,
  attributed_revenue_cents  bigint,
  embedding                 vector(1536),
  created_at                timestamptz   not null default now(),
  updated_at                timestamptz   not null default now()
);

comment on column public.conversations.channel is
  'Channel is text (not enum) by design. v1 ships sms only but the engine '
  'is channel-agnostic. Do not add an enum constraint here.';

comment on column public.conversations.embedding is
  'Semantic embedding of the full conversation transcript. 1536-dimensional '
  'vector for compatibility with OpenAI ada-002 / text-embedding-3-small '
  'and Voyage AI voyage-3. Populated by the embedding background job (Sprint 06). '
  'NULL until first embedding run.';

comment on column public.conversations.attributed_order_gid is
  'NULL until Sprint 08 attribution reconciliation runs. Do not read before then.';

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function moddatetime(updated_at);

create index conversations_merchant_customer_idx
  on public.conversations (merchant_id, shopify_customer_gid);

create index conversations_merchant_status_idx
  on public.conversations (merchant_id, status, last_message_at desc);

-- Partial ivfflat index — only rows with embeddings populated (Sprint 06 job).
-- Partial predicate avoids NULL vectors polluting the ANN index and improves build time.
-- lists=100 is appropriate for < 1M rows; tune upward when the dataset grows.
create index conversations_embedding_idx
  on public.conversations using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

-- Attribution + campaign query path (FK to campaigns added Sprint 07; index here now).
create index conversations_campaign_idx
  on public.conversations (merchant_id, campaign_id)
  where campaign_id is not null;

alter table public.conversations enable row level security;

create policy conversations_merchant_read
  on public.conversations for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- conversation_messages  (individual turns; embedding per message)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.conversation_messages (
  id               uuid          primary key default gen_random_uuid(),
  conversation_id  uuid          not null references public.conversations(id) on delete cascade,
  -- ON DELETE CASCADE so that deleting a conversation cascades cleanly;
  -- RESTRICT would conflict with the cascade from conversation_id FK above.
  merchant_id      uuid          not null references public.merchants(id) on delete cascade,
  role             text          not null,
  channel          text          not null default 'sms',
  body             text          not null,
  sent_at          timestamptz   not null default now(),
  embedding        vector(1536)
);

comment on column public.conversation_messages.channel is
  'Channel is text (not enum) by design. Mirrors conversations.channel.';

create index conversation_messages_conversation_idx
  on public.conversation_messages (conversation_id, sent_at asc);

create index conversation_messages_merchant_idx
  on public.conversation_messages (merchant_id);

-- Partial ivfflat index — only rows with embeddings populated (Sprint 06 job).
create index conversation_messages_embedding_idx
  on public.conversation_messages using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

alter table public.conversation_messages enable row level security;

create policy conversation_messages_merchant_read
  on public.conversation_messages for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- webhook_deliveries  (idempotency log — no RLS, service_role only)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.webhook_deliveries (
  id                   uuid          primary key default gen_random_uuid(),
  merchant_id          uuid          references public.merchants(id) on delete set null,
  topic                text          not null,
  shopify_webhook_id   text          not null unique,
  payload              jsonb         not null,
  status               text          not null default 'pending',
  processed_at         timestamptz,
  error_message        text,
  received_at          timestamptz   not null default now()
);

comment on table public.webhook_deliveries is
  'Idempotency log for Shopify webhook deliveries. shopify_webhook_id is unique, '
  'so a duplicate delivery is detected and skipped without reprocessing. '
  'No RLS — only the service_role key may write here. No merchant JWT can '
  'read this table.';

create index webhook_deliveries_merchant_idx
  on public.webhook_deliveries (merchant_id, received_at desc);

-- Explicit deny policy for authenticated role: intent is unambiguous and cannot be
-- accidentally overridden by adding a permissive SELECT policy later. Payload contains
-- customer PII (full Shopify webhook bodies); no merchant JWT may ever read this table.
alter table public.webhook_deliveries enable row level security;

create policy webhook_deliveries_deny_authenticated
  on public.webhook_deliveries for all
  to authenticated
  using (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- merchants: add last_backfill_at column for the Settings page
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.merchants
  add column if not exists last_backfill_at timestamptz;
