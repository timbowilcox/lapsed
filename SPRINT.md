# Sprint 03 — Data Ingestion and Customer Memory Graph

Date: 2026-05-14
Repo: timbowilcox/lapsed
Branch: `sprint-03/data-ingestion-and-memory-graph`
Estimated effort: 5–7 days, single PR

---

## Required reading

Before any implementation, read in order:

1. `CLAUDE.md` — full file, especially "Architectural load-bearing decisions" (six decisions, two of which *land in this sprint*) and "Failure modes encoded so far"
2. `PRODUCT.md` — full file, especially Module 1 (Win-back engine) and Module 5 (Revenue attribution) for data shape understanding
3. `DESIGN-SYSTEM.md` — empty / loading / error state visual patterns
4. `.claude/agents/README.md` — dispatch patterns for the six specialist subagents
5. `.claude/agents/architecture-guardian.md` — read twice; its verdict is binding every chunk this sprint

The two architectural load-bearing decisions that land here:

- **Decision 1**: Event-sourced customer memory graph. Append-only event log with timestamp + source. Materialised customer profile regenerated from events. No snapshot mutations — no UPDATE on event tables, ever.
- **Decision 2**: pgvector for conversation memory. Embedding column on `conversations` and `conversation_messages` tables from day one. ivfflat index. Not added later.

---

## Scope

Sprint 03 is the foundational data layer. It lands exactly two things:

1. **Data ingestion**: A complete schema (event-sourced), Shopify webhooks for live updates, and a backfill job for historical data. By end of sprint, a newly-installed merchant's historical customers and orders are ingested and stored in the memory graph.

2. **Fixture-to-real-data sweep**: Every screen that can show real data does. Campaigns, conversations, and attribution remain as fixtures (those ship in Sprints 06–08), but Dashboard, Lapsed customers, and Settings show real DB values.

Loading, empty, and error states are added for every route that has a real data fetch.

No scoring, no classification, no SMS — that is Sprint 04 and beyond.

---

## In scope

### 1. Database migration 0002 — full schema

New extension and all new tables in a single migration file `packages/db/supabase/migrations/0002_memory_graph.sql`:

**Extensions**:
- `vector` (pgvector) for `vector(1536)` embedding columns

**customer_events** (append-only, event-sourced, the canonical record):
```
id uuid pk, merchant_id uuid fk→merchants, shopify_customer_gid text not null,
event_type text not null, source text not null, payload jsonb not null default '{}',
occurred_at timestamptz not null, ingested_at timestamptz not null default now()
```
Append-only enforced by: RLS (SELECT only for authenticated; INSERT via service_role only) + trigger that raises an exception on any UPDATE or DELETE on this table, even from service_role.

**customers** (materialised profile, regenerated from events by the nightly job):
```
id uuid pk, merchant_id uuid fk→merchants, shopify_customer_gid text not null,
email text, phone text, first_name text, last_name text, tags text[] default '{}',
total_order_count int not null default 0, total_ltv_cents bigint not null default 0,
last_order_at timestamptz, last_order_days_ago int,
lapsed_score numeric, lapsed_at timestamptz, restored_at timestamptz,
sms_opt_out boolean not null default false, sms_opt_out_at timestamptz,
profile_version int not null default 1,
created_at timestamptz not null default now(), updated_at timestamptz not null default now()
unique(merchant_id, shopify_customer_gid)
```
RLS: SELECT by merchant_id; mutations via service_role only.

**order_events** (append-only, same enforcement as customer_events):
```
id uuid pk, merchant_id uuid fk→merchants, shopify_customer_gid text not null,
shopify_order_gid text not null, event_type text not null, source text not null,
payload jsonb not null default '{}', occurred_at timestamptz not null,
ingested_at timestamptz not null default now()
```

