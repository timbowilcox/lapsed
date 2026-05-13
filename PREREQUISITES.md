# PREREQUISITES — One-Time Setup

Complete every item in this file once, before opening the first Claude Code session. The goal is to gather every credential and external dependency now, so Sprints 1–6 can run autonomously without Tim being asked to "go register an account" mid-sprint.

When done, every credential lives in a single `.env.local` file at the repo root that Claude Code reads on every sprint.

---

## 1. GitHub repo

- [ ] Create empty private repo `lapsed-ai` under your GitHub account
- [ ] Generate a Personal Access Token (classic, scope: `repo`) and capture
- [ ] Clone locally to `C:\Users\timwi\.claude\projects\lapsed-ai`

```env
GITHUB_TOKEN=
GITHUB_REPO=timbowilcox/lapsed-ai
```

## 2. Vercel

- [ ] Sign in to Vercel with the GitHub account that owns `lapsed-ai`
- [ ] Import the `lapsed-ai` repo (do not deploy yet — let Sprint 1 trigger the first deploy)
- [ ] Set region to `syd1`
- [ ] Generate a Vercel API token (Settings → Tokens, full account scope, no expiry)
- [ ] Capture project ID and org/team ID from project settings

```env
VERCEL_TOKEN=
VERCEL_PROJECT_ID=
VERCEL_ORG_ID=
```

## 3. Supabase

- [ ] Create new project `lapsed-ai` in region `Sydney (ap-southeast-2)`
- [ ] Capture project URL, anon key, service role key (Settings → API)
- [ ] Capture database connection string (Settings → Database → Connection string, URI mode)
- [ ] Install Supabase CLI locally: `npm i -g supabase` and run `supabase login`

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_URL=
SUPABASE_PROJECT_REF=
```

## 4. Shopify Partners

The Partner organization is **Lapsed** (its own org, not nested under Mac Farms). Apps live as versions inside this org. Shopify CLI will manage `shopify.app.toml` in the repo from Sprint 02 onwards and push config updates automatically — the manual config below establishes the initial state.

### Partner org and app setup

- [x] Sign in to Shopify Partners with the chosen portfolio email
- [x] Set Partner organization name to `Lapsed`
- [x] Create the first app, name: `Lapsed` (capital L for App Store presentation; the wordmark `lapsed.` is a UI choice, not the legal store name)

### App version configuration

In the Create Version screen, set:

- [ ] **App name**: `Lapsed`
- [ ] **App URL**: `https://app.lapsed.ai` (placeholder until Sprint 02 deploys; Shopify CLI manages tunnel URLs during `shopify app dev`)
- [ ] **Embed app in Shopify admin**: checked
- [ ] **Preferences URL**: leave blank
- [ ] **Webhooks API version**: `2026-04`
- [ ] **Scopes** (required, blocking at install — keep minimal to maximise install conversion):
  ```
  read_customers,read_orders,read_products,write_discounts,write_pixels
  ```
- [ ] **Optional scopes** (declared now, requested dynamically when the feature first runs — no install friction, no future config redeploy):
  ```
  read_inventory,read_checkouts,write_draft_orders,read_locations,read_price_rules
  ```
- [ ] **Use legacy install flow**: unchecked
- [ ] **Redirect URLs**: `https://app.lapsed.ai/api/shopify/callback`
- [ ] **POS**: leave collapsed
- [ ] **App proxy**: leave collapsed
- [ ] Click **Release**
- [ ] Keep the app unpublished — do not submit to App Store yet (Sprint 06 revisits)

### Capture credentials and dev store

- [ ] Capture API key and API secret from the app's API access page
- [ ] Create a development store named `lapsed-test`
- [ ] Install demo data on the dev store (Shopify admin → Settings → Test data → Generate orders, products, customers)

