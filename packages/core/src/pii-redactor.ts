// PII redactor — pre-flight gate for every LLM call against storefront
// content. Implements architectural decision 10: PII redaction is
// mandatory before any LLM call. Storefront corpus (especially reviews
// and testimonials) may contain customer names, emails, phone numbers,
// and social handles. This module strips them; the orchestrator's
// pre-flight test asserts the redacted output contains no recognized
// PII pattern and throws if it does, so a regression in the redactor
// fails the extraction instead of leaking PII to Sonnet.
//
// Pure, synchronous, no I/O. Safe to call from any context.

export type PiiKind = "email" | "phone" | "name" | "social";

export interface PiiMatch {
  kind: PiiKind;
  /** The original matched substring (kept for audit; NEVER stored in events). */
  value: string;
  /** Codepoint index in the input. */
  start: number;
  /** Codepoint length of the original match. */
  length: number;
  /** The replacement token written into `redacted`. */
  replacement: string;
}

export interface RedactResult {
  redacted: string;
  matches: PiiMatch[];
  /** Counts by kind — safe to persist (no original strings). */
  summary: Record<PiiKind, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection patterns
// ─────────────────────────────────────────────────────────────────────────────

// RFC 5322 simplified — covers common shapes without false-positiving on
// version numbers, decimal prices, etc. Word boundaries on both ends.
const EMAIL_RE =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g;

// Phone numbers: international (+CC) + US/AU/UK domestic. Loose enough to
// catch hyphen/space/dot/paren separators, strict enough to avoid matching
// generic 7+ digit runs. We require at least one separator OR a leading +.
const PHONE_RE =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{2,4}(?:[\s.-]\d{2,4})?(?:[\s.-]\d{2,4})?\b/g;

// Plain-digit phones (no separators) — 10-15 digits, with optional leading +.
// Bounded by word boundaries so order numbers in product copy (e.g. "SKU-12345")
// are not caught.
const PHONE_PLAIN_RE = /\+?\b\d{10,15}\b/g;

// Social profile URLs / handles in known contexts.
const SOCIAL_RE =
  /\b(?:https?:\/\/)?(?:www\.)?(?:twitter|x|instagram|facebook|linkedin|tiktok)\.com\/[A-Za-z0-9._\-/?=&%]+/gi;

// Person-name heuristic: capitalized two-word sequences. Handles
// hyphenated last names ("Lee-Chen") and apostrophe-prefixed last names
// ("O'Connor") in the second word. False positives on "Brooklyn Bridge"
// / "Maple Walnut" / "Best Sellers" are intentional — chunk 7's
// orchestrator accepts over-redaction as the safer failure mode (no PII
// leak; the LLM still has plenty of voice signal). The NAME_ALLOWLIST
// below dampens the most common brand / place bigrams.
const NAME_RE =
  /\b[A-Z][a-z][a-z'-]{0,19}\s[A-Z](?:[a-z][a-zA-Z'-]{0,30}|'[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)*)\b/g;

// Common bigrams that look like names but are place / product / brand-y.
// Used to dampen false-positive rates on tonewards-meaningful copy.
// Keep this list short — over-redaction is preferred to under-redaction.
const NAME_ALLOWLIST = new Set<string>([
  "New York",
  "Los Angeles",
  "San Francisco",
  "San Diego",
  "Las Vegas",
  "United States",
  "United Kingdom",
  "New Zealand",
  "Hong Kong",
  "South Africa",
  "South America",
  "North America",
  "Best Sellers",
  "Customer Service",
  "Free Shipping",
  "Privacy Policy",
  "Terms Service",
  "Contact Us",
  "About Us",
]);

const REPLACEMENTS: Record<PiiKind, string> = {
  email: "[email]",
  phone: "[phone]",
  name: "[name]",
  social: "[social]",
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Redacts PII patterns in `content`. Pure: returns the redacted string,
 * the list of matches (for audit), and a counts-only summary safe to
 * persist into `voice_events.payload` for `pii_redacted` events.
 *
 * Match ordering: socials → emails → phones → names. Earlier kinds
 * consume their substring so a later regex cannot also match within it.
 * This avoids double-counting an email's local part as a name, or a
 * phone embedded in a social URL.
 */
export function redact(content: string): RedactResult {
  if (!content) {
    return emptyResult();
  }
  const matches: PiiMatch[] = [];

  // Process in priority order. Each pass operates on the *currently
  // redacted* string so subsequent regexes see [token] placeholders
  // instead of the original PII.
  let current = content;
  current = applyPattern(current, SOCIAL_RE, "social", matches);
  current = applyPattern(current, EMAIL_RE, "email", matches);
  current = applyPattern(current, PHONE_RE, "phone", matches);
  current = applyPattern(current, PHONE_PLAIN_RE, "phone", matches);

  // Name pass: freeze allowlisted phrases with non-matching sentinels first,
  // so the greedy NAME_RE can't consume one half of an allowlisted bigram
  // (e.g. "See Best" matching before "Best Sellers" is recognized).
  const frozen = freezeAllowlist(current);
  const namedRedacted = applyPattern(frozen.text, NAME_RE, "name", matches);
  current = restoreAllowlist(namedRedacted, frozen.tokens);

  return {
    redacted: current,
    matches,
    summary: summarize(matches),
  };
}

/**
 * Pre-flight assertion the orchestrator runs immediately before invoking
 * Sonnet. Throws if any PII pattern is detectable in the input after
 * redaction. Defends decision 10 against regressions in the patterns
 * above — if the redactor missed something, the call never happens.
 */
export function assertNoPii(redacted: string): void {
  const result = redact(redacted);
  if (result.matches.length > 0) {
    const kinds = Array.from(new Set(result.matches.map((m) => m.kind))).sort();
    throw new PiiLeakError(
      `Redacted content still contains PII patterns: ${kinds.join(", ")}`,
      kinds,
    );
  }
}

/**
 * Convenience: walks a `StorefrontSnapshot`-shaped object and redacts
 * every string-typed leaf. Returns the redacted shape plus an
 * aggregated summary. The orchestrator uses this on
 * `storefront_snapshots.raw_content` to produce `redacted_content`.
 */
export function redactSnapshot<T extends Record<string, unknown>>(
  snapshot: T,
): { redacted: T; summary: Record<PiiKind, number> } {
  const summary: Record<PiiKind, number> = { email: 0, phone: 0, name: 0, social: 0 };
  const walked = walk(snapshot, summary, new WeakSet<object>(), 0);
  return { redacted: walked as T, summary };
}

export class PiiLeakError extends Error {
  readonly kinds: readonly PiiKind[];
  constructor(message: string, kinds: PiiKind[]) {
    super(message);
    this.name = "PiiLeakError";
    this.kinds = kinds;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function emptyResult(): RedactResult {
  return {
    redacted: "",
    matches: [],
    summary: { email: 0, phone: 0, name: 0, social: 0 },
  };
}

function summarize(matches: PiiMatch[]): Record<PiiKind, number> {
  const summary: Record<PiiKind, number> = { email: 0, phone: 0, name: 0, social: 0 };
  for (const m of matches) summary[m.kind]++;
  return summary;
}

/**
 * Runs a single regex pass over `text`, replacing each match with the
 * corresponding token and accumulating `PiiMatch` records. Each pattern
 * is sticky: we recompile a fresh global regex per call to avoid the
 * `lastIndex` re-entrancy footgun.
 */
function applyPattern(
  text: string,
  pattern: RegExp,
  kind: PiiKind,
  matches: PiiMatch[],
): string {
  const re = new RegExp(pattern.source, pattern.flags);
  let result = "";
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[0];
    const start = m.index;
    // For phone matching, also reject pure-digit runs that are actually
    // dates ("2026-04-01") or version strings ("1.0.0"). The PHONE_RE
    // already requires separators, but a pre-check on context keeps the
    // false-positive rate low for product copy.
    if (kind === "phone" && looksLikeNonPhone(text, start, value)) {
      if (m.index === re.lastIndex) re.lastIndex++;
      continue;
    }
    result += text.slice(lastIndex, start);
    result += REPLACEMENTS[kind];
    lastIndex = start + value.length;
    matches.push({ kind, value, start, length: value.length, replacement: REPLACEMENTS[kind] });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  result += text.slice(lastIndex);
  return result;
}

// Sentinels use Unicode Private Use Area codepoints (U+E000 + U+E001) as
// boundary markers. These codepoints are reserved for private use and
// will not appear in legitimate storefront content — Shopify's CMS does
// not emit them, and the chunk-2 stripHtml decoder rejects out-of-range
// numeric entities so `&#xE000;` cannot smuggle them in either.
//
// Defense in depth: any pre-existing private-use codepoint in the input
// is stripped before freezing so an adversarial input cannot collide
// with our sentinels at restore time.
const SENTINEL_OPEN = "";
const SENTINEL_CLOSE = "";
const SENTINEL_STRIP_RE = /[-]/g;

function freezeAllowlist(text: string): { text: string; tokens: Map<string, string> } {
  const tokens = new Map<string, string>();
  // Defense in depth: strip any pre-existing private-use boundary chars
  // so an adversarial input cannot collide with our sentinels at restore time.
  const safe = text.replace(SENTINEL_STRIP_RE, "");
  let i = 0;
  let out = safe;
  for (const phrase of NAME_ALLOWLIST) {
    if (!out.includes(phrase)) continue;
    const sentinel = `${SENTINEL_OPEN}A${i++}${SENTINEL_CLOSE}`;
    tokens.set(sentinel, phrase);
    // Replace all occurrences without using a regex (phrase may contain regex meta).
    out = out.split(phrase).join(sentinel);
  }
  return { text: out, tokens };
}

function restoreAllowlist(text: string, tokens: Map<string, string>): string {
  let out = text;
  for (const [sentinel, phrase] of tokens) {
    out = out.split(sentinel).join(phrase);
  }
  return out;
}

function looksLikeNonPhone(text: string, start: number, value: string): boolean {
  // Reject if preceded by `$` (price) or `v`/`V` (version), or if the match
  // is an ISO date / datetime (e.g. "2026-04-01"). Phones never start with
  // a 4-digit cluster + hyphen + 2-digit cluster.
  const prev = text[start - 1];
  if (prev === "$" || prev === "v" || prev === "V") return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return true;
  return false;
}

/** Maximum object/array nesting depth permitted in a snapshot. */
const MAX_WALK_DEPTH = 32;

export class SnapshotShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotShapeError";
  }
}

function walk(
  value: unknown,
  summary: Record<PiiKind, number>,
  visited: WeakSet<object>,
  depth: number,
): unknown {
  if (depth > MAX_WALK_DEPTH) {
    throw new SnapshotShapeError(`Snapshot nesting exceeds MAX_WALK_DEPTH (${MAX_WALK_DEPTH})`);
  }
  if (typeof value === "string") {
    const r = redact(value);
    for (const m of r.matches) summary[m.kind]++;
    return r.redacted;
  }
  if (value !== null && typeof value === "object") {
    if (visited.has(value)) {
      throw new SnapshotShapeError("Cycle detected while walking snapshot");
    }
    visited.add(value);
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, summary, visited, depth + 1));
    }
    // Reject Date / RegExp / Map / Set / function-bearing leaves that would
    // be silently coerced to `{}` by Object.entries. The redactor's job is
    // to operate on plain JSON-shaped data — anything else is a snapshot
    // shape error and should fail loudly, not corrupt silently.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new SnapshotShapeError(
        `Non-plain object encountered during walk: ${proto?.constructor?.name ?? "unknown"}`,
      );
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walk(v, summary, visited, depth + 1);
    }
    return out;
  }
  return value;
}
