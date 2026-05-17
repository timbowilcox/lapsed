-- Sprint 09: Flat subscription billing schema.
--
-- ARCHITECTURAL DECISIONS ENCODED HERE (28–33):
--
-- Decision 28 (Stripe customer at onboarding): `merchants.stripe_customer_id`
--   is populated for every merchant at first signup. Nullable here because the
--   column backfills to NULL for pre-Sprint-09 merchants; a separate one-shot
--   backfill (chunk 6) creates Stripe customers for them. UNIQUE — one Stripe
--   customer per merchant.
--
-- Decision 29 (Stripe is source of truth; local mirror eventually-consistent):
--   `merchant_subscriptions` mirrors Stripe subscription state. It is written
--   ONLY by the Stripe webhook handler (service role). Application code reads
--   it for display; sensitive billing operations re-verify against Stripe.
--
-- Decision 30 (tier → entitlements via pure function): no entitlements table.
--   `merchants.subscription_tier` + `subscription_status` are the cached inputs
--   getMerchantEntitlements() reads. Tier is mirrored onto `merchants` (not only
--   `merchant_subscriptions`) so the entitlements function does a single-row
--   read without a join.
--
-- Decision 31 (7-day grace before suspension): `merchant_subscriptions
--   .grace_period_started_at` is set when status transitions into `past_due`.
--   The billing-grace cron transitions merchants to `suspended` after the
--   configured grace window elapses. The partial index below serves that cron.
--
-- Decision 32 (Stripe webhooks idempotent via event ID): `subscription_events
--   .stripe_event_id` is the dedup key — a UNIQUE constraint. The webhook
--   handler checks for an existing row before processing; the UNIQUE is the
--   race backstop. `subscription_events` is append-only (trigger-enforced).
--
-- Decision 33 (Stripe Tax): no schema — tax is computed by Stripe on each
--   invoice. The merchant billing address is collected by Stripe Checkout and
--   lives in Stripe, not here.
--
-- RLS WRITE POLICY: both new tables enable RLS with a merchant-scoped SELECT
-- policy ONLY. No INSERT/UPDATE/DELETE policy is granted to the authenticated
-- role — by design. All writes go through the service role (the Stripe webhook
-- handler, the billing-grace cron, the onboarding customer-creation path),
-- which bypasses RLS entirely. The absence of a write policy is the
-- enforcement. This mirrors the attribution_results / bandit_state pattern.
--
-- NO EMBEDDING COLUMNS ON THESE TABLES. Decision 2's pgvector requirement
-- applies to narrative-content tables (customer_events, conversations,
-- messages, campaign_proposals). The subscription tables are purely
-- quantitative billing state — no narrative text to embed. Noted explicitly so
-- the architecture-guardian does not false-flag the absence (same note as the
-- Sprint 08 attribution tables).

-- ─────────────────────────────────────────────────────────────────────────────
-- merchants — subscription columns (decisions 28, 30)
-- ─────────────────────────────────────────────────────────────────────────────
-- All three columns are nullable: they backfill to NULL for existing merchant
-- rows (a merchant who has never subscribed has no tier/status). The webhook
-- handler populates tier/status; the onboarding path populates
-- stripe_customer_id.

alter table public.merchants
  add column if not exists stripe_customer_id  text,
  add column if not exists subscription_tier   text,
  add column if not exists subscription_status text;

-- UNIQUE on stripe_customer_id — one Stripe customer per merchant. A partial
-- unique index (WHERE NOT NULL) so the many pre-backfill NULLs do not collide.
create unique index if not exists merchants_stripe_customer_id_unique
  on public.merchants (stripe_customer_id)
  where stripe_customer_id is not null;

