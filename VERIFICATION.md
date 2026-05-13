# VERIFICATION.md — lapsed.ai Pre-Sprint 01 Preflight

**Run date:** 2026-05-13  
**Top-line result:** ⚠ CONDITIONAL — 2 credential pings FAIL, 6 env keys MISSING, .gitignore absent.  
Sprint 01 is **NOT READY** to start until the items in "What to fix" are resolved.

---

## Phase 1 — File presence

| File | Status |
|---|---|
| CLAUDE.md | PRESENT ✓ |
| SPRINT.md | PRESENT ✓ |
| DESIGN-SYSTEM.md | PRESENT ✓ |
| PREREQUISITES.md | PRESENT ✓ |
| mockup-dashboard.html | PRESENT ✓ |
| .env.local | PRESENT ✓ |
| .gitignore | **MISSING** ✗ |

All five harness markdown files are present. Proceeding to Phase 2.

---

## Phase 2 — .gitignore safety

| Check | Result |
|---|---|
| .gitignore exists | **MISSING** ✗ |
| .gitignore contains rule for .env.local | **CANNOT CHECK** (file absent) |
| git repository initialised | NO — `C:\dev\lapsed` is not yet a git repo |
| .env.local at risk of commit | **YES** — without .gitignore, running `git init && git add .` would stage .env.local |

**Risk level: HIGH.**  
There is no `.gitignore` file. Once `git init` is run (which must happen before Sprint 01 commits), `.env.local` will appear as an untracked file and could be staged. This must be resolved before initialising the repository.

---

## Phase 3 — Env var presence

26 of 32 expected keys are POPULATED. 6 are MISSING. None are BLANK.

| Key | Status |
|---|---|
| GITHUB_TOKEN | POPULATED ✓ |
| GITHUB_REPO | **MISSING** ✗ |
| VERCEL_TOKEN | POPULATED ✓ |
| VERCEL_PROJECT_ID | POPULATED ✓ |
| VERCEL_ORG_ID | POPULATED ✓ |
| NEXT_PUBLIC_SUPABASE_URL | POPULATED ✓ |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | POPULATED ✓ |
| SUPABASE_SECRET_KEY | POPULATED ✓ |
| SUPABASE_DB_URL | POPULATED ✓ |
| SUPABASE_PROJECT_REF | POPULATED ✓ |
| SUPABASE_ACCESS_TOKEN | POPULATED ✓ |
| SHOPIFY_API_KEY | **MISSING** ✗ |
| SHOPIFY_API_SECRET | **MISSING** ✗ |
| SHOPIFY_SCOPES | **MISSING** ✗ |
| SHOPIFY_OPTIONAL_SCOPES | **MISSING** ✗ |
| SHOPIFY_DEV_STORE | **MISSING** ✗ |
| STRIPE_PUBLISHABLE_KEY | POPULATED ✓ |
| STRIPE_SECRET_KEY | POPULATED ✓ |
| STRIPE_WEBHOOK_SECRET | POPULATED ✓ |
| STRIPE_PRICE_STARTER | POPULATED ✓ |
| STRIPE_PRICE_GROWTH | POPULATED ✓ |
| STRIPE_PRICE_SCALE | POPULATED ✓ |
| TWILIO_ACCOUNT_SID | POPULATED ✓ |
| TWILIO_AUTH_TOKEN | POPULATED ✓ |
| TWILIO_PHONE_NUMBER | POPULATED ✓ |
| TWILIO_TEST_RECIPIENT | POPULATED ✓ |
| ANTHROPIC_API_KEY | POPULATED ✓ |
| ANTHROPIC_MODEL_CONVERSATION | POPULATED ✓ |
| ANTHROPIC_MODEL_SCORING | POPULATED ✓ |
| ANTHROPIC_DEFAULT_MAX_TOKENS | POPULATED ✓ |
| RESEND_API_KEY | POPULATED ✓ |
| RESEND_FROM_EMAIL | POPULATED ✓ |

**Notable discrepancy:** `ANTHROPIC_MODEL_SCORING` is set to `claude-haiku-4-5-20251001` but `CLAUDE.md` specifies `claude-opus-4-7` for scoring. Haiku is significantly less capable than Opus for probability scoring. Verify this is intentional.

**Shopify note:** All 5 Shopify keys are missing. Sprint 01 is frontend-only (no backend), so this does not block Sprint 01 itself — but they must be added before Sprint 02.

