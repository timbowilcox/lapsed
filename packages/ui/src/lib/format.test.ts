import { describe, expect, it } from "vitest";
import { formatCount, formatCurrency, formatDate, formatDateTime, formatRelativeTime } from "./format";

// ─── formatCount ─────────────────────────────────────────────────────────────

describe("formatCount", () => {
  it("formats an integer with thousands separator", () => {
    expect(formatCount(2847)).toBe("2,847");
  });

  it("formats zero", () => {
    expect(formatCount(0)).toBe("0");
  });

  it("formats a large number", () => {
    expect(formatCount(25000)).toBe("25,000");
  });

  it("formats a small number without separator", () => {
    expect(formatCount(999)).toBe("999");
  });
});

// ─── formatCurrency ───────────────────────────────────────────────────────────

describe("formatCurrency", () => {
  it("formats whole dollars with no decimal places", () => {
    expect(formatCurrency(4728300)).toBe("$47,283");
  });

  it("formats cents with two decimal places", () => {
    expect(formatCurrency(4728350)).toBe("$47,283.50");
  });

  it("formats zero", () => {
    expect(formatCurrency(0)).toBe("$0");
  });

  it("formats small amounts", () => {
    expect(formatCurrency(99)).toBe("$0.99");
  });

  it("formats exactly 1 cent", () => {
    expect(formatCurrency(1)).toBe("$0.01");
  });

  it("includes thousands separator", () => {
    expect(formatCurrency(100000000)).toBe("$1,000,000");
  });

  it("respects locale override", () => {
    // In en-GB, currency symbol placement may differ but value should be present
    const result = formatCurrency(10000, { locale: "en-GB", currency: "GBP" });
    expect(result).toContain("10");
  });

  it("respects currency override", () => {
    expect(formatCurrency(10000, { currency: "EUR" })).toContain("100");
  });
});

// ─── formatDate ──────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("formats short date", () => {
    expect(formatDate("2026-05-05", "short")).toBe("5 May 2026");
  });

  it("formats long date with weekday", () => {
    expect(formatDate("2026-05-05", "long")).toBe("Tuesday, 5 May 2026");
  });

  it("formats iso date", () => {
    expect(formatDate("2026-05-05", "iso")).toBe("2026-05-05");
  });

  it("formats iso from Date object", () => {
    expect(formatDate(new Date("2026-01-01T00:00:00Z"), "iso")).toBe(
      "2026-01-01",
    );
  });

  it("accepts Date objects for short format", () => {
    const d = new Date("2026-12-25T12:00:00Z");
    const result = formatDate(d, "short");
    expect(result).toContain("25");
    expect(result).toContain("December");
    expect(result).toContain("2026");
  });

  it("pads single-digit months and days in iso format", () => {
    expect(formatDate("2026-01-09", "iso")).toBe("2026-01-09");
  });
});

// ─── formatDateTime ──────────────────────────────────────────────────────────

describe("formatDateTime", () => {
  it("formats a UTC date-time string", () => {
    const result = formatDateTime("2026-05-14T03:24:00Z");
    // Should contain day, month abbreviation, year, and time
    expect(result).toMatch(/14/);
    expect(result).toMatch(/May/);
    expect(result).toMatch(/2026/);
    expect(result).toMatch(/3:24/);
  });

  it("accepts a Date object and includes date + time components", () => {
    const d = new Date("2026-01-09T00:00:00Z");
    const result = formatDateTime(d);
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/2026/);
    // Should contain a time component like "0:00" or "10:00" etc.
    expect(result).toMatch(/\d+:\d{2}/);
  });
});

// ─── formatRelativeTime ───────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  const now = new Date("2026-05-14T12:00:00Z");

  it("returns '1m' for < 1 minute ago", () => {
    const d = new Date(now.getTime() - 30_000);
    expect(formatRelativeTime(d, now)).toBe("1m");
  });

  it("returns minutes for < 60 minutes ago", () => {
    const d = new Date(now.getTime() - 15 * 60_000);
    expect(formatRelativeTime(d, now)).toBe("15m");
  });

  it("returns '59m' at boundary just under an hour", () => {
    const d = new Date(now.getTime() - 59 * 60_000);
    expect(formatRelativeTime(d, now)).toBe("59m");
  });

  it("returns hours for < 24 hours ago", () => {
    const d = new Date(now.getTime() - 3 * 60 * 60_000);
    expect(formatRelativeTime(d, now)).toBe("3h");
  });

  it("returns '1h' at the 1-hour boundary", () => {
    const d = new Date(now.getTime() - 60 * 60_000);
    expect(formatRelativeTime(d, now)).toBe("1h");
  });

  it("returns '23h' at boundary just under a day", () => {
    const d = new Date(now.getTime() - 23 * 60 * 60_000);
    expect(formatRelativeTime(d, now)).toBe("23h");
  });

  it("returns 'yesterday' for exactly 1 day ago", () => {
    const d = new Date(now.getTime() - 26 * 60 * 60_000);
    expect(formatRelativeTime(d, now)).toBe("yesterday");
  });

  it("returns days for 2–6 days ago", () => {
    const d = new Date(now.getTime() - 3 * 24 * 60 * 60_000);
    expect(formatRelativeTime(d, now)).toBe("3d");
  });

  it("returns '6d' at boundary", () => {
    const d = new Date(now.getTime() - 6 * 24 * 60 * 60_000);
    expect(formatRelativeTime(d, now)).toBe("6d");
  });

  it("returns short date string for >= 7 days ago", () => {
    const d = new Date(now.getTime() - 10 * 24 * 60 * 60_000);
    const result = formatRelativeTime(d, now);
    // Should be a date string like "Mon 4 May" or similar
    expect(result).toMatch(/\w+\s+\d+\s+\w+/);
  });

  it("accepts string input", () => {
    const result = formatRelativeTime("2026-05-14T11:45:00Z", now);
    expect(result).toBe("15m");
  });
});