```env
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_SCOPES=read_customers,read_orders,read_products,write_discounts,write_pixels
SHOPIFY_OPTIONAL_SCOPES=read_inventory,read_checkouts,write_draft_orders,read_locations,read_price_rules
SHOPIFY_DEV_STORE=lapsed-test.myshopify.com
```

## 5. Stripe

- [ ] Create Stripe account or sign in
- [ ] Enable test mode for all setup (production keys come post-v1)
- [ ] Capture test publishable and secret keys
- [ ] Create three products in test mode: "Starter $299/mo", "Growth $799/mo", "Scale $1,999/mo", each as monthly recurring USD
- [ ] Capture each price ID
- [ ] Create a Stripe webhook endpoint pointed at `https://app.lapsed.ai/api/stripe/webhook` (Sprint 06 will re-validate)
- [ ] Capture webhook signing secret

```env
STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER=
STRIPE_PRICE_GROWTH=
STRIPE_PRICE_SCALE=
```

## 6. Twilio

- [ ] Create Twilio account or sign in
- [ ] Stay in trial mode for v1 development
- [ ] Buy one trial US toll-free number (cheapest option, will be replaced with merchant-specific 10DLC numbers post-v1)
- [ ] Capture Account SID and Auth Token (Console → Account Info)
- [ ] Capture the phone number purchased
- [ ] Verify one personal phone number as a trial recipient (for end-to-end SMS testing in Sprint 05)

```env
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=
TWILIO_TEST_RECIPIENT=   # your personal mobile, E.164 format e.g. +614xxxxxxxx
```

## 7. Anthropic API

- [ ] Sign in to console.anthropic.com under the account billed to Mac Farms Pty Ltd
- [ ] Create a new API key named `lapsed-ai-dev`
- [ ] Set a monthly spend limit of $50 on the key (cap blast radius during development)

```env
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL_DEFAULT=claude-sonnet-4-6
ANTHROPIC_MODEL_SCORING=claude-opus-4-7
```

## 8. Resend (email fallback, Sprint 06)

- [ ] Sign in to resend.com
- [ ] Generate an API key
- [ ] Add and verify the domain `lapsed.ai` (DNS records below)

```env
RESEND_API_KEY=
RESEND_FROM_EMAIL=notifications@lapsed.ai
```

## 9. DNS for lapsed.ai

- [ ] In your domain registrar, add the Vercel A/CNAME records for `lapsed.ai` (apex, marketing) and `app.lapsed.ai` (embedded app)
- [ ] Add Resend's SPF, DKIM, DMARC records (Resend will show the exact records to add)
- [ ] Confirm propagation with `nslookup lapsed.ai` and `nslookup app.lapsed.ai`

(no env vars — DNS is external)

## 10. Local toolchain

- [ ] Node.js 22 LTS installed (`node -v`)
- [ ] pnpm 9 installed (`pnpm -v`)
- [ ] Git configured with your GitHub credentials
- [ ] Supabase CLI authenticated (`supabase login`)
- [ ] Vercel CLI installed and authenticated (`pnpm i -g vercel && vercel login`)
- [ ] Stripe CLI installed and authenticated (`stripe login` — needed for webhook forwarding in dev)
- [ ] Shopify CLI installed (`pnpm i -g @shopify/cli @shopify/app`)
- [ ] Playwright system dependencies installed once: `npx playwright install --with-deps chromium`

---

## Final step before opening Claude Code

- [ ] Create `.env.local` at the repo root containing every variable above filled in
- [ ] Create `.env.example` at the repo root with the same keys but empty values, and add it to git
- [ ] Verify `.gitignore` contains `.env.local`
- [ ] Verify the repo is clean: `git status` shows no untracked secrets

Once every box above is ticked and `.env.local` is populated, Sprints 1–6 can run end-to-end without further setup interruptions. The only manual touchpoints remaining are: (a) install the dev Shopify app on the test store after Sprint 02 deploys it, and (b) reply to one test SMS during Sprint 05 from your verified Twilio trial recipient phone.
