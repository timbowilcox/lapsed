// Group snapshot helper — freezes the customer set of a group at campaign
// proposal time and assigns the deterministic holdout subset. Implements
// architectural decision 15 (group snapshots frozen at proposal creation)
// and lays the holdout foundation for decision 5 (holdout control groups).
//
// The snapshot is written ONCE, at proposal time. Subsequent changes to the
// underlying group definition (re-scoring, lifecycle drift, customer add/
// remove) never change which customers a proposal targets — attribution math
// in Sprint 08 reads the frozen snapshot, never a live recompute.
//
// Holdout assignment is deterministic: a customer is held out iff the
// SHA-256 hash of `${proposalId}::${customerId}`, normalized to the unit
// interval [0, 1), falls below `holdoutRate` (0.1 by default). The same
// (proposalId, customerId) pair always lands in or out of the holdout, so the
// assignment is reproducible and the snapshot write is idempotent. The
// fractional comparison honours any rate exactly — unlike a modulo-divisor
// scheme, a rate like 0.15 yields ~15%, not a rounded 1/7th.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { LapsedSupabaseClient } from "@lapsed/db";

/** Default fraction of each group held out per campaign (decision 5). */
export const HOLDOUT_RATE_DEFAULT = 0.1;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic holdout assignment (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** 2^32 — the number of distinct values a 32-bit unsigned integer can take. */
const UINT32_SPACE = 0x1_0000_0000;

/**
 * Deterministically decides whether `customerId` is in the holdout for
 * `proposalId`. Pure: same inputs → same output, no I/O.
 *
 * Uses SHA-256 over `${proposalId}::${customerId}`. The first 8 hex digits
 * are read as a 32-bit unsigned integer (always < 2^32, so safe-integer) and
 * normalized to [0, 1). SHA-256 has excellent uniform distribution, so the
 * normalized value is unbiased: a customer is held out iff it falls below
 * `holdoutRate`, giving an exact ~`holdoutRate` fraction independent of
 * group size, customer ordering, or whether the rate is a clean 1/n.
 */
export function isHeldOut(
  proposalId: string,
  customerId: string,
  holdoutRate: number = HOLDOUT_RATE_DEFAULT,
): boolean {
  const digest = createHash("sha256")
    .update(`${proposalId}::${customerId}`)
    .digest("hex");
  const bucket = parseInt(digest.slice(0, 8), 16);
  return bucket / UINT32_SPACE < holdoutRate;
}

/**
 * Pure: partitions `customerIds` into the full set (deduplicated, order
 * preserved) and the deterministically-assigned holdout subset.
 */
export function computeGroupSnapshot(
  proposalId: string,
  customerIds: readonly string[],
  holdoutRate: number = HOLDOUT_RATE_DEFAULT,
): { customerIds: string[]; holdoutIds: string[] } {
  const unique = Array.from(new Set(customerIds));
  const holdoutIds = unique.filter((id) => isHeldOut(proposalId, id, holdoutRate));
  return { customerIds: unique, holdoutIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot persistence
// ─────────────────────────────────────────────────────────────────────────────

const SnapshotGroupInputSchema = z.object({
  merchantId: z.string().uuid("merchantId must be a UUID"),
  proposalId: z.string().uuid("proposalId must be a UUID"),
  groupSlug: z.string().min(1, "groupSlug is required"),
  customerIds: z.array(z.string().min(1, "customerId must be non-empty")),
  holdoutRate: z.number().gt(0).lte(1).optional(),
});

export type SnapshotGroupInput = z.infer<typeof SnapshotGroupInputSchema>;

export interface SnapshotGroupResult {
  /** Full deduplicated customer set frozen for this proposal. */
  customerIds: string[];
  /** The deterministically-assigned holdout subset. */
  holdoutIds: string[];
}

/**
 * Freezes the group's customer set into `campaign_group_snapshots` for the
 * given proposal and marks the deterministic holdout subset.
 *
 * Idempotent: the composite PK (proposal_id, customer_id) plus an
 * ON CONFLICT DO NOTHING upsert means re-running with the same
 * (proposalId, customerIds) is a no-op — and because holdout assignment is
 * deterministic, a re-run would compute the identical holdout anyway.
 *
 * The `groupSlug` is not stored on the snapshot rows (it lives on
 * `campaign_proposals.group_slug`); it is validated here so a caller cannot
 * snapshot a group with no identifier.
 *
 * Throws a ZodError on invalid input and the Postgres error on a write
 * failure.
 */
export async function snapshotGroup(
  serviceClient: LapsedSupabaseClient,
  input: SnapshotGroupInput,
): Promise<SnapshotGroupResult> {
  const v = SnapshotGroupInputSchema.parse(input);
  const holdoutRate = v.holdoutRate ?? HOLDOUT_RATE_DEFAULT;

  const { customerIds, holdoutIds } = computeGroupSnapshot(
    v.proposalId,
    v.customerIds,
    holdoutRate,
  );

  if (customerIds.length === 0) {
    return { customerIds, holdoutIds };
  }

  const holdoutSet = new Set(holdoutIds);
  const rows = customerIds.map((customerId) => ({
    proposal_id: v.proposalId,
    merchant_id: v.merchantId,
    customer_id: customerId,
    included_in_holdout: holdoutSet.has(customerId),
  }));

  // Lapsed groups for a $2M–$50M merchant can run to tens of thousands of
  // customers. A single upsert of every row risks exceeding the PostgREST
  // request-size limit, so the write is chunked. ON CONFLICT DO NOTHING keeps
  // each chunk independently idempotent.
  for (let i = 0; i < rows.length; i += SNAPSHOT_WRITE_BATCH_SIZE) {
    const batch = rows.slice(i, i + SNAPSHOT_WRITE_BATCH_SIZE);
    const { error } = await serviceClient
      .from("campaign_group_snapshots")
      .upsert(batch, { onConflict: "proposal_id,customer_id", ignoreDuplicates: true });
    if (error) throw error;
  }

  return { customerIds, holdoutIds };
}

/** Rows per campaign_group_snapshots upsert; bounds PostgREST request size. */
const SNAPSHOT_WRITE_BATCH_SIZE = 500;
