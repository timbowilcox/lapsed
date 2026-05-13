-- Lapsed.ai initial schema (Sprint 02)
--
-- Creates the merchants table — the tenancy root for everything in v1.
-- Tokens are stored as bytea ciphertext; the application layer
-- encrypts/decrypts via packages/db/src/encryption.ts using
-- TOKEN_ENCRYPTION_KEY (AES-256-GCM, key never reaches the database).
--
-- RLS allows a row to be SELECTed only when the request's JWT carries a
-- `shop_domain` claim matching the row's shopify_shop_domain. The
-- claim is set when the Shopify App Bridge session token is verified
-- in packages/shopify/src/session.ts. Server-side writes use the
-- service_role key, which bypasses RLS (the security boundary for
-- writes is the OAuth + HMAC verification, not the DB role).

create extension if not exists pgcrypto;        -- gen_random_uuid()
create extension if not exists moddatetime;     -- updated_at trigger

create table if not exists public.merchants (
  id                      uuid primary key default gen_random_uuid(),
  shopify_shop_domain     text unique not null,
  shopify_access_token    bytea not null,
  shopify_scope           text not null,
  installed_at            timestamptz not null default now(),
  uninstalled_at          timestamptz,
  plan                    text not null default 'starter',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on column public.merchants.shopify_access_token is
  'AES-256-GCM ciphertext. Encoded as iv(12) || authTag(16) || ciphertext. Plaintext never written here.';

comment on column public.merchants.shopify_scope is
  'Comma-separated scope string returned by Shopify on token exchange. Tracks which scopes the merchant actually granted (may differ from requested scopes if Shopify rejects any).';

create trigger merchants_set_updated_at
  before update on public.merchants
  for each row execute function moddatetime(updated_at);

alter table public.merchants enable row level security;

-- SELECT policy: the request's JWT must carry a `shop_domain` claim
-- that matches the row. authenticated and anon roles both flow through
-- here; service_role bypasses RLS by design.
create policy merchants_self_read
  on public.merchants
  for select
  using (
    shopify_shop_domain = ((auth.jwt() ->> 'shop_domain'::text))
  );

-- No INSERT/UPDATE/DELETE policy is granted. Mutations happen with the
-- service_role key from the OAuth callback and uninstall webhook
-- (Sprint 03). Without explicit policies, RLS denies writes for anon
-- and authenticated roles — which is what we want.
