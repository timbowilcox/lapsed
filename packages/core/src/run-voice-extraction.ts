// Voice extraction orchestrator — single entry point that wires together
// the chunks 2-6 building blocks for a complete extraction run.
//
// Sequence (all 8 steps, atomic at the event-log layer):
//   1. Daily-cap check (decision 5 — cost discipline)
//   2. Fetch storefront snapshot from Shopify
//   3. PII-redact the snapshot (decision 10)
//   4. Persist storefront_snapshots row (raw + redacted, source-hash deduped)
//   5. Write storefront_fetched + pii_redacted events
//   6. assertNoPii pre-flight + call voice synthesizer (decision 9)
//   7. Insert voice_versions row + write voice_extracted event
//   8. Materialize agent_profiles (active pointer + identity defaults)
//
// On any failure, writes an extraction_failed event and returns
// `{ ok: false, reason }`. Always idempotent — re-running with the same
// merchant returns the existing snapshot via source_hash dedup.

import type { LapsedSupabaseClient, Json } from "@lapsed/db";
import type Anthropic from "@anthropic-ai/sdk";
import {
  fetchStorefrontSnapshot,
  computeSourceHash,
  type StorefrontFetchResult,
} from "@lapsed/shopify";
import {
  redactSnapshot,
  assertNoPii,
  PiiLeakError,
} from "./pii-redactor";
import {
  synthesizeVoice,
  VoiceSynthesisError,
  SONNET_MODEL_DEFAULT,
} from "./voice-synthesizer";
import {
  appendVoiceEvent,
  insertVoiceVersion,
  materializeVoice,
  type VoiceFailurePhase,
} from "./voice-events";
import { deriveAgentIdentity } from "./derive-agent-identity";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface RunVoiceExtractionInput {
  serviceClient: LapsedSupabaseClient;
  anthropicClient: Anthropic;
  merchantId: string;
  shopDomain: string;
  accessToken: string;
  /** Defaults to SONNET_MODEL_DEFAULT. */
  model?: string;
  /** Default 10 — checked against count of voice_extracted events in the trailing 24h. */
  dailyCapDefault: number;
  /** Override for unit tests; defaults to `Date.now()`. */
  now?: () => Date;
  /** Override for unit tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Defaults to "install_orchestrator". */
  source?: "install_orchestrator" | "settings_reextract";
}

export type RunVoiceExtractionResult =
  | {
      ok: true;
      versionId: string;
      versionNumber: number;
      snapshotId: string;
      tokensInput: number;
      tokensOutput: number;
      retries: number;
    }
  | {
      ok: false;
      reason: VoiceFailurePhase;
      detail: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Main orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export async function runVoiceExtraction(
  input: RunVoiceExtractionInput,
): Promise<RunVoiceExtractionResult> {
  const now = input.now ?? (() => new Date());
  const source = input.source ?? "install_orchestrator";

  // ── Step 1: daily cap ───────────────────────────────────────────────────
  const dailyCount = await countTodayExtractions(input.serviceClient, input.merchantId, now());
  if (dailyCount >= input.dailyCapDefault) {
    await safeAppend(input, source, {
      phase: "cap_check",
      reason: "daily_cap_exhausted",
    });
    logStructured("voice_extraction_failed", {
      merchant_id: input.merchantId,
      phase: "cap_check",
      reason: "daily_cap_exhausted",
      daily_count: dailyCount,
      cap: input.dailyCapDefault,
    });
    return { ok: false, reason: "cap_check", detail: "daily_cap_exhausted" };
  }

  // ── Step 2: fetch storefront ────────────────────────────────────────────
  // Aggregate 30s wall-clock guard (decision 8 + spec): if all 5 Shopify
  // resource fetches collectively take longer than 30s, abort and fail fast.
  // The inner per-request timeoutMs (15s) only bounds individual requests;
  // concurrent retries or slow responses can still keep the promise open
  // past 30s without this outer guard.
  // The timer handle is captured so it can be cleared in the finally block —
  // without cleanup, a resolved race leaves a dangling 30s timer that causes
  // "open handles" warnings in test runners and unnecessary timer queue load.
  let fetchResult: StorefrontFetchResult;
  try {
    let fetchTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const fetchTimeout = new Promise<never>((_, reject) => {
      fetchTimeoutHandle = setTimeout(() => reject(new Error("fetch_timeout_30s")), 30_000);
    });
    try {
      fetchResult = await Promise.race([
        fetchStorefrontSnapshot({
          shopDomain: input.shopDomain,
          accessToken: input.accessToken,
          fetch: input.fetch,
        }),
        fetchTimeout,
      ]);
    } finally {
      clearTimeout(fetchTimeoutHandle);
    }
  } catch (err) {
    return await failExtraction(input, source, "fetch", err);
  }

  // Hard failure: every resource failed. A degraded snapshot with all empty
  // fields would hash-collide with a legitimately-empty merchant, breaking
  // decision 8 reproducibility. Bail.
  if (
    fetchResult.failures.length === 5 ||
    (fetchResult.failures.length > 0 && allFieldsEmpty(fetchResult.snapshot))
  ) {
    const summary = fetchResult.failures
      .map((f: { resource: string; reason: string }) => `${f.resource}:${f.reason}`)
      .join(",");
    await safeAppend(input, source, {
      phase: "fetch",
      reason: "all_resources_failed",
      error_class: summary.slice(0, 64),
    });
    logStructured("voice_extraction_failed", {
      merchant_id: input.merchantId,
      phase: "fetch",
      failures: summary,
    });
    return { ok: false, reason: "fetch", detail: summary };
  }

  // ── Step 3+4: redact + persist storefront_snapshots ────────────────────
  const sourceHash = computeSourceHash(fetchResult.snapshot);
  const { redacted, summary: piiSummary } = redactSnapshot(
    fetchResult.snapshot as unknown as Record<string, unknown>,
  );

  // Defense in depth: assert no PII patterns survive in the redacted corpus.
  try {
    assertNoPii(JSON.stringify(redacted));
  } catch (err) {
    return await failExtraction(input, source, "redact", err);
  }

  // Upsert the snapshot row, deduping on (merchant_id, source_hash). If a
  // prior fetch produced the same corpus this merchant already has the
  // snapshot persisted; we re-use its id.
  let snapshotId: string;
  try {
    snapshotId = await upsertSnapshotRow(input.serviceClient, {
      merchantId: input.merchantId,
      raw: fetchResult.snapshot as unknown as Record<string, unknown>,
      redacted,
      sourceHash,
      piiSummary,
    });
  } catch (err) {
    return await failExtraction(input, source, "fetch", err);
  }

  // ── Step 5: write storefront_fetched + pii_redacted events ─────────────
  const occurredAt = now().toISOString();
  const byteCount = JSON.stringify(fetchResult.snapshot).length;
  try {
    await appendVoiceEvent(input.serviceClient, {
      merchantId: input.merchantId,
      eventType: "storefront_fetched",
      source,
      occurredAt,
      payload: { snapshot_id: snapshotId, byte_count: byteCount, source_hash: sourceHash },
    });
    await appendVoiceEvent(input.serviceClient, {
      merchantId: input.merchantId,
      eventType: "pii_redacted",
      source,
      occurredAt: addMs(occurredAt, 1),
      payload: { snapshot_id: snapshotId, pii_match_summary: piiSummary },
    });
  } catch (err) {
    return await failExtraction(input, source, "fetch", err);
  }

  // ── Step 6: voice synthesis ────────────────────────────────────────────
  let synthesisResult;
  try {
    synthesisResult = await synthesizeVoice(input.anthropicClient, {
      redactedCorpus: JSON.stringify(redacted),
      model: input.model ?? SONNET_MODEL_DEFAULT,
    });
  } catch (err) {
    return await failExtraction(input, source, "synthesize", err);
  }

  // ── Step 7: insert voice_versions row + voice_extracted event ─────────
  let versionId: string;
  let versionNumber: number;
  try {
    const inserted = await insertVoiceVersion(input.serviceClient, {
      merchantId: input.merchantId,
      sourceSnapshotId: snapshotId,
      profile: synthesisResult.profile,
      modelVersion: synthesisResult.modelVersion,
      promptVersion: synthesisResult.promptVersion,
      tokensInput: synthesisResult.tokensInput,
      tokensOutput: synthesisResult.tokensOutput,
      retries: synthesisResult.retries,
    });
    versionId = inserted.versionId;
    versionNumber = inserted.versionNumber;

    await appendVoiceEvent(input.serviceClient, {
      merchantId: input.merchantId,
      eventType: "voice_extracted",
      source,
      occurredAt: addMs(occurredAt, 2),
      payload: {
        version_id: versionId,
        snapshot_id: snapshotId,
        model_version: synthesisResult.modelVersion,
        prompt_version: synthesisResult.promptVersion,
        tokens_input: synthesisResult.tokensInput,
        tokens_output: synthesisResult.tokensOutput,
        retries: synthesisResult.retries,
      },
    });
  } catch (err) {
    return await failExtraction(input, source, "materialize", err);
  }

  // ── Step 8: materialize agent_profiles ─────────────────────────────────
  try {
    await materializeVoice(input.serviceClient, input.merchantId);

    // Identity defaults (role_descriptor, channel_prefs, fallback_criteria)
    // are written only on the initial install extraction. A settings re-extract
    // updates the active voice version pointer but must NOT clobber
    // merchant-customized identity fields (decision 11).
    if (source === "install_orchestrator") {
      const defaults = deriveAgentIdentity(synthesisResult.profile);
      const { error: defaultsErr } = await input.serviceClient
        .from("agent_profiles")
        .upsert(
          {
            merchant_id: input.merchantId,
            active_voice_version_id: versionId,
            role_descriptor: defaults.role_descriptor,
            channel_prefs: defaults.channel_prefs as unknown as Json,
            fallback_criteria: defaults.fallback_criteria as unknown as Json,
          },
          { onConflict: "merchant_id" },
        );
      if (defaultsErr) throw defaultsErr;
    }
  } catch (err) {
    return await failExtraction(input, source, "materialize", err);
  }

  logStructured("voice_extraction_complete", {
    merchant_id: input.merchantId,
    version_id: versionId,
    version_number: versionNumber,
    tokens_input: synthesisResult.tokensInput,
    tokens_output: synthesisResult.tokensOutput,
    retries: synthesisResult.retries,
  });

  return {
    ok: true,
    versionId,
    versionNumber,
    snapshotId,
    tokensInput: synthesisResult.tokensInput,
    tokensOutput: synthesisResult.tokensOutput,
    retries: synthesisResult.retries,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function countTodayExtractions(
  client: LapsedSupabaseClient,
  merchantId: string,
  now: Date,
): Promise<number> {
  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const { count, error } = await client
    .from("voice_events")
    .select("id", { count: "exact", head: true })
    .eq("merchant_id", merchantId)
    .eq("event_type", "voice_extracted")
    .gte("occurred_at", utcMidnight.toISOString());
  if (error) throw error;
  return count ?? 0;
}

interface UpsertSnapshotInput {
  merchantId: string;
  raw: Record<string, unknown>;
  redacted: Record<string, unknown>;
  sourceHash: string;
  piiSummary: Record<string, number>;
}

async function upsertSnapshotRow(
  client: LapsedSupabaseClient,
  input: UpsertSnapshotInput,
): Promise<string> {
  // Look up existing row by (merchant_id, source_hash). Idempotent re-fetch
  // returns the existing snapshot id without re-inserting.
  const { data: existing, error: lookupErr } = await client
    .from("storefront_snapshots")
    .select("id")
    .eq("merchant_id", input.merchantId)
    .eq("source_hash", input.sourceHash)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (existing?.id) return existing.id;

  const { data: inserted, error: insertErr } = await client
    .from("storefront_snapshots")
    .insert({
      merchant_id: input.merchantId,
      raw_content: input.raw as unknown as Json,
      redacted_content: input.redacted as unknown as Json,
      pii_match_summary: input.piiSummary as unknown as Json,
      source_hash: input.sourceHash,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) throw insertErr ?? new Error("snapshot_insert_returned_null");
  return inserted.id;
}

async function failExtraction(
  input: RunVoiceExtractionInput,
  source: "install_orchestrator" | "settings_reextract",
  phase: VoiceFailurePhase,
  err: unknown,
): Promise<RunVoiceExtractionResult> {
  const errorClass = errorClassName(err);
  const reason = errorReason(err);
  await safeAppend(input, source, {
    phase,
    reason: reason.slice(0, 64),
    error_class: errorClass.slice(0, 64),
  });
  logStructured("voice_extraction_failed", {
    merchant_id: input.merchantId,
    phase,
    reason,
    error_class: errorClass,
  });
  return { ok: false, reason: phase, detail: reason };
}

async function safeAppend(
  input: RunVoiceExtractionInput,
  source: "install_orchestrator" | "settings_reextract",
  payload: {
    phase: VoiceFailurePhase;
    reason: string;
    attempt?: number;
    error_class?: string;
  },
): Promise<void> {
  try {
    await appendVoiceEvent(input.serviceClient, {
      merchantId: input.merchantId,
      eventType: "extraction_failed",
      source,
      occurredAt: new Date().toISOString(),
      payload,
    });
  } catch (e) {
    // Last-resort logging — extraction_failed event itself failed to append.
    logStructured("voice_extraction_event_append_failed", {
      merchant_id: input.merchantId,
      phase: payload.phase,
      error: errorClassName(e),
    });
  }
}

function errorClassName(err: unknown): string {
  if (err instanceof PiiLeakError) return "PiiLeakError";
  if (err instanceof VoiceSynthesisError) return `VoiceSynthesisError:${err.reason}`;
  if (err instanceof Error) return err.name || "Error";
  return "UnknownError";
}

function errorReason(err: unknown): string {
  if (err instanceof PiiLeakError) return `pii_leak:${err.kinds.join(",")}`;
  if (err instanceof VoiceSynthesisError) return err.reason;
  if (err instanceof Error) return err.message || "unknown_error";
  return String(err);
}

function allFieldsEmpty(snapshot: {
  about: string;
  products: unknown[];
  blog: unknown[];
  policies: { privacy: string; refund: string; shipping: string };
  footer: string;
}): boolean {
  return (
    snapshot.about === "" &&
    snapshot.products.length === 0 &&
    snapshot.blog.length === 0 &&
    snapshot.policies.privacy === "" &&
    snapshot.policies.refund === "" &&
    snapshot.policies.shipping === "" &&
    snapshot.footer === ""
  );
}

/** Adds milliseconds to an ISO timestamp so dedup-unique constraint on
 *  (merchant_id, event_type, source, occurred_at) doesn't fire when the
 *  orchestrator writes multiple events in the same millisecond. */
function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function logStructured(event: string, fields: Record<string, unknown>): void {
  // Single-line JSON for log aggregation. NEVER includes raw storefront text,
  // LLM output, customer PII, or tokens (decision 10 + criterion 8).
  console.log(JSON.stringify({ event, ...fields }));
}
