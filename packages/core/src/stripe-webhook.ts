// Stripe webhook event handler — Sprint 09 chunk 8.
//
// `handleStripeWebhookEvent` applies a SIGNATURE-VERIFIED Stripe event to the
// local subscription mirror. Signature verification itself happens in the
// route, BEFORE this function and before any body parsing (decision 32) — this
// function only ever receives an already-verified event.
//
// IDEMPOTENT (decision 32). Stripe re-delivers events. `subscription_events`
// has a partial UNIQUE on `stripe_event_id`; this handler pre-checks it and
// also treats a unique-violation on insert as a duplicate. A re-delivered
// event is a no-op — the mirror is never double-applied.
//
// MIRROR, NOT SOURCE OF TRUTH (decision 29). `merchant_subscriptions` and the
// cached `merchants.subscription_tier/status` are a read mirror updated here
// from Stripe. Stripe remains authoritative.
//
// Five handled event types:
//   customer.subscription.created / .updated  → upsert the mirror row + cache
//   customer.subscription.deleted             → mark canceled
//   invoice.payment_succeeded                 → clear the grace window
//   invoice.payment_failed                    → no state change (the paired
//                                               subscription.updated → past_due
//                                               carries the transition)
// Any other type is logged and ignored with a 200 (never fail Stripe's stream).

import type { LapsedSupabaseClient, Json } from "@lapsed/db";
import type { StripeWebhookEvent, SubscriptionTier } from "./stripe-client";

/** Subscription statuses the local mirror stores (migration 0010 CHECK). */
export type MirrorSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "suspended";

export interface StripeWebhookHandlerConfig {
  /** Stripe Price id per tier — used to reverse-map a subscription to a tier. */
  priceIds: Record<SubscriptionTier, string>;
}

export interface StripeWebhookHandlerResult {
  status: "processed" | "duplicate" | "ignored" | "no_merchant";
  eventType: string;
  merchantId?: string;
}

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "23505";
}

/** The five event types this handler acts on. */
const HANDLED_EVENT_TYPES = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
]);

/**
 * Maps a Stripe subscription status onto the mirror's CHECK-constrained enum.
 * `suspended` is intentionally NOT produced here — it is set only by the
 * billing-grace cron after the grace window elapses (decision 31). `unpaid`
 * collapses to `past_due`. An unmapped status returns null and the caller
 * skips the mirror write rather than violating the CHECK.
 */
function mapStripeStatus(stripeStatus: string): MirrorSubscriptionStatus | null {
  switch (stripeStatus) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    default:
      // incomplete / incomplete_expired / paused — not a live mirror state.
      return null;
  }
}

/** Unix-seconds (or null) → ISO string (or null). */
function unixToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

/**
 * Reads a subscription's current-period bounds. Stripe moved
 * `current_period_start`/`current_period_end` off the Subscription object onto
 * each Subscription Item in recent API versions; older versions keep them at
 * the top level. This reads the item first and falls back to the top level so
 * the handler is correct across both shapes.
 */
function subscriptionPeriod(object: Record<string, unknown>): {
  startIso: string | null;
  endIso: string | null;
} {
  const items = object.items as
    | { data?: Array<{ current_period_start?: unknown; current_period_end?: unknown }> }
    | undefined;
  const item = items?.data?.[0];
  return {
    startIso: unixToIso(item?.current_period_start ?? object.current_period_start),
    endIso: unixToIso(item?.current_period_end ?? object.current_period_end),
  };
}

/** Reads `obj.customer` (a Stripe object reference) as a customer id string. */
function customerIdOf(object: Record<string, unknown>): string | null {
  const c = object.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string") {
    return (c as { id: string }).id;
  }
  return null;
}

/** Reverse-maps a subscription's first line-item price id to a tier. */
function tierOfSubscription(
  object: Record<string, unknown>,
  priceIds: Record<SubscriptionTier, string>,
): SubscriptionTier | null {
  const items = object.items as { data?: Array<{ price?: { id?: unknown } }> } | undefined;
  const priceId = items?.data?.[0]?.price?.id;
  if (typeof priceId !== "string") return null;
  for (const tier of Object.keys(priceIds) as SubscriptionTier[]) {
    if (priceIds[tier] === priceId) return tier;
  }
  return null;
}

interface MerchantSubscriptionUpsert {
  merchant_id: string;
  stripe_subscription_id: string;
  tier: string;
  status: MirrorSubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  grace_period_started_at: string | null;
  cancel_at: string | null;
  canceled_at: string | null;
  updated_at: string;
}

/**
 * Applies a verified Stripe webhook event to the local subscription mirror.
 * Idempotent on `event.id`. Returns a result describing what was done; the
 * route always responds 200 unless the signature check (upstream) failed.
 */
