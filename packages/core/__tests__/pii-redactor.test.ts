import { describe, expect, it } from "vitest";
import {
  redact,
  redactSnapshot,
  assertNoPii,
  PiiLeakError,
  SnapshotShapeError,
} from "../src/pii-redactor";

// ─────────────────────────────────────────────────────────────────────────────
// Email detection
// ─────────────────────────────────────────────────────────────────────────────

describe("redact — email", () => {
  it("redacts a standard email", () => {
    expect(redact("Contact us at hello@example.com today.").redacted).toBe(
      "Contact us at [email] today.",
    );
  });

  it("redacts emails with plus addressing", () => {
    expect(redact("orders+test@brand.co").redacted).toBe("[email]");
  });

  it("redacts emails with subdomains", () => {
    expect(redact("info@mail.support.brand.com").redacted).toBe("[email]");
  });

  it("redacts emails with hyphenated domain", () => {
    expect(redact("hi@brand-name.com").redacted).toBe("[email]");
  });

  it("redacts emails with dotted local parts", () => {
    expect(redact("jane.doe@example.com").redacted).toBe("[email]");
  });

  it("redacts emails inside punctuation", () => {
    expect(redact("Email: <hello@brand.co>.").redacted).toBe("Email: <[email]>.");
  });

  it("redacts multiple emails", () => {
    const r = redact("a@x.com and b@y.com");
    expect(r.redacted).toBe("[email] and [email]");
    expect(r.summary.email).toBe(2);
  });

  it("does NOT redact a string with no @", () => {
    expect(redact("This is just text.").redacted).toBe("This is just text.");
  });

  it("does NOT match the email portion as a name when both are present", () => {
    // Email runs first, so the local part is consumed before the name pass.
    const r = redact("Hi from John Smith — jsmith@brand.com");
    expect(r.redacted).toBe("Hi from [name] — [email]");
    expect(r.summary.email).toBe(1);
    expect(r.summary.name).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phone detection
// ─────────────────────────────────────────────────────────────────────────────

describe("redact — phone", () => {
  it("redacts US phone with dashes", () => {
    expect(redact("Call 415-555-1212 for help.").redacted).toBe("Call [phone] for help.");
  });

  it("redacts US phone with parentheses", () => {
    expect(redact("(415) 555-1212").redacted).toBe("[phone]");
  });

  it("redacts US phone with dots", () => {
    expect(redact("415.555.1212").redacted).toBe("[phone]");
  });

  it("redacts international phone with country code", () => {
    expect(redact("+44 20 7946 0958").redacted).toBe("[phone]");
  });

  it("redacts AU phone", () => {
    expect(redact("+61 408 768 484").redacted).toBe("[phone]");
  });

  it("redacts plain-digit international phone (no separators, leading +)", () => {
    expect(redact("+61408768484").redacted).toBe("[phone]");
  });

  it("redacts a 10-digit US phone with no separators", () => {
    expect(redact("4155551212").redacted).toBe("[phone]");
  });

  it("does NOT redact a price like $4.99", () => {
    expect(redact("Get yours for $4.99 today.").redacted).toBe("Get yours for $4.99 today.");
  });

  it("does NOT redact a version like v1.0.0", () => {
    expect(redact("Update to v1.0.0 now.").redacted).toBe("Update to v1.0.0 now.");
  });

  it("does NOT redact an ISO date 2026-04-01", () => {
    expect(redact("Posted 2026-04-01 on the blog.").redacted).toBe("Posted 2026-04-01 on the blog.");
  });

  it("does NOT redact a short order number like 12345", () => {
    expect(redact("Order 12345 is ready.").redacted).toBe("Order 12345 is ready.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Social URL detection
// ─────────────────────────────────────────────────────────────────────────────

describe("redact — social", () => {
  it("redacts a twitter.com handle URL", () => {
    expect(redact("Follow us on https://twitter.com/brandname").redacted).toBe(
      "Follow us on [social]",
    );
  });

  it("redacts instagram.com URL", () => {
    expect(redact("https://www.instagram.com/brand_name").redacted).toBe("[social]");
  });

  it("redacts facebook.com URL", () => {
    expect(redact("facebook.com/brandpage").redacted).toBe("[social]");
  });

  it("redacts linkedin.com URL", () => {
    expect(redact("https://linkedin.com/company/brand").redacted).toBe("[social]");
  });

  it("redacts x.com URL", () => {
    expect(redact("x.com/founder").redacted).toBe("[social]");
  });

  it("redacts multiple social URLs in one string", () => {
    const r = redact("twitter.com/a and instagram.com/b");
    expect(r.redacted).toBe("[social] and [social]");
    expect(r.summary.social).toBe(2);
  });

  it("does NOT redact a non-social URL", () => {
    expect(redact("Visit our blog at brand.com/journal").redacted).toBe(
      "Visit our blog at brand.com/journal",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Person-name detection
// ─────────────────────────────────────────────────────────────────────────────

describe("redact — person names", () => {
  it("redacts a capitalized two-word sequence", () => {
    expect(redact("Founded by Jane Doe in 2020.").redacted).toBe("Founded by [name] in 2020.");
  });

  it("redacts hyphenated last names", () => {
    expect(redact("Sarah Lee-Chen runs ops.").redacted).toBe("[name] runs ops.");
  });

  it("redacts O'-style last names", () => {
    expect(redact("Patrick O'Connor signed off.").redacted).toBe("[name] signed off.");
  });

  it("does NOT redact allowlisted city pairs (New York)", () => {
    expect(redact("Made in New York since 2018.").redacted).toBe(
      "Made in New York since 2018.",
    );
  });

  it("does NOT redact allowlisted brandy pairs (Best Sellers)", () => {
    expect(redact("See Best Sellers on the homepage.").redacted).toBe(
      "See Best Sellers on the homepage.",
    );
  });

  it("does NOT redact a single capitalized word", () => {
    expect(redact("Welcome to Brooklyn.").redacted).toBe("Welcome to Brooklyn.");
  });

  it("accepts that brand-y bigrams may over-redact (intentional safety bias)", () => {
    // 'Maple Walnut' will be redacted — this is intentional over-redaction,
    // documented in the source. The voice extractor receives plenty of
    // context even with over-redaction; the cost of a leak is higher than
    // the cost of an extra [name] token.
    expect(redact("Try our Maple Walnut granola.").redacted).toBe(
      "Try our [name] granola.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined / overlapping patterns
// ─────────────────────────────────────────────────────────────────────────────

describe("redact — combined patterns", () => {
  it("redacts every kind in one string", () => {
    const input = "Hi from Jane Doe, email jane@brand.co or call 415-555-1212. Instagram: instagram.com/jane";
    const r = redact(input);
    expect(r.redacted).not.toMatch(/jane@brand\.co/);
    expect(r.redacted).not.toMatch(/415-555-1212/);
    expect(r.redacted).not.toMatch(/instagram\.com\/jane/);
    expect(r.redacted).not.toMatch(/Jane Doe/);
    expect(r.summary.email).toBe(1);
    expect(r.summary.phone).toBe(1);
    expect(r.summary.social).toBe(1);
    expect(r.summary.name).toBeGreaterThanOrEqual(1);
  });

  it("does NOT redact phone digits hiding inside an already-redacted email", () => {
    // The email pass runs before phone — once "user1234567890@x.com" becomes
    // "[email]", the phone regex sees [email] and finds nothing to match.
    const r = redact("Reach user1234567890@x.com today");
    expect(r.summary.email).toBe(1);
    expect(r.summary.phone).toBe(0);
  });

  it("preserves leading and trailing context around matches", () => {
    expect(redact("=== Contact: hi@x.co ===").redacted).toBe("=== Contact: [email] ===");
  });

  it("returns empty result for empty input", () => {
    const r = redact("");
    expect(r.redacted).toBe("");
    expect(r.matches).toEqual([]);
    expect(r.summary).toEqual({ email: 0, phone: 0, name: 0, social: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PiiMatch metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("redact — match metadata", () => {
  it("records the kind, value, and replacement for each match", () => {
    const r = redact("Email a@b.com please");
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.kind).toBe("email");
    expect(r.matches[0]?.value).toBe("a@b.com");
    expect(r.matches[0]?.replacement).toBe("[email]");
  });

  it("orders matches by kind priority (social, email, phone, name)", () => {
    const r = redact("Jane Doe jane@x.com 415-555-1212 instagram.com/jane");
    const kinds = r.matches.map((m) => m.kind);
    // Social runs first, then email, then phone, then name
    expect(kinds.indexOf("social")).toBeLessThan(kinds.indexOf("email"));
    expect(kinds.indexOf("email")).toBeLessThan(kinds.indexOf("phone"));
    expect(kinds.indexOf("phone")).toBeLessThan(kinds.indexOf("name"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertNoPii — pre-flight gate (decision 10)
// ─────────────────────────────────────────────────────────────────────────────

describe("assertNoPii", () => {
  it("returns silently for clean input", () => {
    expect(() => assertNoPii("This text has no PII.")).not.toThrow();
  });

  it("returns silently when input is already redacted", () => {
    expect(() => assertNoPii("Contact [email] or call [phone].")).not.toThrow();
  });

  it("throws PiiLeakError when an unredacted email is present", () => {
    expect(() => assertNoPii("Leaked: hi@brand.co")).toThrow(PiiLeakError);
  });

  it("throws PiiLeakError when an unredacted phone is present", () => {
    expect(() => assertNoPii("Leaked: 415-555-1212")).toThrow(PiiLeakError);
  });

  it("the thrown error exposes the leaked kinds in sorted order", () => {
    try {
      assertNoPii("Hi Jane Doe at jane@x.com call 415-555-1212");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PiiLeakError);
      expect((err as PiiLeakError).kinds).toEqual(["email", "name", "phone"]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// redactSnapshot — walks a StorefrontSnapshot-like object
// ─────────────────────────────────────────────────────────────────────────────

describe("redactSnapshot", () => {
  it("redacts string leaves inside nested objects and arrays", () => {
    const snap = {
      about: "Founded by Jane Doe in Brooklyn.",
      products: [
        { title: "Maple Walnut", body: "Crunchy. Email feedback to hi@brand.co" },
        { title: "Cocoa", body: "415-555-1212 for orders" },
      ],
      blog: [{ title: "Why we started", body: "instagram.com/journal" }],
      policies: { privacy: "", refund: "30 days", shipping: "" },
      footer: "Brand Co.",
    };
    const out = redactSnapshot(snap);
    expect(out.redacted.about).toMatch(/\[name\]/);
    expect(out.redacted.products[0]!.body).toMatch(/\[email\]/);
    expect(out.redacted.products[1]!.body).toMatch(/\[phone\]/);
    expect(out.redacted.blog[0]!.body).toMatch(/\[social\]/);
    expect(out.summary.email).toBe(1);
    expect(out.summary.phone).toBe(1);
    expect(out.summary.social).toBe(1);
    expect(out.summary.name).toBeGreaterThan(0);
  });

  it("preserves non-string leaves (numbers, booleans, null)", () => {
    const snap = { count: 42, ok: true, missing: null };
    const out = redactSnapshot(snap);
    expect(out.redacted.count).toBe(42);
    expect(out.redacted.ok).toBe(true);
    expect(out.redacted.missing).toBeNull();
  });

  it("returns a zero summary for snapshots with truly no PII", () => {
    const out = redactSnapshot({
      about: "We make granola.",
      footer: "brand co",
    });
    expect(out.summary).toEqual({ email: 0, phone: 0, name: 0, social: 0 });
  });

  it("redactSnapshot output passes assertNoPii", () => {
    const snap = {
      about: "Founded by Jane Doe.",
      products: [{ title: "Cocoa", body: "Email orders@brand.co" }],
      blog: [{ title: "x", body: "415-555-1212" }],
      policies: { privacy: "", refund: "", shipping: "" },
      footer: "instagram.com/brand",
    };
    const out = redactSnapshot(snap);
    expect(() => assertNoPii(JSON.stringify(out.redacted))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Architectural decision 10 — event-payload safety
// ─────────────────────────────────────────────────────────────────────────────

describe("decision 10 — pii_redacted event payload is safe", () => {
  it("the summary contains no PII strings — only counts", () => {
    const r = redact("Email jane@brand.co or call 415-555-1212");
    // summary is what gets persisted in voice_events.payload for `pii_redacted`.
    // It must be plain numbers, never strings.
    for (const [, count] of Object.entries(r.summary)) {
      expect(typeof count).toBe("number");
    }
    // Serializing summary as JSON must contain no PII patterns.
    const serialized = JSON.stringify(r.summary);
    expect(serialized).not.toMatch(/jane@brand\.co/);
    expect(serialized).not.toMatch(/415-555-1212/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allowlist sentinel safety (was a High finding pre-amend)
// ─────────────────────────────────────────────────────────────────────────────

const PUA_OPEN = String.fromCharCode(0xe000);
const PUA_CLOSE = String.fromCharCode(0xe001);

describe("freezeAllowlist / restoreAllowlist sentinel safety", () => {
  it("strips adversarial private-use codepoints from input before freezing", () => {
    // If the input claims to contain our sentinel boundary chars, they must
    // be erased so restoreAllowlist cannot rewrite them with allowlisted phrases.
    const adversarial = `Made in New York at ${PUA_OPEN}A0${PUA_CLOSE} place`;
    const r = redact(adversarial);
    // The literal PUA chars must not survive in output.
    expect(r.redacted.includes(PUA_OPEN)).toBe(false);
    expect(r.redacted.includes(PUA_CLOSE)).toBe(false);
    // "New York" is allowlisted so it must still be present after round-trip.
    expect(r.redacted).toContain("New York");
  });

  it("round-trips multiple distinct allowlisted phrases in one string", () => {
    const r = redact("Made in New York with our Best Sellers list.");
    expect(r.redacted).toBe("Made in New York with our Best Sellers list.");
    expect(r.summary.name).toBe(0);
  });

  it("round-trips multiple occurrences of the same allowlisted phrase", () => {
    const r = redact("New York then New York again");
    expect(r.redacted).toBe("New York then New York again");
    expect(r.summary.name).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// redactSnapshot — cycle + depth + non-plain-object guards (High fix)
// ─────────────────────────────────────────────────────────────────────────────

describe("redactSnapshot — defensive guards", () => {
  it("throws SnapshotShapeError on a self-referential object", () => {
    const cyclic: Record<string, unknown> = { about: "We make granola." };
    cyclic.self = cyclic;
    expect(() => redactSnapshot(cyclic)).toThrow(SnapshotShapeError);
  });

  it("throws SnapshotShapeError when nesting exceeds MAX_WALK_DEPTH", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => redactSnapshot(deep)).toThrow(SnapshotShapeError);
  });

  it("throws SnapshotShapeError when a Date leaf is encountered", () => {
    const snap = { when: new Date("2026-05-15") } as unknown as Record<string, unknown>;
    expect(() => redactSnapshot(snap)).toThrow(SnapshotShapeError);
  });

  it("throws SnapshotShapeError when a Map leaf is encountered", () => {
    const snap = { m: new Map() } as unknown as Record<string, unknown>;
    expect(() => redactSnapshot(snap)).toThrow(SnapshotShapeError);
  });

  it("does NOT throw on a normal nested snapshot up to 31 levels", () => {
    let deep: Record<string, unknown> = { leaf: "We make granola." };
    for (let i = 0; i < 30; i++) deep = { next: deep };
    expect(() => redactSnapshot(deep)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error class shape
// ─────────────────────────────────────────────────────────────────────────────

describe("Error classes", () => {
  it("PiiLeakError has the expected name property", () => {
    try {
      assertNoPii("hi@example.com");
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).name).toBe("PiiLeakError");
    }
  });

  it("SnapshotShapeError has the expected name property", () => {
    const cyclic: Record<string, unknown> = { x: 1 };
    cyclic.self = cyclic;
    try {
      redactSnapshot(cyclic);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).name).toBe("SnapshotShapeError");
    }
  });
});
