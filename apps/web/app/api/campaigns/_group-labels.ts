// Canonical group slug list and human labels — shared by the campaigns API
// routes (groups, create) so they can validate slugs without importing the
// client-side _labels.ts module.

export const GROUP_SLUGS = [
  "lapsed_vips",
  "at_risk_regulars",
  "single_purchase_converters",
  "price_sensitive_lapsed",
  "recent_first_purchasers",
  "win_backs_at_risk",
] as const;

export type GroupSlug = (typeof GROUP_SLUGS)[number];

const GROUP_LABEL_MAP: Record<GroupSlug, string> = {
  lapsed_vips: "Lapsed VIPs",
  at_risk_regulars: "At-risk regulars",
  single_purchase_converters: "Single-purchase converters",
  price_sensitive_lapsed: "Price-sensitive lapsed buyers",
  recent_first_purchasers: "Recent first-time buyers",
  win_backs_at_risk: "Win-backs going quiet",
};

export function groupLabel(slug: string): string {
  return GROUP_LABEL_MAP[slug as GroupSlug] ?? slug.replace(/_/g, " ");
}

export function isValidGroupSlug(slug: unknown): slug is GroupSlug {
  return typeof slug === "string" && (GROUP_SLUGS as readonly string[]).includes(slug);
}
