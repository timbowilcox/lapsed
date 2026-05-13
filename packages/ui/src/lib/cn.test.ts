import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("skips falsy values", () => {
    expect(cn("a", false, undefined, null, "b")).toBe("a b");
  });

  it("dedupes conflicting tailwind classes", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("merges arrays and objects", () => {
    expect(cn(["a", { b: true, c: false }])).toBe("a b");
  });
});
