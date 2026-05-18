"use client";

import { useEffect, useState } from "react";

/**
 * Returns `true` during SSR and the initial hydration render, then `false`
 * after the component has mounted. Use this to show a skeleton during the
 * hydration pass and transition to real content once client state is
 * available, preventing hydration mismatches.
 */
export function useFirstRender(): boolean {
  const [isFirst, setIsFirst] = useState(true);
  useEffect(() => {
    setIsFirst(false);
  }, []);
  return isFirst;
}