---

## Phase 4 — External credential pings

| Service | Check | Status | Detail |
|---|---|---|---|
| GitHub | GET /user, login=timbowilcox | **PASS** ✓ | HTTP 200, login matches |
| Vercel | GET /v2/user | **PASS** ✓ | HTTP 200, username=timwilcox |
| Supabase Management API | GET /v1/projects | **PASS** ✓ | HTTP 200 |
| Supabase REST | GET /rest/v1/ with publishable key | **FAIL** ✗ | HTTP 401 — see note below |
| Supabase Postgres (psql) | `psql "$SUPABASE_DB_URL" -c "SELECT 1"` | **SKIPPED** — psql not installed; test in Sprint 02 |
| Stripe account | GET /v1/account | **PASS** ✓ | HTTP 200 |
| STRIPE_PRICE_STARTER | GET /v1/prices/{id} | **PASS** ✓ | HTTP 200, interval=month, currency=usd |
| STRIPE_PRICE_GROWTH | GET /v1/prices/{id} | **PASS** ✓ | HTTP 200, interval=month, currency=usd |
| STRIPE_PRICE_SCALE | GET /v1/prices/{id} | **PASS** ✓ | HTTP 200, interval=month, currency=usd |
| Stripe webhook | GET /v1/webhook_endpoints, URL contains lapsed.ai | **PASS** ✓ | 1 endpoint: `https://app.lapsed.ai/api/stripe/webhook` |
| Twilio | GET /Accounts/{SID}.json, friendly_name contains "Lapsed" | **PASS** ✓ | HTTP 200, friendly_name=Lapsed |
| Anthropic | POST /v1/messages with claude-sonnet-4-6 | **PASS** ✓ | HTTP 200, stop_reason=max_tokens |
| Resend | GET /domains, lapsed.ai verified | **FAIL** ✗ | HTTP 401 — API key rejected |
| Shopify (API_KEY / API_SECRET) | OAuth flow required | **DEFERRED** — verify in Sprint 02 |

**Supabase REST FAIL — detail:**  
The `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` value uses the new Supabase `sb_publishable_` prefix format, not the legacy JWT (`eyJ…`) anon key. The REST API at the project URL returned HTTP 401. Additionally, `supabase projects list` (with the SUPABASE_ACCESS_TOKEN) does not list the lapsed project ref (`vuyjtkpubxadudahzrlh`) — it shows four other projects under different orgs. This suggests either (a) the lapsed Supabase project lives under a separate Supabase account/org whose access token is not what's in `.env.local`, or (b) the publishable key does not match the project. Recommend: log into the Supabase dashboard for this project and copy the anon/publishable key directly.

**Resend FAIL — detail:**  
The Resend API returned HTTP 401, meaning the API key is not valid or has been rotated. Additionally, no `lapsed.ai` domain was found in the account. Recommend: regenerate the Resend API key from the Resend dashboard and add the `lapsed.ai` sending domain.

---

## Phase 5 — Toolchain

| Tool | Version / Result | Status |
|---|---|---|
| node | v25.8.0 | INSTALLED ✓ (note: not an LTS version; LTS is v22) |
| pnpm | 10.13.1 | INSTALLED ✓ |
| git | 2.53.0.windows.1 | INSTALLED ✓ |
| git config user.name | timbowilcox | SET ✓ |
| git config user.email | tim@blart.ai | SET ✓ (note: @blart.ai, not @lapsed.ai) |
| git remote -v | N/A — not a git repo yet | — |
| supabase CLI | 2.98.2 | INSTALLED ✓ |
| supabase projects list | Authenticated, 4 projects listed (lapsed not among them — see Phase 4 note) | AUTHENTICATED ✓ |
| stripe CLI | 1.40.9 | INSTALLED ✓ |
| vercel CLI | 53.1.1 | INSTALLED ✓ |
| vercel whoami | timwilcox | AUTHENTICATED ✓ |
| psql | Not installed | **MISSING** ⚠ — will be needed for Sprint 02 DB work |

**Node version note:** v25.8.0 is a current-release (not LTS) version of Node. The project has not yet specified a `.nvmrc` or `engines` field, so this is not a blocker for Sprint 01, but it is worth pinning to Node 22 LTS (the version Vercel uses) before backend work begins.

---

## Phase 6 — DNS

