import { describe, expect, it } from "vitest";
import {
  validateKeyword,
  assertNotReserved,
  normalise,
  dedupeKeywords,
  TWILIO_RESERVED,
} from "../app/api/settings/opt-out-keywords/_validate";

describe("validateKeyword", () => {
  it("accepts a valid alphabetic keyword", () => {
    expect(validateKeyword("QUIT").valid).toBe(true);
  });

  it("accepts a valid alphanumeric keyword", () => {
    expect(validateKeyword("STOP2").valid).toBe(true);
  });

  it("rejects a keyword that is too short (1 char)", () => {
    const result = validateKeyword("Q");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/2.30/);
  });

  it("rejects a keyword that is too long (>30 chars)", () => {
    const result = validateKeyword("A".repeat(31));
    expect(result.valid).toBe(false);
  });

  it("rejects a keyword with special characters", () => {
    const result = validateKeyword("STOP!");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/letters or numbers/);
  });

  it("rejects a keyword with spaces", () => {
    const result = validateKeyword("OPT OUT");
    expect(result.valid).toBe(false);
  });

  it("rejects an empty string", () => {
    const result = validateKeyword("");
    expect(result.valid).toBe(false);
  });

  it("accepts keywords up to 30 characters", () => {
    expect(validateKeyword("A".repeat(30)).valid).toBe(true);
  });
});

describe("assertNotReserved — add a keyword (add is always allowed)", () => {
  it("allows adding a new valid keyword", () => {
    expect(assertNotReserved("QUIT").valid).toBe(true);
    expect(assertNotReserved("CANCEL").valid).toBe(true);
  });
});

describe("assertNotReserved — remove attempt", () => {
  it("rejects removing STOP (exact case)", () => {
    const result = assertNotReserved("STOP");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Twilio-reserved/);
  });

  it("rejects removing STOPALL (exact case)", () => {
    const result = assertNotReserved("STOPALL");
    expect(result.valid).toBe(false);
  });

  it("rejects removing STOP case-insensitively", () => {
    expect(assertNotReserved("stop").valid).toBe(false);
    expect(assertNotReserved("Stop").valid).toBe(false);
  });

  it("rejects removing STOPALL case-insensitively", () => {
    expect(assertNotReserved("stopall").valid).toBe(false);
  });

  it("allows removing non-reserved keywords", () => {
    expect(assertNotReserved("QUIT").valid).toBe(true);
    expect(assertNotReserved("END").valid).toBe(true);
    expect(assertNotReserved("CANCEL").valid).toBe(true);
  });
});

describe("normalise", () => {
  it("uppercases and trims whitespace", () => {
    expect(normalise("  quit  ")).toBe("QUIT");
    expect(normalise("cancel")).toBe("CANCEL");
    expect(normalise("STOP")).toBe("STOP");
  });
});

describe("dedupeKeywords", () => {
  it("removes duplicates case-insensitively", () => {
    const result = dedupeKeywords(["STOP", "stop", "QUIT", "quit"]);
    expect(result.length).toBe(2);
    expect(result).toContain("STOP");
    expect(result).toContain("QUIT");
  });

  it("normalises all entries to uppercase", () => {
    const result = dedupeKeywords(["quit"]);
    expect(result).toEqual(["QUIT"]);
  });

  it("returns an empty array for empty input", () => {
    expect(dedupeKeywords([])).toEqual([]);
  });
});

describe("TWILIO_RESERVED", () => {
  it("contains STOP and STOPALL", () => {
    expect(TWILIO_RESERVED).toContain("STOP");
    expect(TWILIO_RESERVED).toContain("STOPALL");
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(TWILIO_RESERVED)).toBe(true);
  });
});
