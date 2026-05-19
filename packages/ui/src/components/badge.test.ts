import { describe, expect, it } from "vitest";
import { badgeVariants } from "./badge";

describe("Badge variants — contrast safety", () => {
  it("live tone uses ink-900 text on success-100 background (not success-500)", () => {
    const classes = badgeVariants({ tone: "live" });
    expect(classes).toContain("text-ink-900");
    expect(classes).not.toContain("text-success-500");
  });

  it("info tone uses lavender-50 background (not lavender-100)", () => {
    const classes = badgeVariants({ tone: "info" });
    expect(classes).toContain("bg-lavender-50");
    expect(classes).not.toContain("bg-lavender-100");
  });

  it("info tone uses lavender-700 text (4.5:1+ on lavender-50)", () => {
    const classes = badgeVariants({ tone: "info" });
    expect(classes).toContain("text-lavender-700");
  });

  it("paused tone uses ink-900 text on warning-100 background (not warning-500)", () => {
    const classes = badgeVariants({ tone: "paused" });
    expect(classes).toContain("text-ink-900");
    expect(classes).not.toContain("text-warning-500");
  });

  it("error tone uses danger-700 text on danger-100 background (not danger-500)", () => {
    const classes = badgeVariants({ tone: "error" });
    expect(classes).toContain("text-danger-700");
    expect(classes).not.toContain("text-danger-500");
  });

  it("neutral tone uses ink-700 on cream-200 (passing contrast)", () => {
    const classes = badgeVariants({ tone: "neutral" });
    expect(classes).toContain("bg-cream-200");
    expect(classes).toContain("text-ink-700");
  });

  it("defaults to neutral tone", () => {
    const classes = badgeVariants({});
    expect(classes).toContain("bg-cream-200");
  });
});
