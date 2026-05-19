import { describe, expect, it } from "vitest";
import { tagVariants } from "./tag";

describe("Tag variants — contrast safety", () => {
  it("converted tone uses ink-900 text on success-100 background (not success-500)", () => {
    const classes = tagVariants({ tone: "converted" });
    expect(classes).toContain("text-ink-900");
    expect(classes).not.toContain("text-success-500");
  });

  it("active tone uses lavender-50 background (not lavender-100)", () => {
    const classes = tagVariants({ tone: "active" });
    expect(classes).toContain("bg-lavender-50");
    expect(classes).not.toContain("bg-lavender-100");
  });

  it("active tone uses lavender-700 text (4.5:1+ on lavender-50)", () => {
    const classes = tagVariants({ tone: "active" });
    expect(classes).toContain("text-lavender-700");
  });

  it("churned tone uses danger-700 text on danger-100 background (not danger-500)", () => {
    const classes = tagVariants({ tone: "churned" });
    expect(classes).toContain("text-danger-700");
    expect(classes).not.toContain("text-danger-500");
  });

  it("stalled tone uses ink-500 on cream-200 (passing contrast)", () => {
    const classes = tagVariants({ tone: "stalled" });
    expect(classes).toContain("bg-cream-200");
    expect(classes).toContain("text-ink-500");
  });

  it("defaults to active tone", () => {
    const classes = tagVariants({});
    expect(classes).toContain("bg-lavender-50");
  });
});
