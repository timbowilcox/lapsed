-- ─────────────────────────────────────────────────────────────────────────────
-- RFM refresh helper
-- ─────────────────────────────────────────────────────────────────────────────
-- RPC wrapper so the nightly scoring cron can trigger a concurrent matview
-- refresh without needing raw SQL access. Only service_role may call this.

create or replace function public.refresh_merchant_aggregates()
returns void
language sql
security definer
as $$
  refresh materialized view concurrently public.merchant_aggregates;
$$;

-- Grant execute only to service_role (the cron job credential).
revoke all on function public.refresh_merchant_aggregates() from public;
revoke all on function public.refresh_merchant_aggregates() from authenticated;
revoke all on function public.refresh_merchant_aggregates() from anon;
grant execute on function public.refresh_merchant_aggregates() to service_role;
