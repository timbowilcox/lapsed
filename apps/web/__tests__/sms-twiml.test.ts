// Unit tests for the SMS webhook TwiML rendering. The inbound route's reply
// CONTENT is asserted by the conversation-engine flow test in @lapsed/core;
// these tests pin the TwiML envelope + XML escaping the route wraps it in.

import { describe, it, expect } from "vitest";
import { emptyTwiml, messageTwiml, xmlEscape } from "../app/api/sms/_twiml";

describe("emptyTwiml", () => {
  it("renders a well-formed empty Response (no Message)", () => {
    expect(emptyTwiml()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });
});

describe("messageTwiml", () => {
  it("wraps the reply body in a Response > Message envelope", () => {
    expect(messageTwiml("Thanks for your message.")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Thanks for your message.</Message></Response>',
    );
  });

  it("XML-escapes a body containing markup characters", () => {
    const out = messageTwiml('5 < 10 & "quoted" reply');
    expect(out).toContain("5 &lt; 10 &amp; &quot;quoted&quot; reply");
    expect(out).not.toContain("< 10");
  });
});

describe("xmlEscape", () => {
  it("escapes &, <, >, double and single quotes", () => {
    expect(xmlEscape(`a & b < c > d " e ' f`)).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &apos; f",
    );
  });

  it("leaves a plain string unchanged", () => {
    expect(xmlEscape("no special characters here")).toBe("no special characters here");
  });

  it("escapes ampersands before other entities (no double-escaping)", () => {
    // A literal "&lt;" in the input must become "&amp;lt;", not stay "&lt;".
    expect(xmlEscape("&lt;")).toBe("&amp;lt;");
  });
});
