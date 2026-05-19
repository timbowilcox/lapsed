import { describe, expect, it } from "vitest";
import { avatarVariants } from "./avatar";

describe("Avatar variants — contrast safety", () => {
  it("lavender tone uses lavender-50 background (not lavender-100)", () => {
    const classes = avatarVariants({ tone: "lavender" });
    expect(classes).toContain("bg-lavender-50");
    expect(classes).not.toContain("bg-lavender-100");
  });

  it("lavender tone uses lavender-700 text (4.5:1+ on lavender-50)", () => {
    const classes = avatarVariants({ tone: "lavender" });
    expect(classes).toContain("text-lavender-700");
  });

  it("ink tone uses cream-50 text on ink-900 background", () => {
    const classes = avatarVariants({ tone: "ink" });
    expect(classes).toContain("bg-ink-900");
    expect(classes).toContain("text-cream-50");
  });

  it("cream tone uses ink-700 text on cream-200 background", () => {
    const classes = avatarVariants({ tone: "cream" });
    expect(classes).toContain("bg-cream-200");
    expect(classes).toContain("text-ink-700");
  });

  it("defaults to lavender tone", () => {
    const classes = avatarVariants({});
    expect(classes).toContain("bg-lavender-50");
  });

  it("sm size applies correct dimensions", () => {
    const classes = avatarVariants({ size: "sm" });
    expect(classes).toContain("w-24");
    expect(classes).toContain("h-24");
  });
});
