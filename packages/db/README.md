# @lapsed/db

Supabase schema, generated TypeScript types, encryption helpers, and Supabase client factories.

## Migrations

Live under `supabase/migrations/`. Numbered with a 4-digit prefix:

- `0001_init.sql` — `merchants` table, `pgcrypto` + `moddatetime` extensions, RLS policy `merchants_self_read`, `updated_at` trigger.

### Apply migrations

```powershell
pnpm --filter @lapsed/db db:push
```

This runs `supabase db push --db-url $SUPABASE_DB_URL --include-all`.

**Known fallback**: if the Supabase CLI hits its access-control bug for the linked project, the script will pass the `--db-url` flag so it bypasses the linked-project check and connects directly via the pooler URL. If even that fails, apply via `psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_init.sql` (requires the `psql` client installed locally).

### Regenerate types

```powershell
pnpm --filter @lapsed/db db:types
```

The script calls `supabase gen types typescript`. If that endpoint returns 403 (access-control bug), the supplied fallback uses the project management API directly:

```powershell
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" `
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/types/typescript?included_schemas=public" `
  | node -e "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{require('fs').writeFileSync('src/types.ts', JSON.parse(d).types)})"
```

The committed `src/types.ts` was generated this way on 2026-05-14.

## Token encryption (at-rest)

Shopify access tokens are encrypted before reaching the database. The encryption helper lives in `src/encryption.ts`.

**Algorithm**: AES-256-GCM. The ciphertext column (`merchants.shopify_access_token`) stores `iv (12 bytes) || authTag (16 bytes) || ciphertext` as `bytea`.

**Why not Supabase Vault / `pgp_sym_encrypt`**: keeping encryption at the application layer means the key never reaches Postgres. A direct DB compromise (read-only) cannot reveal plaintext tokens; an exfiltrated `pg_dump` is useless without `TOKEN_ENCRYPTION_KEY` (which lives only in Vercel encrypted env + `.env.local` on developer machines). The trade-off is that we cannot decrypt server-side from raw SQL — every read goes through TypeScript code that has the key.

### Key format

`TOKEN_ENCRYPTION_KEY` is 32 random bytes, base64-encoded. Generate with:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

The helper exposes `decodeEncryptionKey(base64)` which returns a 32-byte Buffer (throws on the wrong length). Pass that Buffer to `encryptToken(plaintext, key)` / `decryptToken(ciphertext, key)`.

### Rotation procedure

Tokens are encrypted with the current `TOKEN_ENCRYPTION_KEY`. To rotate:

1. Mint a new key (`KEY_2`).
2. Deploy `TOKEN_ENCRYPTION_KEY_NEXT=$KEY_2` alongside the existing `TOKEN_ENCRYPTION_KEY`.
3. Run a one-shot script that reads every row, decrypts with `TOKEN_ENCRYPTION_KEY`, re-encrypts with `KEY_2`, writes back. Script lives in `packages/db/scripts/rotate-encryption-key.ts` (added in a future sprint).
4. Promote `TOKEN_ENCRYPTION_KEY_NEXT` → `TOKEN_ENCRYPTION_KEY`, retire the old value.

Rotation is not a Sprint 02 deliverable; documented here so the future-us doesn't have to rediscover the procedure.

## Supabase client factories

`src/index.ts` exports two factories:

- `createServiceClient({ url, serviceKey })` — bypasses RLS. For writes from OAuth callback and webhook handlers, where Shopify HMAC has already authenticated the caller.
- `createMerchantClient({ url, publishableKey, merchantJwt })` — respects RLS. The `merchantJwt` is a short-lived HS256 JWT minted by `mintMerchantJwt({ shopDomain, jwtSecret })`. RLS policies see `auth.jwt() ->> 'shop_domain'`.

## RLS model

A single policy on `merchants`:

```sql
create policy merchants_self_read on public.merchants
  for select
  using (shopify_shop_domain = (auth.jwt() ->> 'shop_domain'));
```

No INSERT / UPDATE / DELETE policies — those operations require the service role key (which bypasses RLS) and travel through OAuth-verified or HMAC-verified server-side paths.

Cross-tenant isolation is exercised in `__tests__/rls.test.ts`. Run via `pnpm --filter @lapsed/db test`.
