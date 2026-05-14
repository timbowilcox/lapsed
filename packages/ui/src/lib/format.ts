/**
 * Formats a plain integer/decimal with thousands separators (no currency symbol).
 *
 * @example formatCount(2847)  → "2,847"
 * @example formatCount(25000) → "25,000"
 */
export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/**
 * Formats a date+time value as a compact string.
 *
 * @example formatDateTime("2026-05-14T03:24:00Z") → "14 May 2026, 3:24 am"
 */
export function formatDateTime(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface CurrencyOptions {
  locale?: string;
  currency?: string;
}

/**
 * Formats a cent value as a currency string.
 * Omits decimal places when the amount is a whole number of dollars.
 *
 * @example formatCurrency(4728300) → "$47,283"
 * @example formatCurrency(4728350) → "$47,283.50"
 */
export function formatCurrency(
  cents: number,
  { locale = "en-US", currency = "USD" }: CurrencyOptions = {},
): string {
  const dollars = cents / 100;
  const hasDecimals = cents % 100 !== 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: hasDecimals ? 2 : 0,
  }).format(dollars);
}

export type DateFormat = "short" | "long" | "iso";

/**
 * Formats a date value.
 *
 * @example formatDate("2026-05-05", "short")  → "5 May 2026"
 * @example formatDate("2026-05-05", "long")   → "Tuesday, 5 May 2026"
 * @example formatDate("2026-05-05", "iso")    → "2026-05-05"
 */
export function formatDate(input: string | Date, format: DateFormat): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (format === "iso") {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  if (format === "long") {
    return d.toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  // short: "5 May 2026"
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Formats a date as a relative time string.
 *
 * Rules (from current moment):
 *   < 60s      → "Xm" (treated as < 1m → "1m")
 *   < 60m      → "Xm"
 *   < 24h      → "Xh"
 *   yesterday  → "yesterday"
 *   ≤ 6 days   → "Xd"
 *   ≥ 7 days   → formatDate(input, "short") e.g. "Mon 5 May"
 *
 * Note: "now" is injected via the optional second parameter to keep tests deterministic.
 */
export function formatRelativeTime(
  input: string | Date,
  _now: Date = new Date(),
): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const diffMs = _now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) return "1m";
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHour < 24) return `${diffHour}h`;
  if (diffDay === 1) return "yesterday";
  if (diffDay <= 6) return `${diffDay}d`;

  // ≥ 7 days: "Mon 5 May" (day-of-week abbreviated + day + month)
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
}
