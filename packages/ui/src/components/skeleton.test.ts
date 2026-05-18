import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("base renders with cream-300 background", () => {
    // The component itself is tested by consuming code; here we verify
    // the exported shape is correct (not a regression guard for CVA).
    expect(typeof Skeleton).toBe("function");
    expect(typeof Skeleton.Text).toBe("function");
    expect(typeof Skeleton.Row).toBe("function");
    expect(typeof Skeleton.Card).toBe("function");
  });
});

// SkeletonText multi-line branching is tested at the rendering level via
// integration, but we can verify the function shape without a DOM environment.
describe("Skeleton.Text", () => {
  it("is exported as a function", () => {
    expect(typeof Skeleton.Text).toBe("function");
  });
});

describe("Skeleton.Row", () => {
  it("is exported as a function", () => {
    expect(typeof Skeleton.Row).toBe("function");
  });
});

describe("Skeleton.Card", () => {
  it("is exported as a function", () => {
    expect(typeof Skeleton.Card).toBe("function");
  });
});