export async function handleStripeWebhookEvent(
  client: LapsedSupabaseClient,
  event: StripeWebhookEvent,
  config: StripeWebhookHandlerConfig,
  opts: { now?: () => Date } = {},
): Promise<StripeWebhookHandlerResult> {
  const now = opts.now ?? (() => new Date());
  const nowIso = now().toISOString();

  // Unknown event types never touch the DB — log and 200 so Stripe's webhook
  // stream is not failed by an event we simply do not act on.
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    console.info(
      JSON.stringify({ event: "stripe_webhook_ignored", event_type: event.type, event_id: event.id }),
    );
    return { status: "ignored", eventType: event.type };
  }

  const object = event.data.object;
  const customerId = customerIdOf(object);
  if (!customerId) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_no_customer",
        event_type: event.type,
        event_id: event.id,
      }),
    );
    return { status: "no_merchant", eventType: event.type };
  }

  // Resolve the merchant via the Stripe customer id mirror (decision 28).
  const { data: merchant, error: merchantErr } = await client
    .from("merchants")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  if (merchantErr) throw merchantErr;
  if (!merchant) {
    console.warn(
      JSON.stringify({
        event: "stripe_webhook_unknown_customer",
        event_type: event.type,
        event_id: event.id,
      }),
    );
    return { status: "no_merchant", eventType: event.type };
  }
  const merchantId = merchant.id as string;

  // Idempotency pre-check (decision 32) — a re-delivered event is a no-op.
  const { data: existing, error: existErr } = await client
    .from("subscription_events")
    .select("id")
    .eq("stripe_event_id", event.id)
    .maybeSingle();
  if (existErr) throw existErr;
  if (existing) {
    return { status: "duplicate", eventType: event.type, merchantId };
  }

  // ── Apply the state transition, THEN record the audit event ───────────────
  // The audit row is the "fully processed" marker, written LAST. If the state
  // mutation below fails, no audit row is written, so a Stripe re-delivery
  // re-runs the mutation (every mutation here is an idempotent upsert/update of
  // deterministic Stripe-supplied values). Writing the audit row first would
  // make a re-delivery short-circuit on the pre-check and never apply the
  // state — the audit row proves "seen", not "applied".
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const subscriptionId = typeof object.id === "string" ? object.id : null;
    const stripeStatus = typeof object.status === "string" ? object.status : "";
    const mappedStatus = mapStripeStatus(stripeStatus);
    const tier = tierOfSubscription(object, config.priceIds);
    const { startIso: periodStart, endIso: periodEnd } = subscriptionPeriod(object);

    if (!subscriptionId || !mappedStatus || !tier || !periodStart || !periodEnd) {
      // Not enough to write a CHECK-valid mirror row (e.g. an `incomplete`
      // subscription). The event is still recorded for audit below.
      console.warn(
        JSON.stringify({
          event: "stripe_webhook_subscription_unmappable",
          event_id: event.id,
          merchant_id: merchantId,
          stripe_status: stripeStatus,
          has_tier: tier !== null,
        }),
      );
    } else {
      // grace_period_started_at: stamp `now` when the subscription FIRST
      // enters past_due, but PRESERVE an existing grace start on a repeated
      // past_due update (decision 31 anchors the 7-day window at the first
      // failed payment — re-stamping would silently extend it). Cleared when
      // the status is anything other than past_due.
      const { data: priorRow, error: priorErr } = await client
        .from("merchant_subscriptions")
        .select("grace_period_started_at")
        .eq("merchant_id", merchantId)
        .maybeSingle();
      if (priorErr) throw priorErr;
      const graceStartedAt =
        mappedStatus === "past_due"
          ? ((priorRow?.grace_period_started_at as string | null | undefined) ?? nowIso)
          : null;

      const upsertRow: MerchantSubscriptionUpsert = {
        merchant_id: merchantId,
        stripe_subscription_id: subscriptionId,
        tier,
        status: mappedStatus,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        grace_period_started_at: graceStartedAt,
        cancel_at: unixToIso(object.cancel_at),
        canceled_at: unixToIso(object.canceled_at),
        updated_at: nowIso,
      };
      const { error: subErr } = await client
        .from("merchant_subscriptions")
        .upsert(upsertRow, { onConflict: "merchant_id" });
      if (subErr) throw subErr;

      // Update the cached tier/status on merchants (decision 30 read path).
      const { error: merchUpdErr } = await client
        .from("merchants")
        .update({ subscription_tier: tier, subscription_status: mappedStatus })
        .eq("id", merchantId);
      if (merchUpdErr) throw merchUpdErr;
    }
  } else if (event.type === "customer.subscription.deleted") {
    const canceledAt = unixToIso(object.canceled_at) ?? nowIso;
    const { error: subErr } = await client
      .from("merchant_subscriptions")
      .update({ status: "canceled", canceled_at: canceledAt, updated_at: nowIso })
      .eq("merchant_id", merchantId);
    if (subErr) throw subErr;
    const { error: merchUpdErr } = await client
      .from("merchants")
      .update({ subscription_status: "canceled" })
      .eq("id", merchantId);
    if (merchUpdErr) throw merchUpdErr;
  } else if (event.type === "invoice.payment_succeeded") {
    // Recovery from past_due — clear the grace window (decision 31).
    const { error: subErr } = await client
      .from("merchant_subscriptions")
      .update({ grace_period_started_at: null, updated_at: nowIso })
      .eq("merchant_id", merchantId);
    if (subErr) throw subErr;
  }
  // invoice.payment_failed — no state change here; the paired
  // customer.subscription.updated → past_due carries the transition.

  // Record the audit event LAST — its presence is the "fully processed"
  // marker the idempotency pre-check above keys on. The partial UNIQUE on
  // stripe_event_id is the backstop for a concurrent re-delivery race (both
  // deliveries applied the same deterministic state idempotently; one wins
  // the insert, the other reads it as a duplicate).
  const { error: insertErr } = await client.from("subscription_events").insert({
    merchant_id: merchantId,
    stripe_event_id: event.id,
    event_type: event.type,
    data: event as unknown as Json,
  });
  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      return { status: "duplicate", eventType: event.type, merchantId };
    }
    throw insertErr;
  }

  console.info(
    JSON.stringify({
      event: "stripe_webhook_processed",
      event_type: event.type,
      event_id: event.id,
      merchant_id: merchantId,
    }),
  );
  return { status: "processed", eventType: event.type, merchantId };
}
