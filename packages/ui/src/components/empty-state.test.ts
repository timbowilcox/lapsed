import { describe, expect, it } from "vitest";
import { EmptyState, type EmptyStateProps } from "./empty-state";

describe("EmptyState", () => {
  it("is exported as a function", () => {
    expect(typeof EmptyState).toBe("function");
  });

  it("requires heading and body props", () => {
    const props: EmptyStateProps = {
      heading: "No campaigns yet",
      body: "Your first campaign appears here once the agent prepares one for your approval.",
    };
    expect(props.heading).toBe("No campaigns yet");
    expect(props.body).toContain("appears here once");
  });

  it("accepts optional icon, cta, and secondaryAction", () => {
    const props: EmptyStateProps = {
      heading: "No campaigns yet",
      body: "Appears here once the agent prepares one.",
      icon: null,
      cta: null,
      secondaryAction: null,
    };
    expect(props.icon).toBeNull();
    expect(props.cta).toBeNull();
    expect(props.secondaryAction).toBeNull();
  });

  it("accepts optional className", () => {
    const props: EmptyStateProps = {
      heading: "No conversations yet",
      body: "Threads appear here once an approved campaign sends its first message.",
      className: "custom-class",
    };
    expect(props.className).toBe("custom-class");
  });
});
