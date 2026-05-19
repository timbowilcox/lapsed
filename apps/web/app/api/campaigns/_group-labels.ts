// Canonical group slug list and validation helper — shared by the campaigns API
// routes (groups, create) so they can validate slugs without importing the
// client-side _labels.ts module.
//
// groupLabel is imported from the canonical source (_labels.ts) to prevent the
// two modules from drifting independently.

// groupLabel is imported from the canonical source to prevent drift.
export { groupLabel } from "../../app/campaigns/_labels";

export const GROUP_SLUGS = [
  "lapsed_vips",
  "at_risk_regulars",
  "single_purchase_converters",
  "price_sensitive_lapsed",
  "recent_first_purchasers",
  "win_backs_at_risk",
] as const;

export type GroupSlug = (typeof GROUP_SLUGS)[number];

export function isValidGroupSlug(slug: unknown): slug is GroupSlug {
  return typeof slug === "string" && (GROUP_SLUGS as readonly string[]).includes(slug);
}
