-- Sprint 03 (addendum): merchant lifecycle events + atomic customer-order increment.
--
-- 1. merchant_events — append-only log for install / uninstall / reinstall lifecycle.
--    The merchants table has a `uninstalled_at` convenience column (materialised),
--    but the audit-grade record of when the app was installed/uninstalled lives here.
--    Needed for billing reconciliation: incremental revenue attribution requires
--    knowing exactly when a merchant was "in scope".
--
-- 2. increment_customer_order — atomic SQL function for the orders/paid webhook.
--    Uses INSERT … ON CONFLICT DO UPDATE with arithmetic expressions so a
--    concurrent duplicate delivery cannot produce a wrong counter (no read-modify-write).

-- ─────────────────────────────────────────────────────────────────────────────
-- merchant_events  (append-only lifecycle log)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.merchant_events (
  id            uuid        primary key default gen_random_uuid(),
  merchant_id   uuid        not null references public.merchants(id) on delete restrict,
  event_type    text        not null,   -- 'app_installed' | 'app_uninstalled' | 'app_reinstalled'
  source        text        not null,   -- 'shopify_webhook' | 'oauth_callback' | 'system'
  payload       jsonb       not null default '{}',
  occurred_at   timestamptz not null,
  ingested_at   timestamptz not null default now()
);

comment on table public.merchant_events is
  'Append-only log of merchant lifecycle events (install, uninstall, reinstall). '
  'Required for billing reconciliation: incremental revenue attribution is bounded '
  'by install windows derived from this log.';

alter table public.merchant_events
  add constraint merchant_events_dedup_unique
  unique (merchant_id, event_type, source, occurred_at);

create index merchant_events_merchant_idx
  on public.merchant_events (merchant_id, occurred_at desc);

-- Append-only enforcement — same pattern as customer_events / order_events.
create trigger merchant_events_no_update
  before update on public.merchant_events
  for each row execute function prevent_event_mutation();

create trigger merchant_events_no_delete
  before delete on public.merchant_events
  for each row execute function prevent_event_mutation();

create trigger merchant_events_no_truncate
  before truncate on public.merchant_events
  for each statement execute function prevent_event_mutation();

alter table public.merchant_events enable row level security;

-- Only service_role may write; no authenticated role should read raw lifecycle events.
create policy merchant_events_deny_authenticated
  on public.merchant_events for all to authenticated
  using (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- increment_customer_order  (atomic upsert-with-increment for orders/paid webhook)
-- ─────────────────────────────────────────────────────────────────────────────
-- Called by the orders/paid webhook handler instead of a JS-side read-modify-write.
-- The single INSERT … ON CONFLICT DO UPDATE is serialized by Postgres and cannot
-- race: two concurrent calls will serialize at the row lock, not interleave at the
-- application level.

create or replace function public.increment_customer_order(
  p_merchant_id         uuid,
  p_customer_gid        text,
  p_amount_cents        bigint,
  p_ordered_at          timestamptz
) returns void
  language sql
  security definer    -- runs as table owner so service_role policy bypass is not needed
  set search_path = public
as $$
  insert into customers (
    merchant_id, shopify_customer_gid,
    total_order_count, total_ltv_cents, last_order_at
  )
  values (
    p_merchant_id, p_customer_gid,
    1, p_amount_cents, p_ordered_at
  )
  on conflict (merchant_id, shopify_customer_gid) do update
    set total_order_count = customers.total_order_count + 1,
        total_ltv_cents   = customers.total_ltv_cents + excluded.total_ltv_cents,
        last_order_at     = excluded.last_order_at;
$$;

comment on function public.increment_customer_order is
  'Atomically upserts a customer row and increments order count + LTV. '
  'Use this from the orders/paid webhook handler to avoid a read-modify-write race.';
