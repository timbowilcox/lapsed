// Storefront content fetcher — pulls about page, top product descriptions,
// recent blog posts, store policies, and a footer hint from the Shopify
// Admin REST API. Output is the canonical `StorefrontSnapshot` shape that
// chunk 1's `storefront_snapshots` table persists.
//
// Idempotent given same merchant + same Shopify state: the fetcher does
// not mutate Shopify, and `computeSourceHash(snapshot)` returns a stable
// SHA-256 over a canonical serialization so the install orchestrator
// (chunk 7) can dedup re-fetches via the (merchant_id, source_hash) unique
// index.
//
// All Shopify API calls are funneled through an injectable `fetch`
// implementation so unit tests mock the network without touching the
// global. Real callers pass `globalThis.fetch`.

import { createHash } from "node:crypto";

export const SHOPIFY_API_VERSION = "2026-04";

// ─────────────────────────────────────────────────────────────────────────────
// Output shape — matches storefront_snapshots.raw_content JSONB schema
// ─────────────────────────────────────────────────────────────────────────────

export interface StorefrontProductSample {
  title: string;
  body: string;
}

export interface StorefrontBlogSample {
  title: string;
  body: string;
}

export interface StorefrontPolicies {
  privacy: string;
  refund: string;
  shipping: string;
}

export interface StorefrontSnapshot {
  about: string;
  products: StorefrontProductSample[];
  blog: StorefrontBlogSample[];
  policies: StorefrontPolicies;
  footer: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input + dependency injection
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchStorefrontInput {
  shopDomain: string;
  accessToken: string;
  /** Defaults to `globalThis.fetch`. Tests pass a mock. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout in ms. Defaults to 15s. */
  timeoutMs?: number;
}

/**
 * Per-resource fetch outcome. `failures` records resource-level errors so
 * the install orchestrator (chunk 7) can distinguish "merchant has no
 * about page" (snapshot ok, write `storefront_fetched` event) from
 * "Shopify is throwing 5xx" (write `extraction_failed` event instead of
 * persisting a degraded snapshot that would later hash-collide with a
 * real-but-sparse one). Defends decision 8 (snapshot reproducibility).
 */
export type StorefrontFetchFailureReason =
  | "timeout"
  | "http"
  | "network"
  | "parse";

export interface StorefrontFetchFailure {
  resource: "about" | "products" | "blog" | "policies" | "footer";
  reason: StorefrontFetchFailureReason;
  status?: number;
}

export interface StorefrontFetchResult {
  snapshot: StorefrontSnapshot;
  failures: StorefrontFetchFailure[];
}

const ABOUT_TITLE_HEURISTICS = [
  "about",
  "about us",
  "our story",
  "who we are",
  "the story",
  "story",
];

const PAGE_LIMIT = 5;
const PRODUCT_LIMIT = 5;
const BLOG_LIMIT = 5;
const BLOG_ARTICLE_LIMIT = 3;
const PRODUCT_BODY_MAX_CHARS = 4000;
const ABOUT_BODY_MAX_CHARS = 8000;
const SHOPIFY_RETRY_ATTEMPTS = 2;       // initial + 1 retry on 429/5xx
const SHOPIFY_RETRY_BASE_DELAY_MS = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches storefront content from Shopify Admin REST and returns the
 * canonical `StorefrontSnapshot` shape paired with per-resource failure
 * metadata. Missing-or-empty resources produce empty fields and NO
 * failure entry; HTTP / network / timeout failures are surfaced in
 * `failures[]` so the orchestrator can decide whether to persist a
 * degraded snapshot or record an `extraction_failed` event instead.
 *
 * Retries 429 + 5xx responses once with a short jittered backoff
 * (rubric criterion 9 — Shopify equivalent of the Anthropic / Twilio
 * timeout+retry policy).
 *
 * The merchant access token is read from a single argument so this
 * function stays pure and re-runnable. The install orchestrator owns
 * merchant lookup + token decryption.
 */
export async function fetchStorefrontSnapshot(
  input: FetchStorefrontInput,
): Promise<StorefrontFetchResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const baseUrl = `https://${input.shopDomain}/admin/api/${SHOPIFY_API_VERSION}`;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const ctx: FetcherCtx = {
    baseUrl,
    accessToken: input.accessToken,
    fetchImpl,
    timeoutMs,
  };
  const failures: StorefrontFetchFailure[] = [];

