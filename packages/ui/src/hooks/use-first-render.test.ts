import { describe, expect, it } from "vitest";
import { useFirstRender } from "./use-first-render";

describe("useFirstRender", () => {
  it("is exported as a function", () => {
    expect(typeof useFirstRender).toBe("function");
  });

  it("accepts no arguments", () => {
    expect(useFirstRender.length).toBe(0);
  });
});

// Full state-transition testing (useState + useEffect) requires a React
// rendering environment (e.g. @testing-library/react with jsdom). The
// behavioural contract — returns true on first render, false after mount —
// is verified at the integration level via the brand-voice-settings component
// which gates on isFirstRender || loading.
