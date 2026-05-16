import { describe, expect, it, vi } from "vitest";
import {
  fetchStorefrontSnapshot,
  computeSourceHash,
  stripHtml,
  SHOPIFY_API_VERSION,
  type StorefrontSnapshot,
} from "../src/storefront-fetcher";

const SHOP = "voice-test.myshopify.com";
const TOKEN = "shpat_test_token";
const BASE = `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}`;

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

interface RouteResponse {
  status?: number;
  body?: unknown;
}

function buildFetch(routes: Record<string, RouteResponse | (() => RouteResponse)>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [route, resp] of Object.entries(routes)) {
      if (url.startsWith(`${BASE}${route}`)) {
        const r = typeof resp === "function" ? resp() : resp;
        return new Response(JSON.stringify(r.body ?? {}), {
          status: r.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

const ALL_EMPTY_ROUTES = {
  "/pages.json": { body: { pages: [] } },
  "/products.json": { body: { products: [] } },
  "/blogs.json": { body: { blogs: [] } },
  "/policies.json": { body: { policies: [] } },
  "/shop.json": { body: { shop: {} } },
} as const;

function snapshot(overrides: Partial<StorefrontSnapshot> = {}): StorefrontSnapshot {
  return {
    about: "We make small-batch granola in Brooklyn.",
    products: [{ title: "Maple Walnut", body: "Crunchy, not too sweet." }],
    blog: [{ title: "Year One", body: "What we learned." }],
    policies: { privacy: "", refund: "30 days", shipping: "Free over $50" },
    footer: "Tiny Goods Co.",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// stripHtml
// ─────────────────────────────────────────────────────────────────────────────

describe("stripHtml", () => {
  it("removes all tags", () => {
    expect(stripHtml("<p>hello <strong>world</strong></p>")).toBe("hello world");
  });

  it("removes script and style contents", () => {
    expect(stripHtml("<script>alert(1)</script>copy")).toBe("copy");
    expect(stripHtml("<style>.x{}</style>more copy")).toBe("more copy");
  });

  it("removes HTML comments", () => {
    expect(stripHtml("before<!-- hidden author note --> after")).toBe("before after");
  });

  it("decodes common named HTML entities", () => {
    expect(stripHtml("Tim&#39;s &amp; Co. &quot;wow&quot;")).toBe("Tim's & Co. \"wow\"");
    expect(stripHtml("space&nbsp;here")).toBe("space here");
  });

  // ───── Decision 10 (PII redaction): entity-encoded PII MUST be decoded ─────
  // so the chunk-3 redactor's @-pattern and digit-patterns can match.

  it("decodes decimal numeric entity for @ so PII redaction is not bypassed", () => {
    // &#64; encodes "@" — without decoding, an email like support&#64;example.com
    // would survive stripHtml and reach the LLM unredacted.
    expect(stripHtml("support&#64;example.com")).toBe("support@example.com");
  });

  it("decodes hex numeric entity for @ so PII redaction is not bypassed", () => {
    // &#x40; also encodes "@" in hex form.
    expect(stripHtml("support&#x40;example.com")).toBe("support@example.com");
  });

  it("decodes mixed-case hex entities", () => {
    expect(stripHtml("&#X2E; period &#x2E;")).toBe(". period .");
  });

  it("rejects out-of-range numeric entities by erasing them", () => {
    // 0x110000 is one past the maximum Unicode codepoint (0x10FFFF) — decoder
    // returns "" which leaves the adjacent chars concatenated after whitespace
    // collapse.
    expect(stripHtml("a&#1114112;b")).toBe("ab");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("<p>a</p>\n\n<p>b</p>")).toBe("a b");
  });

  it("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchStorefrontSnapshot — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchStorefrontSnapshot — happy path", () => {
  it("returns the canonical snapshot shape with all fields populated and zero failures", async () => {
    const fetch = buildFetch({
      "/pages.json": {
        body: {
          pages: [
            { id: 1, title: "Contact" },
            { id: 2, title: "About Us", body_html: "<p>We are a tiny <em>maker</em> brand.</p>" },
            { id: 3, title: "FAQ" },
          ],
        },
      },
      "/products.json": {
        body: {
          products: [
            { title: "Cocoa Almond", body_html: "<p>Cocoa hit. Bold.</p>", published_at: "2026-04-01T00:00:00Z" },
            { title: "Maple Walnut", body_html: "<p>Crunchy, not too sweet.</p>", published_at: "2026-04-10T00:00:00Z" },
          ],
        },
      },
      "/blogs.json": { body: { blogs: [{ id: 10, title: "Journal" }] } },
      "/blogs/10/articles.json": {
        body: {
          articles: [
            {
              id: 100,
              title: "Why we started",
              body_html: "<p>We wanted real food.</p>",
              published_at: "2026-04-10T00:00:00Z",
            },
            {
              id: 101,
              title: "How we ship",
              body_html: "<p>Same day.</p>",
              published_at: "2026-04-01T00:00:00Z",
            },
          ],
        },
      },
      "/policies.json": {
        body: {
          policies: [
            { handle: "privacy-policy", body: "<p>We respect privacy.</p>" },
            { handle: "refund-policy", body: "<p>30-day refunds.</p>" },
            { handle: "shipping-policy", body: "<p>Free over $50.</p>" },
          ],
        },
      },
      "/shop.json": { body: { shop: { name: "Tiny Goods Co.", email: "hi@tiny.co" } } },
    });

    const result = await fetchStorefrontSnapshot({
      shopDomain: SHOP,
      accessToken: TOKEN,
      fetch,
    });

    expect(result.failures).toEqual([]);
    expect(result.snapshot.about).toBe("We are a tiny maker brand.");
    // Products are now sorted client-side by published_at desc, then title asc.
    expect(result.snapshot.products).toEqual([
      { title: "Maple Walnut", body: "Crunchy, not too sweet." },
      { title: "Cocoa Almond", body: "Cocoa hit. Bold." },
    ]);
    expect(result.snapshot.blog).toEqual([
      { title: "Why we started", body: "We wanted real food." },
      { title: "How we ship", body: "Same day." },
    ]);
    expect(result.snapshot.policies).toEqual({
      privacy: "We respect privacy.",
      refund: "30-day refunds.",
      shipping: "Free over $50.",
    });
    // Footer is now shop.name only — emails are intentionally omitted.
    expect(result.snapshot.footer).toBe("Tiny Goods Co.");
  });

  it("passes the access token in the X-Shopify-Access-Token header on every call", async () => {
    const fetch = buildFetch(ALL_EMPTY_ROUTES);
    await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    const allCalls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const call of allCalls) {
      const init = call[1] as RequestInit | undefined;
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["X-Shopify-Access-Token"]).toBe(TOKEN);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchStorefrontSnapshot — sparse / missing resources
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchStorefrontSnapshot — empty + sparse", () => {
  it("returns empty fields with zero failures when every resource returns empty 200", async () => {
    const fetch = buildFetch(ALL_EMPTY_ROUTES);
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.failures).toEqual([]);
    expect(result.snapshot).toEqual({
      about: "",
      products: [],
      blog: [],
      policies: { privacy: "", refund: "", shipping: "" },
      footer: "",
    });
  });

  it("picks the 'About' page when several heuristic matches are present (heuristic order)", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/pages.json": {
        body: {
          pages: [
            { id: 1, title: "About", body_html: "First" },
            { id: 2, title: "Our story", body_html: "Second" },
          ],
        },
      },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.about).toBe("First");
  });

  it("falls back to titles containing 'about' or 'story' when no exact match", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/pages.json": {
        body: { pages: [{ id: 1, title: "Our brand story", body_html: "Founder copy." }] },
      },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.about).toBe("Founder copy.");
  });

  it("returns empty about when pages exist but none match the heuristic", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/pages.json": {
        body: { pages: [{ id: 1, title: "Contact" }, { id: 2, title: "FAQ" }] },
      },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.about).toBe("");
    expect(result.failures).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchStorefrontSnapshot — failure surfacing (decision 8)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchStorefrontSnapshot — per-resource failure surfacing", () => {
  it("records an `about` failure with status when /pages.json returns 403", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/pages.json": { status: 403, body: { errors: "Access denied" } },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.about).toBe("");
    expect(result.failures).toContainEqual({ resource: "about", reason: "http", status: 403 });
  });

  it("records a `products` failure when /products.json returns 401", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/products.json": { status: 401, body: { errors: "Unauthorized" } },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.failures).toContainEqual({ resource: "products", reason: "http", status: 401 });
  });

  it("records a `policies` failure when /policies.json returns 503 even after retry", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/policies.json": { status: 503, body: { errors: "down" } },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.failures).toContainEqual({ resource: "policies", reason: "http", status: 503 });
  });

  it("records a `footer` failure when /shop.json returns 500", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/shop.json": { status: 500, body: { errors: "boom" } },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.failures.some((f) => f.resource === "footer")).toBe(true);
  });

  it("records all five resources as network failures when fetch globally rejects", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    const resources = result.failures.map((f) => f.resource).sort();
    expect(resources).toEqual(["about", "blog", "footer", "policies", "products"]);
    expect(result.failures.every((f) => f.reason === "network")).toBe(true);
    expect(result.snapshot).toEqual({
      about: "",
      products: [],
      blog: [],
      policies: { privacy: "", refund: "", shipping: "" },
      footer: "",
    });
  });

  it("does NOT record a failure when /blogs.json returns 200 but the merchant has no blogs", async () => {
    const fetch = buildFetch(ALL_EMPTY_ROUTES);
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.failures.some((f) => f.resource === "blog")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchStorefrontSnapshot — retry on 429 / 5xx
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchStorefrontSnapshot — 429/5xx retry", () => {
  it("retries a 429 and succeeds on the second attempt", async () => {
    let pagesCallCount = 0;
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/pages.json": () => {
        pagesCallCount++;
        if (pagesCallCount === 1) {
          return { status: 429, body: { errors: "rate" } };
        }
        return {
          body: { pages: [{ id: 1, title: "About", body_html: "second-try copy" }] },
        };
      },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(pagesCallCount).toBe(2);
    expect(result.snapshot.about).toBe("second-try copy");
    expect(result.failures.some((f) => f.resource === "about")).toBe(false);
  });

  it("does NOT retry a 404 (terminal client error)", async () => {
    let count = 0;
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/pages.json": () => {
        count++;
        return { status: 404, body: {} };
      },
    });
    await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchStorefrontSnapshot — timeout (criterion 9)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchStorefrontSnapshot — timeout", () => {
  it("aborts a never-resolving fetch within timeoutMs and records a timeout failure", async () => {
    // Mock that respects the abort signal — never resolves but rejects when aborted.
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (!signal) return;
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const start = Date.now();
    const result = await fetchStorefrontSnapshot({
      shopDomain: SHOP,
      accessToken: TOKEN,
      fetch,
      timeoutMs: 50,
    });
    const elapsed = Date.now() - start;

    // Two attempts of timeoutMs + jittered backoff between — expect < 5s total.
    expect(elapsed).toBeLessThan(5000);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.every((f) => f.reason === "timeout")).toBe(true);
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchStorefrontSnapshot — limits + ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchStorefrontSnapshot — limits + ordering", () => {
  it("returns at most 5 products even if Shopify returns more, sorted by published_at desc", async () => {
    const products = Array.from({ length: 10 }, (_, i) => ({
      title: `Product ${i}`,
      body_html: `<p>desc ${i}</p>`,
      published_at: new Date(2026, 0, i + 1).toISOString(),
    }));
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/products.json": { body: { products } },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.products).toHaveLength(5);
    // Newest first
    expect(result.snapshot.products[0]?.title).toBe("Product 9");
  });

  it("breaks product ties on title asc when published_at is equal (deterministic hash)", async () => {
    const products = [
      { title: "Beta", body_html: "b", published_at: "2026-04-01T00:00:00Z" },
      { title: "Alpha", body_html: "a", published_at: "2026-04-01T00:00:00Z" },
    ];
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/products.json": { body: { products } },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.products.map((p) => p.title)).toEqual(["Alpha", "Beta"]);
  });

  it("returns at most 3 blog articles total, sorted newest first across blogs in parallel", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/blogs.json": { body: { blogs: [{ id: 1, title: "A" }, { id: 2, title: "B" }] } },
      "/blogs/1/articles.json": {
        body: {
          articles: [
            { id: 11, title: "old", body_html: "old", published_at: "2026-01-01T00:00:00Z" },
            { id: 12, title: "mid", body_html: "mid", published_at: "2026-03-01T00:00:00Z" },
          ],
        },
      },
      "/blogs/2/articles.json": {
        body: {
          articles: [
            { id: 21, title: "newest", body_html: "newest", published_at: "2026-05-01T00:00:00Z" },
            { id: 22, title: "older", body_html: "older", published_at: "2026-02-01T00:00:00Z" },
          ],
        },
      },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.blog).toHaveLength(3);
    expect(result.snapshot.blog[0]?.title).toBe("newest");
    expect(result.snapshot.blog[1]?.title).toBe("mid");
    expect(result.snapshot.blog[2]?.title).toBe("older");
  });

  it("breaks blog article ties deterministically on (blog_id, id, title)", async () => {
    const sameTime = "2026-04-01T00:00:00Z";
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/blogs.json": { body: { blogs: [{ id: 2, title: "Second" }, { id: 1, title: "First" }] } },
      "/blogs/1/articles.json": {
        body: { articles: [{ id: 100, title: "alpha", body_html: "a", published_at: sameTime }] },
      },
      "/blogs/2/articles.json": {
        body: { articles: [{ id: 200, title: "beta", body_html: "b", published_at: sameTime }] },
      },
    });
    const a = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    const b = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(a.snapshot.blog.map((x) => x.title)).toEqual(b.snapshot.blog.map((x) => x.title));
    // blog_id 1 sorts before blog_id 2 (asc tie-breaker)
    expect(a.snapshot.blog[0]?.title).toBe("alpha");
  });

  it("returns a partial blog snapshot when one blog's articles endpoint fails", async () => {
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/blogs.json": { body: { blogs: [{ id: 1, title: "A" }, { id: 2, title: "B" }] } },
      "/blogs/1/articles.json": { status: 500, body: {} },
      "/blogs/2/articles.json": {
        body: { articles: [{ id: 10, title: "ok", body_html: "ok", published_at: "2026-05-01T00:00:00Z" }] },
      },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.blog).toHaveLength(1);
    expect(result.snapshot.blog[0]?.title).toBe("ok");
    // No top-level blog failure when partial success
    expect(result.failures.some((f) => f.resource === "blog")).toBe(false);
  });

  it("truncates long product bodies with an ellipsis", async () => {
    const longBody = "a".repeat(5000);
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/products.json": { body: { products: [{ title: "X", body_html: longBody, published_at: "2026-04-01T00:00:00Z" }] } },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.products[0]?.body.endsWith("…")).toBe(true);
    expect(result.snapshot.products[0]!.body.length).toBeLessThanOrEqual(4001);
  });

  it("truncates a long about body at ABOUT_BODY_MAX_CHARS", async () => {
    const longAbout = "a".repeat(10_000);
    const fetch = buildFetch({
      ...ALL_EMPTY_ROUTES,
      "/pages.json": { body: { pages: [{ id: 1, title: "About", body_html: longAbout }] } },
    });
    const result = await fetchStorefrontSnapshot({ shopDomain: SHOP, accessToken: TOKEN, fetch });
    expect(result.snapshot.about.endsWith("…")).toBe(true);
    expect(result.snapshot.about.length).toBeLessThanOrEqual(8001);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSourceHash — idempotency + determinism
// ─────────────────────────────────────────────────────────────────────────────

describe("computeSourceHash", () => {
  it("returns the same hash for identical snapshots", () => {
    expect(computeSourceHash(snapshot())).toBe(computeSourceHash(snapshot()));
  });

  it("returns a different hash when content changes", () => {
    expect(computeSourceHash(snapshot())).not.toBe(
      computeSourceHash(snapshot({ about: "Different about copy." })),
    );
  });

  it("is order-sensitive for array contents (product reorder => new hash)", () => {
    const base = snapshot({
      products: [
        { title: "A", body: "alpha" },
        { title: "B", body: "beta" },
      ],
    });
    const reordered = snapshot({
      products: [
        { title: "B", body: "beta" },
        { title: "A", body: "alpha" },
      ],
    });
    expect(computeSourceHash(base)).not.toBe(computeSourceHash(reordered));
  });

  it("is independent of object key insertion order", () => {
    const reorderedPolicies: StorefrontSnapshot = {
      footer: "Tiny Goods Co.",
      blog: [{ title: "Year One", body: "What we learned." }],
      about: "We make small-batch granola in Brooklyn.",
      products: [{ title: "Maple Walnut", body: "Crunchy, not too sweet." }],
      policies: {
        shipping: "Free over $50",
        privacy: "",
        refund: "30 days",
      },
    };
    expect(computeSourceHash(snapshot())).toBe(computeSourceHash(reorderedPolicies));
  });

  it("produces a 64-character lowercase hex string", () => {
    expect(computeSourceHash(snapshot())).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchStorefrontSnapshot — idempotency claim (decision 8)
// ─────────────────────────────────────────────────────────────────────────────

describe("fetchStorefrontSnapshot — idempotency", () => {
  it("returns identical snapshots + identical hashes when called twice with the same Shopify state", async () => {
    const routes = {
      ...ALL_EMPTY_ROUTES,
      "/pages.json": {
        body: { pages: [{ id: 1, title: "About", body_html: "<p>copy</p>" }] },
      },
      "/products.json": {
        body: { products: [{ title: "P", body_html: "<p>desc</p>", published_at: "2026-04-01T00:00:00Z" }] },
      },
      "/shop.json": { body: { shop: { name: "S" } } },
    };
    const a = await fetchStorefrontSnapshot({
      shopDomain: SHOP, accessToken: TOKEN, fetch: buildFetch(routes),
    });
    const b = await fetchStorefrontSnapshot({
      shopDomain: SHOP, accessToken: TOKEN, fetch: buildFetch(routes),
    });
    expect(a.snapshot).toEqual(b.snapshot);
    expect(computeSourceHash(a.snapshot)).toBe(computeSourceHash(b.snapshot));
  });
});