  const [about, products, blog, policies, footer] = await Promise.all([
    fetchAbout(ctx, failures),
    fetchProducts(ctx, failures),
    fetchBlog(ctx, failures),
    fetchPolicies(ctx, failures),
    fetchFooter(ctx, failures),
  ]);

  return { snapshot: { about, products, blog, policies, footer }, failures };
}

/**
 * Stable SHA-256 over a canonical JSON serialization of the snapshot.
 * Used by the install orchestrator (chunk 7) to dedup re-fetches against
 * the `(merchant_id, source_hash)` unique index on storefront_snapshots.
 *
 * Canonicalization: object keys sorted alphabetically; arrays preserve
 * order. This means a Shopify-side reorder of products or blog articles
 * will produce a different hash — which is correct, since order changes
 * the input corpus the LLM sees.
 */
export function computeSourceHash(snapshot: StorefrontSnapshot): string {
  return createHash("sha256").update(canonicalize(snapshot)).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource fetchers
// ─────────────────────────────────────────────────────────────────────────────

interface FetcherCtx {
  baseUrl: string;
  accessToken: string;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs: number;
}

type ShopifyGetResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: StorefrontFetchFailureReason; status?: number };

/**
 * Performs a single Shopify Admin REST GET with timeout + 1-retry on
 * 429 / 5xx. Returns a discriminated union so the caller can record a
 * structured failure (decision 8: a degraded snapshot must be
 * distinguishable from a fetch failure).
 */
async function shopifyGet<T>(ctx: FetcherCtx, path: string): Promise<ShopifyGetResult<T>> {
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < SHOPIFY_RETRY_ATTEMPTS; attempt++) {
    try {
      const resp = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
        signal: AbortSignal.timeout(ctx.timeoutMs),
        headers: {
          "X-Shopify-Access-Token": ctx.accessToken,
          "Content-Type": "application/json",
        },
      });
      if (resp.ok) {
        try {
          return { ok: true, data: (await resp.json()) as T };
        } catch {
          return { ok: false, reason: "parse", status: resp.status };
        }
      }
      lastStatus = resp.status;
      // Retry only on 429 + 5xx; 4xx (auth, scope, not-found) is terminal.
      if (resp.status !== 429 && resp.status < 500) {
        return { ok: false, reason: "http", status: resp.status };
      }
    } catch (err) {
      const name = (err as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        if (attempt === SHOPIFY_RETRY_ATTEMPTS - 1) {
          return { ok: false, reason: "timeout" };
        }
      } else {
        if (attempt === SHOPIFY_RETRY_ATTEMPTS - 1) {
          return { ok: false, reason: "network" };
        }
      }
    }
    // Jittered backoff before the next attempt.
    const delay = SHOPIFY_RETRY_BASE_DELAY_MS * (attempt + 1) + Math.floor(Math.random() * 50);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return { ok: false, reason: "http", status: lastStatus };
}

function recordFailure(
  failures: StorefrontFetchFailure[],
  resource: StorefrontFetchFailure["resource"],
  result: { reason: StorefrontFetchFailureReason; status?: number },
): void {
  failures.push({ resource, reason: result.reason, status: result.status });
}

async function fetchAbout(
  ctx: FetcherCtx,
  failures: StorefrontFetchFailure[],
): Promise<string> {
  const json = await shopifyGet<{ pages?: ShopifyPage[] }>(
    ctx,
    `/pages.json?limit=${PAGE_LIMIT}&published_status=published&fields=id,title,body_html,published_at`,
  );
  if (!json.ok) {
    recordFailure(failures, "about", json);
    return "";
  }
  const pages = json.data.pages ?? [];
  if (pages.length === 0) return "";
  const aboutPage = pickAboutPage(pages);
  if (!aboutPage) return "";
  return truncate(stripHtml(aboutPage.body_html ?? ""), ABOUT_BODY_MAX_CHARS);
}

