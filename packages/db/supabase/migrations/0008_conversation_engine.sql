-- Sprint 07: Conversation Engine — per-customer conversations, the message
-- log, the append-only message event log, and the immutable opt-out registry.
--
-- ARCHITECTURAL DECISIONS ENCODED HERE:
--
-- Decision 2 (pgvector for conversation memory): both `conversations` and
--   `messages` carry a vector(1536) embedding column with a partial ivfflat
--   index. Semantic search over transcripts is a first-build schema
--   requirement, not a later migration. The embedding columns are NULL until
--   an embedding job populates them (post-v1), but the column + index exist
--   from this migration so adding search later is not a schema migration.
--
-- Decision 3 (channel-agnostic engine): `channel` is a TEXT column on both
--   `conversations` and `messages`, default 'sms'. No enum, no CHECK pinning
--   it to 'sms'. v1 ships SMS only; the schema never closes the door.
--
-- Decision 16 (conversations per-customer, not per-campaign): `conversations`
--   is keyed by (merchant_id, customer_id) — exactly one row per customer per
--   merchant. A surrogate `id` is kept UNIQUE so `messages` and
--   `message_events` can FK a single column. A customer in three campaigns
--   has ONE conversation row; messages carry an optional campaign_id + arm_id
--   recording which campaign drove an outbound, but the THREAD is unified.
--
-- Decision 12 mirror (event sourcing): `message_events` is append-only,
--   trigger-enforced via prevent_event_mutation() from migration 0002.
--   `conversations` + `messages` are mutable materialized state (status,
--   counts, sentiment cache) regeneratable from the event log.
--
-- Decision 18 (opt-outs immutable + dual-recorded): `customer_opt_outs` is
--   append-only (same prevent_event_mutation() trigger enforcement). It is
--   the application source of truth; the opt-out registry helper also calls
--   Twilio's opt-out API as the safety net. Opt-outs never expire.
--
-- NOTE ON THE 0002 STUB TABLES: migration 0002 forward-declared stub
--   `conversations` + `conversation_messages` tables that Sprints 03-06 never
--   wired up (no queries, no writes — only a type entry and an RLS test). The
--   0002 `conversations` was keyed by a surrogate `id` with a single
--   `campaign_id`, which contradicts decision 16's per-customer threading.
--   Both stub tables are DROPPED here and `conversations` is recreated with
--   the decision-16 composite key. The vector(1536) embedding columns from
--   0002 (decision 2) are preserved on the recreated tables.

-- ─────────────────────────────────────────────────────────────────────────────
-- Drop the unused Sprint 03 stub tables
-- ─────────────────────────────────────────────────────────────────────────────
-- conversation_messages FKs conversations, so it is dropped first. Neither
-- table carries production data (Sprints 03-06 never wrote to them).

drop table if exists public.conversation_messages;
drop table if exists public.conversations;

-- ─────────────────────────────────────────────────────────────────────────────
-- conversations  (one row per (merchant_id, customer_id) — decision 16)
-- ─────────────────────────────────────────────────────────────────────────────
-- The composite PK enforces decision 16: a customer cannot have two threads.
-- The surrogate `id` is UNIQUE so child tables FK one column. `last_inbound_at`
-- backs the chunk-9 no-reply sweep; `last_message_at` orders the chunk-10 list.

create table if not exists public.conversations (
  id                uuid          not null default gen_random_uuid(),
  merchant_id       uuid          not null references public.merchants(id) on delete restrict,
  customer_id       text          not null,
    -- shopify_customer_gid of the customer this thread belongs to
  channel           text          not null default 'sms',
  opened_at         timestamptz   not null default now(),
  last_message_at   timestamptz,
  last_inbound_at   timestamptz,
  message_count     int           not null default 0,
  embedding         vector(1536),
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  constraint conversations_pk primary key (merchant_id, customer_id),
  constraint conversations_id_unique unique (id),
  constraint conversations_message_count_nonneg check (message_count >= 0)
);

comment on table public.conversations is
  'One row per (merchant_id, customer_id) — decision 16. A customer in '
  'multiple campaigns has ONE conversation thread. The surrogate id is UNIQUE '
  'so messages / message_events can FK a single column.';

comment on column public.conversations.customer_id is
  'shopify_customer_gid. Named customer_id to match campaign_group_snapshots; '
  'not an FK because the snapshot customer set is frozen independently.';

comment on column public.conversations.channel is
  'Channel is text (not enum) by design — decision 3. v1 ships sms only but '
  'the engine is channel-agnostic. Do not add an enum or CHECK constraint.';

comment on column public.conversations.embedding is
  'Semantic embedding of the conversation transcript (decision 2). 1536-dim '
  'for OpenAI / Voyage compatibility. NULL until the embedding job runs.';

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function moddatetime(updated_at);