| Check | Result | Status |
|---|---|---|
| `nslookup app.lapsed.ai` | Resolves to `e51c799447abe4a3.vercel-dns-016.com` (216.150.1.65 / 216.150.16.65) | **PASS** ✓ |

DNS is correctly pointed to Vercel. The CNAME resolves to `vercel-dns-016.com`, which is an accepted Vercel DNS target.

---

## What to fix

Items must be resolved before starting Sprint 01 (or as indicated below).

### BLOCKING — resolve before `git init` or any commit

| # | Item | Remediation |
|---|---|---|
| B1 | `.gitignore` is absent | Create `.gitignore` at repo root before running `git init`. At minimum it must contain `.env.local`, `node_modules/`, `.next/`, `dist/`, `.turbo/`, `*.log`. Do this FIRST — before any `git init` command. |

### BLOCKING for Sprint 01 — resolve before starting

*(none — Sprint 01 is frontend-only, no backend or external service calls)*

### BLOCKING for Sprint 02 — must be resolved before Sprint 02

| # | Item | Remediation |
|---|---|---|
| B2 | `GITHUB_REPO` missing | Add `GITHUB_REPO=<owner>/<repo>` to `.env.local` once the GitHub repo is created. |
| B3 | All 5 Shopify keys missing | Create the Shopify Partner app, get `API_KEY` and `API_SECRET`, then populate `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_SCOPES`, `SHOPIFY_OPTIONAL_SCOPES`, `SHOPIFY_DEV_STORE` in `.env.local`. See `PREREQUISITES.md`. |
| B4 | Supabase REST ping — HTTP 401 | Log into the Supabase dashboard for project `vuyjtkpubxadudahzrlh`. Under Settings → API, copy the `anon`/`publishable` key and paste it into `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Also verify the project belongs to the same account as `SUPABASE_ACCESS_TOKEN`. |
| B5 | Resend API key rejected — HTTP 401 | Log into Resend, regenerate the API key, and update `RESEND_API_KEY` in `.env.local`. Also add and verify the `lapsed.ai` sending domain in the Resend dashboard. |
| B6 | `psql` not installed | Install PostgreSQL client tools (e.g., via `winget install PostgreSQL.PostgreSQL` or download the Windows installer and select CLI tools only). Required for direct DB access in Sprint 02+. |

### Warnings — non-blocking but worth reviewing

| # | Item | Note |
|---|---|---|
| W1 | `ANTHROPIC_MODEL_SCORING` set to `claude-haiku-4-5-20251001`, not `claude-opus-4-7` | `CLAUDE.md` specifies Opus for scoring. Haiku will score faster and cheaper but less accurately. Confirm which model to use before Sprint 04 (scoring engine). |
| W2 | Node version is v25.8.0 (not LTS) | Vercel builds use Node 22 LTS by default. Risk of subtle runtime divergence. Consider installing Node 22 LTS and setting a `.nvmrc`. Not a Sprint 01 blocker. |
| W3 | `git config user.email` is `tim@blart.ai` | Commits will be attributed to this email. Fine for a private repo; may want to update if using a dedicated lapsed.ai identity. |
| W4 | Supabase lapsed project not visible in `supabase projects list` | The project ref in `.env.local` doesn't appear under the authenticated user's orgs. Once B4 is resolved this should be re-checked. |

---

## Summary table

| Phase | Items | Pass | Fail | Skipped/Deferred |
|---|---|---|---|---|
| 1 — File presence | 7 | 6 | 1 (.gitignore) | 0 |
| 2 — .gitignore safety | — | — | CRITICAL | — |
| 3 — Env vars | 32 | 26 | 0 | 6 missing |
| 4 — Credential pings | 14 | 10 | 2 (Supabase REST, Resend) | 2 (psql, Shopify) |
| 5 — Toolchain | 11 | 10 | 0 | 1 (psql) |
| 6 — DNS | 1 | 1 | 0 | 0 |

---

## Ready to start Sprint 01?

**NO.**

One action is required first:

1. **Create `.gitignore`** (B1) — must exist before `git init` to prevent `.env.local` from being committed.

Once `.gitignore` is in place and `git init` is run safely, Sprint 01 (design system + clickable UI, no backend) can begin. The Shopify, Supabase REST, and Resend failures are not blockers for Sprint 01 because that sprint has no backend or external service calls.

All Sprint 02 blockers (B2–B6) must be resolved before that sprint begins.
