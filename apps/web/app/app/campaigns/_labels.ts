// Human-readable labels for the campaign taxonomies. Shared by the approval
// surface (chunk 9), the campaign list (chunk 10), and the bandit inspector
// (chunk 11). All copy here is merchant-facing — "group" vocabulary only,
// never "cohort"/"segment"/"audience".

/** Title-cases an unknown enum value as a fallback (e.g. "down_to_earth" → "Down to earth"). */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const GROUP_LABELS: Record<string, string> = {
  lapsed_vips: "Lapsed VIPs",
  at_risk_regulars: "At-risk regulars",
  single_purchase_converters: "Single-purchase converters",
  price_sensitive_lapsed: "Price-sensitive lapsed buyers",
  recent_first_purchasers: "Recent first-time buyers",
  win_backs_at_risk: "Win-backs going quiet",
};

const OFFER_TYPE_LABELS: Record<string, string> = {
  percent_discount: "Percentage discount",
  fixed_amount_discount: "Fixed-amount discount",
  free_shipping: "Free shipping",
  free_gift: "Free gift",
  bundle: "Bundle offer",
  exclusive_access: "Exclusive access",
  early_access: "Early access",
  loyalty_points: "Loyalty points",
};

const SEND_WINDOW_LABELS: Record<string, string> = {
  morning: "Morning",
  midday: "Midday",
  evening: "Evening",
  weekend_morning: "Weekend morning",
  weekend_evening: "Weekend evening",
};

/** Human label for a customer group slug. */
export function groupLabel(slug: string): string {
  return GROUP_LABELS[slug] ?? humanize(slug);
}

/** Human label for an offer type. */
export function offerTypeLabel(offerType: string): string {
  return OFFER_TYPE_LABELS[offerType] ?? humanize(offerType);
}

/** Human label for a send-time window. */
export function sendWindowLabel(window: string): string {
  return SEND_WINDOW_LABELS[window] ?? humanize(window);
}

/** Human label for a tone descriptor. */
export function toneLabel(tone: string): string {
  return humanize(tone);
}

/** The five send-time windows, in order — for the editor's window picker. */
export const SEND_WINDOWS: readonly string[] = [
  "morning",
  "midday",
  "evening",
  "weekend_morning",
  "weekend_evening",
];

/** SMS-length ceiling for a campaign message draft. */
export const MESSAGE_MAX = 160;

// ─────────────────────────────────────────────────────────────────────────────
// Expected-impact display helpers (pure — unit-tested in _labels.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpectedImpact {
  /** Estimated response rate, 0–1. */
  rate: number;
  /** Estimated restored revenue, in whole currency units. */
  revenue: number;
}

/**
 * Reads a campaign arm's `expected_impact` jsonb defensively into numbers. A
 * missing or malformed value yields zeros rather than throwing — the UI must
 * render even if a legacy row has an unexpected shape.
 */
export function readImpact(value: unknown): ExpectedImpact {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    return {
      rate: typeof o.estimated_response_rate === "number" ? o.estimated_response_rate : 0,
      revenue:
        typeof o.estimated_recovered_revenue === "number" ? o.estimated_recovered_revenue : 0,
    };
  }
  return { rate: 0, revenue: 0 };
}

/** Formats a whole-currency-unit amount as "$1,234". */
export function money(wholeUnits: number): string {
  return `$${new Intl.NumberFormat("en-US").format(Math.round(wholeUnits))}`;
}

/**
 * The restored-revenue range across a proposal's variants: "$900" when every
 * variant agrees, "$900–$2,400" otherwise. `impacts` is the list of each
 * variant's expected_impact jsonb.
 */
export function restoredRange(impacts: unknown[]): string {
  if (impacts.length === 0) return money(0);
  const revenues = impacts.map((i) => readImpact(i).revenue);
  const lo = Math.min(...revenues);
  const hi = Math.max(...revenues);
  return lo === hi ? money(lo) : `${money(lo)}–${money(hi)}`;
}