/**
 * Picks the page whose title most closely matches an "about" heuristic.
 * Shopify's REST API exposes neither sales data nor an "is canonical
 * about page" flag, so heuristic is our only signal.
 */
function pickAboutPage(pages: ShopifyPage[]): ShopifyPage | null {
  for (const heuristic of ABOUT_TITLE_HEURISTICS) {
    for (const page of pages) {
      if ((page.title ?? "").toLowerCase().trim() === heuristic) return page;
    }
  }
  // Fallback: any page whose title contains "about" or "story"
  for (const page of pages) {
    const t = (page.title ?? "").toLowerCase();
    if (t.includes("about") || t.includes("story")) return page;
  }
  return null;
}

async function fetchProducts(
  ctx: FetcherCtx,
  failures: StorefrontFetchFailure[],
): Promise<StorefrontProductSample[]> {
  // Best-sellers heuristic: Shopify Admin REST doesn't expose total_sales.
  // We use most recently published products as a proxy — these are typically
  // the merchant's actively promoted catalog. The voice extractor cares
  // about tone, not commercial ranking, so a proxy is acceptable.
  //
  // `order=` is not a documented public Admin REST parameter — we sort
  // client-side over `published_at` after fetch. Tie-breaker is title asc
  // so the order is deterministic; decision 8 (snapshot reproducibility)
  // requires the source_hash to be stable across re-fetches.
  const json = await shopifyGet<{ products?: ShopifyProduct[] }>(
    ctx,
    `/products.json?limit=${PRODUCT_LIMIT * 4}&published_status=published&fields=title,body_html,published_at`,
  );
  if (!json.ok) {
    recordFailure(failures, "products", json);
    return [];
  }
  const products = (json.data.products ?? []).slice();
  products.sort((a, b) => {
    const aT = a.published_at ? Date.parse(a.published_at) : 0;
    const bT = b.published_at ? Date.parse(b.published_at) : 0;
    if (bT !== aT) return bT - aT;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
  return products.slice(0, PRODUCT_LIMIT).map((p) => ({
    title: (p.title ?? "").trim(),
    body: truncate(stripHtml(p.body_html ?? ""), PRODUCT_BODY_MAX_CHARS),
  }));
}

async function fetchBlog(
  ctx: FetcherCtx,
  failures: StorefrontFetchFailure[],
): Promise<StorefrontBlogSample[]> {
  const blogsJson = await shopifyGet<{ blogs?: ShopifyBlog[] }>(
    ctx,
    `/blogs.json?fields=id,title`,
  );
  if (!blogsJson.ok) {
    recordFailure(failures, "blog", blogsJson);
    return [];
  }
  const blogs = (blogsJson.data.blogs ?? []).slice(0, BLOG_LIMIT);
  if (blogs.length === 0) return [];

  // Fetch each blog's articles in parallel — bounded by BLOG_LIMIT.
  const articleBatches = await Promise.all(
    blogs.map((blog) =>
      shopifyGet<{ articles?: ShopifyArticle[] }>(
        ctx,
        `/blogs/${blog.id}/articles.json?limit=${BLOG_ARTICLE_LIMIT}&published_status=published&fields=id,title,body_html,published_at`,
      ),
    ),
  );

  let anyBlogFailed = false;
  const collected: (ShopifyArticle & { _blogId: number })[] = [];
  for (let i = 0; i < articleBatches.length; i++) {
    const batch = articleBatches[i]!;
    const blog = blogs[i]!;
    if (!batch.ok) {
      anyBlogFailed = true;
      continue;
    }
    for (const article of batch.data.articles ?? []) {
      collected.push({ ...article, _blogId: blog.id });
    }
  }
  if (anyBlogFailed && collected.length === 0) {
    // Only record a blog failure if no articles at all were retrieved;
    // a partial success still produces a meaningful snapshot.
    recordFailure(failures, "blog", { reason: "http" });
  }

  // Deterministic sort: published_at desc, then blog_id asc, then id asc,
  // then title asc — eliminates tie-induced hash drift across re-fetches.
  collected.sort((a, b) => {
    const aT = a.published_at ? Date.parse(a.published_at) : 0;
    const bT = b.published_at ? Date.parse(b.published_at) : 0;
    if (bT !== aT) return bT - aT;
    if (a._blogId !== b._blogId) return a._blogId - b._blogId;
    if ((a.id ?? 0) !== (b.id ?? 0)) return (a.id ?? 0) - (b.id ?? 0);
    return (a.title ?? "").localeCompare(b.title ?? "");
  });

  return collected.slice(0, BLOG_ARTICLE_LIMIT).map((a) => ({
    title: (a.title ?? "").trim(),
    body: truncate(stripHtml(a.body_html ?? ""), PRODUCT_BODY_MAX_CHARS),
  }));
}

async function fetchPolicies(
  ctx: FetcherCtx,
  failures: StorefrontFetchFailure[],
): Promise<StorefrontPolicies> {
  const json = await shopifyGet<{ policies?: ShopifyPolicy[] }>(
    ctx,
    `/policies.json`,
  );
  if (!json.ok) {
    recordFailure(failures, "policies", json);
    return { privacy: "", refund: "", shipping: "" };
  }
  const policies = json.data.policies ?? [];
  const byHandle = (handle: string): string => {
    const found = policies.find((p) => (p.handle ?? "") === handle);
    return truncate(stripHtml(found?.body ?? ""), PRODUCT_BODY_MAX_CHARS);
  };
  return {
    privacy: byHandle("privacy-policy"),
    refund: byHandle("refund-policy"),
    shipping: byHandle("shipping-policy"),
  };
}

async function fetchFooter(
  ctx: FetcherCtx,
  failures: StorefrontFetchFailure[],
): Promise<string> {
  // Shopify Admin REST does not expose notification email footer directly.
  // We use shop.json's name as a proxy signal — sparse, but enough for the
  // voice extractor to anchor a sign-off style. Emails are intentionally
  // NOT included: the PII redactor (decision 10, chunk 3) would replace
  // them with `[email]` tokens, which is zero signal for sign-off style
  // detection. Better to omit than feed the LLM near-meaningless tokens.
  const json = await shopifyGet<{ shop?: ShopifyShop }>(
    ctx,
    `/shop.json?fields=name`,
  );
  if (!json.ok) {
    recordFailure(failures, "footer", json);
    return "";
  }
  return json.data.shop?.name?.trim() ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML stripping + canonicalization helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conservative HTML stripper: removes script/style blocks, comments, and
 * tags, then decodes named + numeric (`&#64;`) + hex (`&#x40;`) entities,
 * then collapses whitespace.
 *
 * Decoding numeric and hex entities is load-bearing: decision 10 requires
 * PII redaction before any LLM call, and the redactor's email/phone
 * regexes only match literal `@` and digits. Without entity decoding,
 * `support&#64;example.com` would survive stripping as-is, evade redaction,
 * and reach Sonnet unredacted. The decoder runs after tag removal so
 * literal `<`/`>` from `&lt;`/`&gt;` are not re-interpreted as tags.
 */
export function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => decodeCodepoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => decodeCodepoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Range-safe codepoint decoder; rejects out-of-range or non-finite values. */
function decodeCodepoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * Canonical JSON serialization with sorted keys. Identical inputs produce
 * byte-identical outputs, so `computeSourceHash` is deterministic across
 * processes.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shopify REST response shapes (narrow — only fields we actually consume)
// ─────────────────────────────────────────────────────────────────────────────

interface ShopifyPage {
  id?: number;
  title?: string;
  body_html?: string;
  published_at?: string | null;
}

interface ShopifyProduct {
  title?: string;
  body_html?: string;
  published_at?: string | null;
}

interface ShopifyBlog {
  id: number;
  title?: string;
}

interface ShopifyArticle {
  id?: number;
  title?: string;
  body_html?: string;
  published_at?: string | null;
}

interface ShopifyPolicy {
  handle?: string;
  body?: string;
  title?: string;
}

interface ShopifyShop {
  name?: string;
  email?: string;
  customer_email?: string;
}