**orders** (materialised from order_events):
```
id uuid pk, merchant_id uuid fk→merchants, shopify_order_gid text not null,
shopify_customer_gid text not null, total_price_cents bigint not null,
financial_status text not null, fulfilled_at timestamptz, shopify_created_at timestamptz not null,
created_at timestamptz not null default now(), updated_at timestamptz not null default now()
unique(merchant_id, shopify_order_gid)
```

**products** (denormalised snapshot — products don't need event-sourcing for v1):
```
id uuid pk, merchant_id uuid fk→merchants, shopify_product_gid text not null,
title text not null, handle text not null, product_type text not null default '',
price_cents bigint not null default 0, inventory_quantity int not null default 0,
created_at timestamptz not null default now(), updated_at timestamptz not null default now()
unique(merchant_id, shopify_product_gid)
```

**conversations** (with pgvector embedding, channel-agnostic):
```
id uuid pk, merchant_id uuid fk→merchants, shopify_customer_gid text not null,
campaign_id uuid, channel text not null default 'sms',
status text not null default 'active', last_message_at timestamptz,
message_count int not null default 0, attributed_order_gid text,
attributed_revenue_cents bigint,
embedding vector(1536),
created_at timestamptz not null default now(), updated_at timestamptz not null default now()
```
ivfflat index on embedding column with `lists = 100`.

**conversation_messages**:
```
id uuid pk, conversation_id uuid fk→conversations, merchant_id uuid fk→merchants,
role text not null, channel text not null default 'sms', body text not null,
sent_at timestamptz not null default now(),
embedding vector(1536)
```
ivfflat index on embedding column.

**webhook_deliveries** (idempotency log — no RLS, service_role only):
```
id uuid pk, merchant_id uuid fk→merchants, topic text not null,
shopify_webhook_id text unique not null, payload jsonb not null,
status text not null default 'pending', processed_at timestamptz,
error_message text, received_at timestamptz not null default now()
```

### 2. TypeScript types

Regenerate `packages/db/src/types.ts` to reflect the new tables. Since `supabase gen types` requires a live connection that may not be available, types are written to exactly match the migration schema and committed. A `pnpm db:types` script runs `gen-types.mjs` and should produce an identical file when run against the live DB.

### 3. Webhook HMAC verification for topic payloads

Shopify webhook payloads use a different HMAC scheme than OAuth callbacks:
- Header: `X-Shopify-Hmac-Sha256` (Base64 of HMAC-SHA256 of the raw body)
- Secret: `SHOPIFY_API_SECRET`
- Must compare with timing-safe equality

Add `verifyWebhookHmac(rawBody: Buffer, hmacHeader: string, secret: string): boolean` to `packages/shopify/src/hmac.ts`. Unit test: valid signature passes, tampered body fails, missing header fails, wrong secret fails.

### 4. Webhook delivery infrastructure

New file `apps/web/app/api/shopify/webhooks/route.ts`:
- Reads raw body (disables body parser via `export const config`)
- Verifies HMAC — returns 401 on failure, no processing
- Reads `X-Shopify-Topic` header
- Looks up `merchant_id` from `shopify_shop_domain` header (`X-Shopify-Domain`)
- Writes a `webhook_deliveries` row (idempotency check: if `shopify_webhook_id` already exists, return 200 immediately)
- Dispatches to topic-specific handler
- Updates `webhook_deliveries.status` to `processed` or `failed`
- Always returns 200 (Shopify retries on non-200; a processing error should not cause retries)

### 5. Webhook handlers — customers

Topic handlers in `apps/web/app/api/shopify/webhooks/handlers/`:

`customers-create.ts` and `customers-update.ts`:
- Parse Shopify customer payload
- Write a `customer_events` row (`event_type: 'customer_created'` or `'customer_updated'`, `source: 'shopify_webhook'`, `payload: <raw shopify payload>`)
- Upsert into `customers` (INSERT ... ON CONFLICT DO UPDATE) with current values from the event payload
- Upsert into `orders` table for any orders included in the payload

### 6. Webhook handlers — orders

`orders-paid.ts`:
- Parse Shopify order payload
- Write an `order_events` row (`event_type: 'order_paid'`, `source: 'shopify_webhook'`)
- Upsert into `orders`
- Update `customers` row: increment `total_order_count`, add order total to `total_ltv_cents`, update `last_order_at`
- Write a `customer_events` row (`event_type: 'order_placed'`) — order activity is a customer memory event

`app-uninstalled.ts`:
- Marks `merchants.uninstalled_at = now()`
- Does not delete data (data retained for potential reinstall)

### 7. Shopify backfill

New API route `apps/web/app/api/shopify/backfill/route.ts` (POST, authenticated as merchant):
- Requires a valid merchant session (same auth as other merchant routes)
- Accepts `{ resource: 'customers' | 'orders', cursor?: string }` body
- Fetches one page (250 items) from Shopify Admin REST API using the merchant's decrypted access token
- For customers: writes `customer_events` + upserts `customers`
- For orders: writes `order_events` + upserts `orders`
- Returns `{ nextCursor: string | null, count: number }` for the caller to paginate
- Rate-limit aware: Shopify REST is 40 req/min; the route does not self-throttle but returns the `Retry-After` header if Shopify responds 429

Backfill trigger: called from the onboarding flow's "Connect Shopify" step completion (onboarding page fires `POST /api/shopify/backfill` for both resources sequentially, polling until `nextCursor` is null).

### 8. Customer event write helpers

`packages/core/src/customer-events.ts`:
- `appendCustomerEvent(opts): Promise<void>` — validates and writes to `customer_events`
- `appendOrderEvent(opts): Promise<void>` — writes to `order_events`
- Typed event schemas via Zod: `CustomerEventType`, `OrderEventType` enums
- All event writes go through these helpers — no direct table inserts scattered across handlers

### 9. Materialised customer profile regeneration

`packages/core/src/materialize-customer.ts`:
- `materializeCustomer(merchantId, shopifyCustomerGid, serviceClient)`: reads all `customer_events` and `order_events` for a customer, rebuilds the `customers` row from scratch, increments `profile_version`
- Called synchronously after each webhook handler (Sprint 03: eager-refresh on event receipt; Sprint 04 will add nightly batch)
- Returns the new `customers` row

### 10. DB read helpers for merchant pages

`packages/db/src/queries.ts`:
- `getLapsedCustomers(merchantClient, { limit, cursor }): Promise<{data, nextCursor}>`
- `getCustomer(merchantClient, shopifyCustomerGid): Promise<CustomerRow | null>`
- `getMerchantSummary(serviceClient, merchantId): Promise<MerchantSummaryRow>`

These are thin wrappers over Supabase queries. No business logic here.

### 11. Fixture-to-real-data sweep — lapsed customers

`apps/web/app/app/lapsed/page.tsx` and `apps/web/app/app/lapsed/[id]/page.tsx`:
- Replace `@lapsed/fixtures` imports with DB queries via `getLapsedCustomers` / `getCustomer`
- Pass Suspense boundary around the data-dependent section
- Loading skeleton: `<LapsedCustomersSkeleton />` (new component in `packages/ui/src/components/skeletons/`)
- Empty state: "No lapsed customers identified yet." with a sub-caption explaining when the agent classifies customers (Sprint 04)

### 12. Fixture-to-real-data sweep — dashboard and settings

`apps/web/app/app/page.tsx`:
- `getMerchantSummary` for total lapsed count, last-updated timestamp
- Campaigns and conversations panels remain fixture-backed with a visible `[demo data]` caption until Sprint 06 wires them
- Loading skeleton on the hero metric section

`apps/web/app/app/settings/page.tsx`:
- Replace hardcoded `bondi-goods.myshopify.com` with real shop domain from merchant session
- Show `last_backfill_at` from merchant row (add this column in the migration) and a "Re-sync" button that triggers backfill

### 13. Loading and empty states — remaining routes

For every route that still uses fixtures (campaigns, conversations, attribution, billing):
- Add a `[demo data]` caption on the panel header so the merchant understands the data is illustrative
- Ensure these routes render without errors when the real DB tables exist but are empty

For routes with real data fetches (lapsed, dashboard, settings):
- Suspense loading skeletons per section
- Error boundary component: `apps/web/app/app/_components/data-error.tsx` — shown when a DB query throws

### 14. Tests

- `packages/db/__tests__/rls.test.ts` extended: cross-merchant isolation tests for `customers`, `orders`, `customer_events`, `order_events` tables
- `packages/shopify/__tests__/hmac.test.ts` extended: `verifyWebhookHmac` tests — valid passes, tampered body fails, missing header fails, wrong secret fails
- `packages/core/__tests__/customer-events.test.ts`: unit tests for `appendCustomerEvent`, `appendOrderEvent` — validates event structure, rejects invalid payloads
- `packages/core/__tests__/materialize-customer.test.ts`: unit tests for `materializeCustomer` — event log with 3 orders produces correct profile row
- Webhook handler integration tests (vitest): valid payload + valid HMAC → processes; tampered HMAC → 401; duplicate `shopify_webhook_id` → 200 idempotent skip

### 15. HANDOFF.md

Written at sprint end: rubric scores, any deferred items, failure modes encountered, and the exact `psql` command to apply the migrations.

---

## Out of scope

Do not touch these in Sprint 03. They are explicitly later sprints.

- **Sprint 04**: Cadence calculation, lapsed classification, scoring engine (Haiku batch). `lapsed_score`, `lapsed_at` columns exist in the schema but are null — Sprint 04 populates them.
- **Sprint 05**: Onboarding flow refresh, AI-suggested brand voice, storefront crawl.
- **Sprint 06**: SMS sending, two-way conversation engine, opt-out registry, Twilio inbound webhooks. Conversations table exists but messages are not generated.
- **Sprint 07**: AI Campaign Designer, bandit state, Thompson sampling. Campaign tables are post-v1 schema additions.
- **Sprint 08**: Attribution reconciliation, Stripe billing, holdout control groups, usage metering. `attributed_order_gid` and `attributed_revenue_cents` columns exist but are null.
- **Sprint 09**: Performance pricing math, incrementality factor. Not touched here.
- **Webhook handlers for GDPR mandatory topics** (`customers/data_request`, `customers/redact`, `shop/redact`): post-v1 backlog.
- **pgvector background embedding job**: columns and indices exist; the actual embedding generation from Voyage AI / OpenAI is wired in Sprint 06 when conversation messages first exist.
- **Conversation messages**: no messages are created in Sprint 03. The table and embedding column exist for Sprint 06.

---

## Acceptance criteria

Every box must be checked with evidence in the PR description.

**Schema and architecture:**
- [ ] `pgvector` extension enabled in migration 0002 — show migration file
- [ ] `customer_events` table is append-only: UPDATE trigger raises exception — show trigger SQL and test output proving it fires
- [ ] `order_events` table is append-only: same enforcement — same evidence
- [ ] `conversations.embedding` column is `vector(1536)` with ivfflat index — show `\d conversations` output
- [ ] `conversation_messages.embedding` column is `vector(1536)` with ivfflat index — same
- [ ] `channel` column in `conversations` and `conversation_messages` is `text` (not hardcoded enum), default `'sms'` — show column definition
- [ ] RLS enabled on every new table — show `\d+` output or policy list

**Cross-merchant isolation:**
- [ ] Customer from merchant A cannot be read by a JWT scoped to merchant B — test output from `packages/db/__tests__/rls.test.ts`
- [ ] Same isolation verified for `orders`, `customer_events`, `order_events` — test output

**Webhook security:**
- [ ] `verifyWebhookHmac` rejects tampered body — unit test output
- [ ] `verifyWebhookHmac` rejects missing `X-Shopify-Hmac-Sha256` header — unit test output
- [ ] Webhook route returns 401 on bad HMAC, 200 on valid HMAC — integration test output
- [ ] Duplicate `shopify_webhook_id` returns 200 without reprocessing — test output

**Data ingestion:**
- [ ] `customers/create` webhook writes a `customer_events` row and upserts `customers` — test output
- [ ] `orders/paid` webhook writes an `order_events` row, upserts `orders`, and updates `customers.total_ltv_cents` — test output
- [ ] Backfill route paginates correctly and respects cursor — test output
- [ ] `materializeCustomer` produces correct `customers` row from a sequence of events — unit test output

**UI states:**
- [ ] Lapsed customers list shows real DB data (empty state when no customers) — screenshot
- [ ] Dashboard shows real `total_order_count` and `total_ltv_cents` from DB — screenshot
- [ ] Settings page shows real shop domain (no hardcoded `bondi-goods.myshopify.com`) — screenshot
- [ ] Loading skeleton renders on lapsed list while data fetches — screenshot
- [ ] Error boundary renders on lapsed list when DB throws — screenshot
- [ ] Fixture-backed routes (campaigns, conversations, attribution, billing) show `[demo data]` caption — screenshot

**CI gates:**
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` all passing (including new RLS, HMAC, and core tests)
- [ ] `pnpm build` exits 0 for all three apps
- [ ] `pnpm grep:pii` clean — no phone numbers, access tokens, or shop domains in logs

---

## Definition of done

- [ ] All acceptance criteria checked with evidence in PR description
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` all passing
- [ ] `pnpm build` exits 0 for all three apps
- [ ] `pnpm grep:pii` clean
- [ ] `pnpm vercel:env:check` clean (new env vars declared in turbo.json)
- [ ] `HANDOFF.md` committed with rubric scores and migration instructions
- [ ] PR opened, evaluator session run, every rubric criterion scored 3, squash-merged to main

---

## Quality rubric (10 criteria, scored 0–3)

Scored 0–3 by the evaluator session. All must score 3 before merge.

1. **Event-sourcing correctness** — `customer_events` and `order_events` are truly append-only. Trigger prevents UPDATE/DELETE. No code path mutates an event row. Profile regeneration reads events and writes the `customers` snapshot, never patching events.
2. **pgvector correctness** — `vector(1536)` column exists on `conversations` and `conversation_messages`. ivfflat index created. `channel` column is text, not enum. No hardcoded "sms" in table definitions or schema constraints.
3. **Webhook HMAC** — Every webhook entry point verifies the Shopify HMAC before any processing. Tampered-signature test exists and passes. 401 on failure, 200 on success.
4. **Tenancy isolation** — RLS enabled on all 8 new tables. Cross-merchant tests exist and pass for `customers`, `orders`, `customer_events`, `order_events`.
5. **Backfill correctness** — Cursor-based pagination produces no duplicates (upsert-safe). Backfill and webhook ingest produce identical `customers` rows for the same customer.
6. **TypeScript types** — `packages/db/src/types.ts` reflects all new tables. Strict TypeScript compiles without errors. Zero `any`.
7. **No PII in logs** — grep:pii clean. No phone, email, access token, shop domain, or order detail in any `console.log` or structured log output.
8. **UI loading/empty/error states** — Every route with a real data fetch has a Suspense boundary, a loading skeleton, an empty state, and an error boundary. No route crashes on empty DB.
9. **Scope discipline** — Nothing from "Out of scope" was touched. No scoring logic, no SMS, no campaign creation, no attribution math, no billing.
10. **New env vars declared** — Any new environment variables are in `turbo.json` `@lapsed/web#build.env` and in `pnpm vercel:env:check`'s expected list.

---

## 15-chunk implementation sequence

Each chunk is one commit. Architecture-guardian + code-reviewer + test-coverage-analyzer run in parallel after every chunk. Any Critical or High finding blocks the next chunk.

**Foundation:**
1. `feat(db): migration 0002 — pgvector, memory graph schema, append-only triggers, RLS` — SQL migration + updated TypeScript types
2. `test(db): cross-merchant RLS isolation tests for all Sprint 03 tables` — extend `packages/db/__tests__/rls.test.ts`
3. `feat(shopify): verifyWebhookHmac + unit tests` — extend `packages/shopify/src/hmac.ts` + `__tests__/hmac.test.ts`

**Data ingestion:**
4. `feat(webhooks): delivery infrastructure — route, HMAC gate, idempotency log` — `apps/web/app/api/shopify/webhooks/route.ts`
5. `feat(webhooks): customers/create and customers/update handlers` — handler files + integration tests
6. `feat(webhooks): orders/paid handler + app/uninstalled handler` — handler files + integration tests
7. `feat(backfill): Shopify historical data backfill route + onboarding trigger` — `apps/web/app/api/shopify/backfill/route.ts`

**Memory graph:**
8. `feat(core): customer and order event write helpers (appendCustomerEvent, appendOrderEvent)` — `packages/core/src/customer-events.ts` + tests
9. `feat(core): materializeCustomer — profile regeneration from event log` — `packages/core/src/materialize-customer.ts` + tests

**Query layer + env:**
10. `feat(db): DB read helpers for merchant pages (getLapsedCustomers, getCustomer, getMerchantSummary)` — `packages/db/src/queries.ts`
11. `chore(env): declare new env vars in turbo.json + vercel:env:check` — SHOPIFY_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY (if not already present)

**Fixture sweep:**
12. `feat(web): lapsed customers list + detail — real data, Suspense, skeleton, empty state` — replace fixture imports
13. `feat(web): dashboard + settings — real data, merchant summary, shop domain, backfill trigger`
14. `feat(web): loading/empty/error states on all 6 routes; demo-data captions on fixture-backed panels`

**Close:**
15. `docs(sprint-03): HANDOFF.md — rubric scores, migration instructions, failure modes`

---

## Evaluator session prompt

After implementation, open a fresh Claude Code session with this exact prompt:

```
You are a skeptical senior engineer doing QA on Sprint 03 (Data Ingestion and Customer Memory Graph) of lapsed.ai. Your job is to find everything wrong, incomplete, or inconsistent. Do not approve anything unless you are certain it meets the standard.

Read in order: CLAUDE.md, DESIGN-SYSTEM.md, PRODUCT.md, SPRINT.md, HANDOFF.md.

Then run and report exact output:
- pnpm typecheck
- pnpm lint
- pnpm test
- pnpm build
- pnpm grep:pii
- pnpm vercel:env:check
- git diff main --stat

Then verify EVERY acceptance criterion in SPRINT.md against actual code — do not trust HANDOFF.md claims.

Pay special attention to:
1. Are customer_events and order_events truly append-only? Show the trigger SQL and a test that fires it.
2. Does the webhook route return 401 on a tampered HMAC before any DB write? Show the test.
3. Does materializeCustomer read from events (not mutate them)? Trace the code path.
4. Does conversations.embedding exist as vector(1536)? Run \d conversations.
5. Is channel stored as text, never as a hardcoded enum or 'sms'-only constraint?
6. Do all new tables have RLS enabled? Do the cross-merchant tests pass?
7. Is there any "Lapsed AI", "Recovered revenue", "Lapsed cohort" copy in the new UI states? (Those were Sprint 02.6 fixes — ensure they didn't regress here.)

Score each of the 10 rubric criteria 0–3 with justification. Report PASS or REMEDIATE per criterion.
Do not suggest the sprint is complete unless every criterion scores 3.
```