-- Postgres has no `add constraint if not exists`; wrap in a DO block so the
-- migration stays re-runnable (consistent with the `if not exists` guards on
-- the column adds and indexes above).
do $$ begin
  alter table public.merchants
    add constraint merchants_subscription_tier_check
      check (subscription_tier is null or subscription_tier in ('starter', 'growth', 'scale'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.merchants
    add constraint merchants_subscription_status_check
      check (
        subscription_status is null
        or subscription_status in ('trialing', 'active', 'past_due', 'canceled', 'suspended')
      );
exception when duplicate_object then null;
end $$;

comment on column public.merchants.stripe_customer_id is
  'Stripe customer id (cus_...), created at merchant onboarding (decision 28). '
  'NULL for pre-Sprint-09 merchants until the one-shot customer backfill runs.';
comment on column public.merchants.subscription_tier is
  'Cached subscription tier (starter/growth/scale). Mirrored from Stripe via '
  'the webhook handler; read by getMerchantEntitlements (decision 30). NULL '
  'when the merchant has no subscription.';
comment on column public.merchants.subscription_status is
  'Cached subscription status. trialing/active/past_due/canceled are mirrored '
  'from Stripe; suspended is set by the billing-grace cron after the grace '
  'window elapses (decision 31).';

-- ─────────────────────────────────────────────────────────────────────────────
-- merchant_subscriptions — Stripe subscription state mirror (decision 29)
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per merchant (merchant_id UNIQUE — one active subscription per
-- merchant in v1). Written ONLY by the Stripe webhook handler and the
-- billing-grace cron, both service role.

create table if not exists public.merchant_subscriptions (
  id                      uuid        primary key default gen_random_uuid(),
  merchant_id             uuid        not null unique references public.merchants(id) on delete restrict,
  stripe_subscription_id  text        not null unique,
  tier                    text        not null,
  status                  text        not null,
  current_period_start    timestamptz not null,
  current_period_end      timestamptz not null,
  grace_period_started_at timestamptz,
  cancel_at               timestamptz,
  canceled_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint merchant_subscriptions_tier_check
    check (tier in ('starter', 'growth', 'scale')),
  constraint merchant_subscriptions_status_check
    check (status in ('trialing', 'active', 'past_due', 'canceled', 'suspended'))
);

comment on table public.merchant_subscriptions is
  'Read mirror of Stripe subscription state (decision 29). Stripe is the source '
  'of truth; this table is eventually-consistent, updated via Stripe webhooks. '
  'One row per merchant. Written only by the service role.';
comment on column public.merchant_subscriptions.grace_period_started_at is
  'Set when status transitions into past_due (decision 31). The billing-grace '
  'cron suspends the merchant once the configured grace window elapses. '
  'Cleared on recovery (invoice.payment_succeeded).';

create index merchant_subscriptions_merchant_idx
  on public.merchant_subscriptions (merchant_id);

-- Partial index for the grace-expiry cron: it scans only past_due rows ordered
-- by when grace started.
create index merchant_subscriptions_grace_idx
  on public.merchant_subscriptions (status, grace_period_started_at)
  where status = 'past_due';

create trigger merchant_subscriptions_set_updated_at
  before update on public.merchant_subscriptions
  for each row execute function moddatetime(updated_at);

alter table public.merchant_subscriptions enable row level security;

create policy merchant_subscriptions_merchant_read
  on public.merchant_subscriptions for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- subscription_events — append-only billing audit (decision 32)
-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only. Stores every processed Stripe event keyed by stripe_event_id
-- (the idempotency dedup key) plus internally-generated billing audit events
-- (grace_period_expired, and the chunk-4 attribution_methodology_migration
-- backfill audit). stripe_event_id is nullable — internal audit events carry
-- no Stripe event id. The partial UNIQUE makes Stripe re-delivery a safe no-op
-- while permitting many NULL-keyed internal events.

create table if not exists public.subscription_events (
  id              uuid        primary key default gen_random_uuid(),
  merchant_id     uuid        not null references public.merchants(id) on delete restrict,
  stripe_event_id text,
  event_type      text        not null,
  data            jsonb       not null default '{}'::jsonb,
  appended_at     timestamptz not null default now()
);

comment on table public.subscription_events is
  'Append-only billing audit log (decision 32). Stripe events are deduped by '
  'stripe_event_id; internal audit events (grace_period_expired, '
  'attribution_methodology_migration) carry a NULL stripe_event_id.';

-- Decision 32: Stripe event id is the idempotency key. Partial UNIQUE so the
-- NULL-keyed internal audit events do not collide.
create unique index subscription_events_stripe_event_id_unique
  on public.subscription_events (stripe_event_id)
  where stripe_event_id is not null;

create index subscription_events_merchant_idx
  on public.subscription_events (merchant_id, appended_at desc);

create index subscription_events_type_idx
  on public.subscription_events (event_type, appended_at desc);

-- Append-only enforcement — reuses prevent_event_mutation() from migration 0002.
create trigger subscription_events_no_update
  before update on public.subscription_events
  for each row execute function prevent_event_mutation();

create trigger subscription_events_no_delete
  before delete on public.subscription_events
  for each row execute function prevent_event_mutation();

create trigger subscription_events_no_truncate
  before truncate on public.subscription_events
  for each statement execute function prevent_event_mutation();

alter table public.subscription_events enable row level security;

create policy subscription_events_merchant_read
  on public.subscription_events for select
  using (
    merchant_id = (
      select id from public.merchants
      where shopify_shop_domain = (auth.jwt() ->> 'shop_domain')
    )
  );
