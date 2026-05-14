import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

describe("Button variants — contrast safety", () => {
  it("primary variant uses cream-50 text on ink-900 background (not ink on ink)", () => {
    const classes = buttonVariants({ variant: "primary" });
    expect(classes).toContain("text-cream-50");
    expect(classes).toContain("bg-ink-900");
    expect(classes).not.toContain("text-ink-900");
  });

  it("secondary variant uses ink-900 text on transparent background", () => {
    const classes = buttonVariants({ variant: "secondary" });
    expect(classes).toContain("text-ink-900");
    expect(classes).not.toContain("text-cream-50");
  });

  it("ghost variant uses ink-700 text", () => {
    const classes = buttonVariants({ variant: "ghost" });
    expect(classes).toContain("text-ink-700");
  });

  it("defaults to primary variant", () => {
    const classes = buttonVariants({});
    expect(classes).toContain("text-cream-50");
    expect(classes).toContain("bg-ink-900");
  });

  it("size sm applies correct height and padding", () => {
    const classes = buttonVariants({ size: "sm" });
    expect(classes).toContain("h-32");
    expect(classes).toContain("px-12");
  });

  it("size md applies correct height and padding", () => {
    const classes = buttonVariants({ size: "md" });
    expect(classes).toContain("h-40");
    expect(classes).toContain("px-16");
  });

  it("size lg applies correct height and padding", () => {
    const classes = buttonVariants({ size: "lg" });
    expect(classes).toContain("h-48");
    expect(classes).toContain("px-20");
  });
});