create index conversations_merchant_last_message_idx
  on public.conversations (merchant_id, last_message_at desc nulls last);

-- Partial ivfflat index — only rows with embeddings populated. lists=100 is
-- appropriate for < 1M rows; tune upward when the dataset grows.
create index conversations_embedding_idx
  on public.conversations using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

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
-- messages  (individual SMS turns — mutable materialized state)
-- ─────────────────────────────────────────────────────────────────────────────
-- direction distinguishes inbound (customer) from outbound (agent). campaign_id
-- + arm_id are set on campaign-driven outbounds and NULL on AI replies / inbound
-- (decision 16 — the thread is per-customer, the campaign attribution is
-- per-message). pii_redacted_body is the log-safe copy (criterion 7 / decision
-- 10). posterior_updated_at is the chunk-9 no-reply-sweep idempotency flag.

create table if not exists public.messages (
  id                    uuid          primary key default gen_random_uuid(),
  merchant_id           uuid          not null references public.merchants(id) on delete restrict,
  conversation_id       uuid          not null references public.conversations(id) on delete restrict,
  direction             text          not null,
  channel               text          not null default 'sms',
  body                  text          not null,
  pii_redacted_body     text          not null,
    -- server-side PII-redacted copy of body; logs use ONLY this column
  twilio_sid            text,
    -- Twilio MessageSid: the send SID for outbound, the inbound SID for inbound
  campaign_id           uuid          references public.campaign_proposals(id) on delete restrict,
  arm_id                uuid          references public.campaign_arms(bandit_arm_id) on delete restrict,
  status                text          not null default 'pending',
  sentiment             text,
    -- materialized cache of the inbound_classified event; NULL for outbound
  intent                text,
  posterior_updated_at  timestamptz,
    -- set once a bandit posterior update has folded this message in (chunk 9
    -- idempotency); NULL until then
  embedding             vector(1536),
  sent_at               timestamptz   not null default now(),
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  constraint messages_direction_check check (direction in ('inbound', 'outbound')),
  constraint messages_channel_nonempty check (char_length(channel) > 0),
  constraint messages_status_check
    check (status in ('pending', 'sent', 'delivered', 'failed', 'received')),
  constraint messages_sentiment_check
    check (sentiment is null or sentiment in ('positive', 'neutral', 'negative')),
  constraint messages_intent_check
    check (intent is null or intent in
      ('engagement', 'purchase', 'question', 'complaint', 'opt_out', 'other'))
);

comment on table public.messages is
  'Individual SMS turns. Mutable materialized state (status transitions, '
  'sentiment cache, posterior_updated_at). The append-only record is '
  'message_events. campaign_id + arm_id record which campaign drove an '
  'outbound — NULL for inbound and for non-campaign AI replies (decision 16).';

comment on column public.messages.pii_redacted_body is
  'PII-redacted copy of body produced server-side via @lapsed/core redact(). '
  'Structured logs reference this column ONLY — never body (decision 10).';

comment on column public.messages.channel is
  'Channel is text (not enum) by design — decision 3. Mirrors '
  'conversations.channel.';

create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function moddatetime(updated_at);

-- Thread display (chunk 11): newest message first within a conversation.
create index messages_conversation_sent_idx
  on public.messages (conversation_id, sent_at desc);

-- Most-recent-outbound lookup for bandit posterior routing (decision 19): the
-- inbound webhook finds the conversation's latest outbound to resolve its
-- arm_id. Partial on direction='outbound' so the scan is tight.
create index messages_conversation_outbound_idx
  on public.messages (conversation_id, sent_at desc)
  where direction = 'outbound';

create index messages_merchant_idx
  on public.messages (merchant_id);

-- No-reply sweep (chunk 9): outbound messages not yet folded into a posterior.
create index messages_no_reply_sweep_idx
  on public.messages (merchant_id, sent_at)
  where direction = 'outbound' and posterior_updated_at is null;

-- Partial ivfflat index — only rows with embeddings populated (decision 2).
create index messages_embedding_idx
  on public.messages using ivfflat (embedding vector_cosine_ops)
  with (lists = 100)
  where embedding is not null;

alter table public.messages enable row level security;

create policy messages_merchant_read
  on public.messages for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- message_events  (append-only event log — decision 12 mirror)
