// TwiML rendering for the SMS webhook routes. Not a route file (no `route`
// export) — Next's App Router ignores it for routing. Extracted from the
// inbound route so the (pure) rendering + XML escaping is unit-testable.

/** An empty TwiML response — Twilio sends no reply. */
export function emptyTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

/** A TwiML response carrying a single SMS reply. `body` is XML-escaped. */
export function messageTwiml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(body)}</Message></Response>`;
}

/** XML-escapes a reply body for safe inclusion in the TwiML response. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
