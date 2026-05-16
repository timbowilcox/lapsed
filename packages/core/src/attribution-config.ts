// Attribution configuration resolver — the per-merchant attribution window and
// LTV evaluation window (architectural decision 20).
//
// `merchant_attribution_config` holds a merchant's current settings. The
// attribution window is STAMPED onto a campaign proposal at approval time
// (see campaign-approval.ts) and is immutable for that proposal thereafter —
// changing the merchant default here affects only FUTURE approvals. This
// keeps already-reported lift figures deterministic and auditable.
//
// A merchant with no config row falls back to the v1 defaults below.

import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";

/** v1 default attribution window — 14 days from the outbound send. */
export const ATTRIBUTION_WINDOW_DAYS_DEFAULT = 14;

/** v1 default LTV evaluation window — 30 days post-outbound (decision 23). */
export const LTV_EVALUATION_WINDOW_DAYS_DEFAULT = 30;

/**
 * Resolves a merchant's attribution window in days. Reads
 * `merchant_attribution_config.attribution_window_days`; falls back to
 * ATTRIBUTION_WINDOW_DAYS_DEFAULT (14) when the merchant has no config row.
 *
 * Throws a ZodError on an invalid merchantId and the Postgres error on a
 * query failure (a swallowed read error would silently mis-stamp a proposal).
 */
export async function getAttributionWindow(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
): Promise<number> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);

  const { data, error } = await serviceClient
    .from("merchant_attribution_config")
    .select("attribution_window_days")
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (error) throw error;

  return data?.attribution_window_days ?? ATTRIBUTION_WINDOW_DAYS_DEFAULT;
}

/**
 * Resolves a merchant's LTV evaluation window in days. Reads
 * `merchant_attribution_config.ltv_evaluation_window_days`; falls back to
 * LTV_EVALUATION_WINDOW_DAYS_DEFAULT (30) when the merchant has no config row.
 */
export async function getLtvEvaluationWindow(
  serviceClient: LapsedSupabaseClient,
  merchantId: string,
): Promise<number> {
  z.string().uuid("merchantId must be a UUID").parse(merchantId);

  const { data, error } = await serviceClient
    .from("merchant_attribution_config")
    .select("ltv_evaluation_window_days")
    .eq("merchant_id", merchantId)
    .maybeSingle();
  if (error) throw error;

  return data?.ltv_evaluation_window_days ?? LTV_EVALUATION_WINDOW_DAYS_DEFAULT;
}