-- ─────────────────────────────────────────────────────────────────────────────
-- Event types (enforced in the application layer, matching the
-- voice_events / campaign_events pattern):
--   message_outbound_queued   — payload: {campaign_id?, arm_id?}
--   message_outbound_sent     — payload: {twilio_sid}
--   message_outbound_failed   — payload: {error_code, error_class}
--   message_inbound_received  — payload: {twilio_sid}
--   inbound_classified        — payload: {sentiment, intent, confidence, retries}
--   reply_generated           — payload: {suggested_next_action, retries}
--   reply_sent                — payload: {twilio_sid}
--   degraded_mode             — payload: {phase, reason, elapsed_ms}
--   opt_out_recorded          — payload: {source, matched_keyword?}
--   posterior_updated         — payload: {arm_id, success}
--
-- payload NEVER contains customer PII or message text — only IDs, counts,
-- enums, and timing metadata (mirrors the campaign_events decision-10 contract).

create table if not exists public.message_events (
  id               uuid        primary key default gen_random_uuid(),
  merchant_id      uuid        not null references public.merchants(id) on delete restrict,
  conversation_id  uuid        not null references public.conversations(id) on delete restrict,
  message_id       uuid        references public.messages(id) on delete restrict,
    -- nullable: message_outbound_queued fires before the messages row exists
  event_type       text        not null,
  payload          jsonb       not null default '{}',
  occurred_at      timestamptz not null,
  ingested_at      timestamptz not null default now()
);

comment on table public.message_events is
  'Append-only event log for the conversation lifecycle. Materialized state in '
  'conversations + messages is regeneratable from this log. payload NEVER '
  'contains customer PII or message text — only IDs, counts, and timing.';

-- Dedup constraint makes appendMessageEvent idempotent. NULLS NOT DISTINCT so
-- two message_id-less events (e.g. duplicate message_outbound_queued) at the
-- same occurred_at still collide and dedup.
alter table public.message_events
  add constraint message_events_dedup_unique
  unique nulls not distinct (merchant_id, conversation_id, message_id, event_type, occurred_at);

create index message_events_message_idx
  on public.message_events (message_id, occurred_at);

create index message_events_conversation_idx
  on public.message_events (merchant_id, conversation_id, occurred_at desc);

-- Append-only enforcement — reuses prevent_event_mutation() from migration 0002.
create trigger message_events_no_update
  before update on public.message_events
  for each row execute function prevent_event_mutation();

create trigger message_events_no_delete
  before delete on public.message_events
  for each row execute function prevent_event_mutation();

create trigger message_events_no_truncate
  before truncate on public.message_events
  for each statement execute function prevent_event_mutation();

alter table public.message_events enable row level security;

create policy message_events_merchant_read
  on public.message_events for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- customer_opt_outs  (immutable opt-out registry — decision 18)
-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only: an opt-out is permanent and never expires. recordOptOut in
-- @lapsed/core writes here AND calls Twilio's opt-out API (dual-recorded —
-- this table is the source of truth, Twilio is the safety net). The
-- assertNotOptedOut pre-flight reads (merchant_id, customer_id) before every
-- outbound send.

create table if not exists public.customer_opt_outs (
  id                  uuid        primary key default gen_random_uuid(),
  merchant_id         uuid        not null references public.merchants(id) on delete restrict,
  customer_id         text        not null,
    -- shopify_customer_gid
  phone_number        text        not null,
  opted_out_at        timestamptz not null default now(),
  source              text        not null,
  inbound_message_id  uuid        references public.messages(id) on delete restrict,
    -- the inbound message that triggered the opt-out; NULL for merchant_manual
  created_at          timestamptz not null default now(),
  constraint customer_opt_outs_source_check
    check (source in ('stop_keyword', 'sonnet_classified', 'merchant_manual', 'twilio_native'))
);

comment on table public.customer_opt_outs is
  'Immutable, append-only opt-out registry (decision 18). An opt-out is '
  'permanent — there is no expiry, no UPDATE, no DELETE. Re-engagement '
  'requires a fresh customer-initiated message. Dual-recorded: recordOptOut '
  'also calls Twilio''s opt-out API.';

-- assertNotOptedOut hot path: (merchant_id, customer_id) existence check before
-- every outbound send.
create index customer_opt_outs_merchant_customer_idx
  on public.customer_opt_outs (merchant_id, customer_id);

-- Append-only enforcement — opt-outs are immutable (decision 18).
create trigger customer_opt_outs_no_update
  before update on public.customer_opt_outs
  for each row execute function prevent_event_mutation();

create trigger customer_opt_outs_no_delete
  before delete on public.customer_opt_outs
  for each row execute function prevent_event_mutation();

create trigger customer_opt_outs_no_truncate
  before truncate on public.customer_opt_outs
  for each statement execute function prevent_event_mutation();

alter table public.customer_opt_outs enable row level security;

-- Authenticated merchant reads their own opt-out rows (powers the opt-out
-- filter in the conversation UI). Writes are service-role only.
create policy customer_opt_outs_merchant_read
  on public.customer_opt_outs for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );
