// Shared helpers for the /api/campaigns/* approval routes. Not a route file
// (no `route` export) — Next's App Router ignores it for routing.

import { NextResponse } from "next/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True if `value` is a syntactically valid UUID. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Strips the leading `functionName: ` prefix off an internal error message
 * before it is echoed to the client, so the API surface never leaks
 * @lapsed/core function names. The remaining text (a plain description and a
 * proposal UUID) is safe — a proposal id is the merchant's own resource.
 */
function clientDetail(message: string): string {
  return message.replace(/^[A-Za-z]+:\s*/, "");
}

/**
 * Maps an error thrown by a campaign-approval function (or a query helper) to
 * an HTTP response. A "not found for merchant" error becomes 404 — never 403 —
 * so the API never reveals whether a proposal exists for another merchant.
 * Invalid-state transitions become 409; validation failures 400; everything
 * else 500 with a structured server-side log (no PII, no message text).
 */
export function campaignErrorResponse(err: unknown): NextResponse {
  // Detect Zod failures by error name rather than importing `zod` (not a
  // dependency of @lapsed/web — the validation lives in @lapsed/core).
  if (err instanceof Error && err.name === "ZodError") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const message = err instanceof Error ? err.message : String(err);

  if (/not found for merchant/.test(message)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (
    /cannot be approved|cannot be rejected|only a pending proposal can be edited|concurrently edited|does not exist on proposal|has no arms/.test(
      message,
    )
  ) {
    return NextResponse.json({ error: "conflict", detail: clientDetail(message) }, { status: 409 });
  }
  if (/must be a UUID|is required|at least one variant edit/.test(message)) {
    return NextResponse.json(
      { error: "invalid_request", detail: clientDetail(message) },
      { status: 400 },
    );
  }

  console.error(JSON.stringify({ event: "campaign_route_error", message }));
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
