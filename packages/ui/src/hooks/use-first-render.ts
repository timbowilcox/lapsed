"use client";

import { useEffect, useState } from "react";

/**
 * Returns true on the first render pass (before any effects run).
 * Switch to false after the component mounts.
 *
 * Use this to show a skeleton on the server/hydration pass and then
 * transition to real content once the client has mounted, preventing
 * hydration mismatches when content depends on client-only state.
 */
export function useFirstRender(): boolean {
  const [isFirst, setIsFirst] = useState(true);
  useEffect(() => {
    setIsFirst(false);
  }, []);
  return isFirst;
}
