// Keyword validation for opt-out and agent-draft-default lists.
// Twilio-reserved keywords are non-removable from both lists.

export const TWILIO_RESERVED = Object.freeze(["STOP", "STOPALL"]) as readonly string[];
const RESERVED_SET = new Set(TWILIO_RESERVED);

// Accepts letters and digits only; 2–30 characters.
const KEYWORD_RE = /^[A-Za-z0-9]{2,30}$/;

export interface KeywordValidation {
  valid: boolean;
  error?: string;
}

export function validateKeyword(raw: string): KeywordValidation {
  const trimmed = raw.trim();
  if (!KEYWORD_RE.test(trimmed)) {
    return {
      valid: false,
      error: "Keywords must be 2–30 letters or numbers, with no spaces or special characters.",
    };
  }
  return { valid: true };
}

export function assertNotReserved(raw: string): KeywordValidation {
  const upper = raw.trim().toUpperCase();
  if (RESERVED_SET.has(upper)) {
    return {
      valid: false,
      error: `"${upper}" is a Twilio-reserved keyword and cannot be removed.`,
    };
  }
  return { valid: true };
}

export function normalise(raw: string): string {
  return raw.trim().toUpperCase();
}

export function dedupeKeywords(keywords: string[]): string[] {
  return Array.from(new Set(keywords.map(normalise)));
}
