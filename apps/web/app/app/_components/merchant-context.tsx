"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { SessionMerchant } from "@/app/lib/session";

const MerchantContext = createContext<SessionMerchant | null>(null);

export function MerchantContextProvider({
  merchant,
  children,
}: {
  merchant: SessionMerchant | null;
  children: ReactNode;
}) {
  return <MerchantContext.Provider value={merchant}>{children}</MerchantContext.Provider>;
}

/**
 * Read the authenticated merchant from context. Returns null when the
 * caller is on the install screen (no session yet).
 */
export function useMerchant(): SessionMerchant | null {
  return useContext(MerchantContext);
}
