// Unit tests for the pure (no-I/O) helpers behind the Sprint 07 conversation
// read queries. The query functions themselves are exercised by the live-DB
// RLS integration test; these helpers are pure and unit-testable directly.

import { describe, expect, it } from "vitest";
import { customerDisplayName, customerHandleOf, truncate } from "../src/queries";

const GID = "gid://shopify/Customer/12345";

describe("customerDisplayName", () => {
  it("prefers a full name", () => {
    expect(
      customerDisplayName(
        { shopify_customer_gid: GID, first_name: "Ada", last_name: "Lovelace", email: "a@x.com" },
        GID,
      ),
    ).toBe("Ada Lovelace");
  });

  it("uses a first name alone when there is no last name", () => {
    expect(
      customerDisplayName(
        { shopify_customer_gid: GID, first_name: "Ada", last_name: null, email: null },
        GID,
      ),
    ).toBe("Ada");
  });

  it("falls back to the email when there is no name", () => {
    expect(
      customerDisplayName(
        { shopify_customer_gid: GID, first_name: null, last_name: null, email: "ada@example.com" },
        GID,
      ),
    ).toBe("ada@example.com");
  });

  it("falls back to a gid suffix when there is no name or email", () => {
    expect(
      customerDisplayName(
        { shopify_customer_gid: GID, first_name: null, last_name: null, email: null },
        GID,
      ),
    ).toBe("Customer 12345");
  });

  it("falls back to a gid suffix when the row is missing entirely", () => {
    expect(customerDisplayName(undefined, GID)).toBe("Customer 12345");
  });

  it("ignores whitespace-only name fields", () => {
    expect(
      customerDisplayName(
        { shopify_customer_gid: GID, first_name: "  ", last_name: "  ", email: "a@b.com" },
        GID,
      ),
    ).toBe("a@b.com");
  });
});

describe("customerHandleOf", () => {
  it("uses the email when present", () => {
    expect(
      customerHandleOf(
        { shopify_customer_gid: GID, first_name: null, last_name: null, email: "ada@example.com" },
        GID,
      ),
    ).toBe("ada@example.com");
  });

  it("falls back to a #gid-suffix when there is no email", () => {
    expect(
      customerHandleOf(
        { shopify_customer_gid: GID, first_name: "Ada", last_name: null, email: null },
        GID,
      ),
    ).toBe("#12345");
  });

  it("falls back to #gid-suffix when the row is missing", () => {
    expect(customerHandleOf(undefined, GID)).toBe("#12345");
  });
});

describe("truncate", () => {
  it("returns the string unchanged when within the limit", () => {
    expect(truncate("short", 10)).toBe("short");
  });

  it("returns the string unchanged at exactly the limit", () => {
    expect(truncate("exactlyten", 10)).toBe("exactlyten");
  });

  it("truncates and appends an ellipsis when over the limit", () => {
    const result = truncate("this is a long message body", 10);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("trims trailing whitespace before the ellipsis", () => {
    const result = truncate("abcde     fghij", 8);
    expect(result).toBe("abcde…");
  });
});
