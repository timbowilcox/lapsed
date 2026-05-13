import type { ReactNode } from "react";
import { getMerchantFromSession } from "@/app/lib/session";
import { MerchantContextProvider } from "./_components/merchant-context";

export const dynamic = "force-dynamic";

export default async function MerchantLayout({
  children,
}: {
  children: ReactNode;
}) {
  // The install screen is itself under /app/auth/install. The layout
  // here applies to all merchant pages including that screen, so we
  // can't redirect from the layout without an infinite loop. Instead
  // each authenticated server component asserts on the merchant via
  // requireMerchant(); the install screen tolerates a null merchant
  // and renders the unauthenticated install prompt.
  const merchant = await getMerchantFromSession();
  return (
    <MerchantContextProvider merchant={merchant}>{children}</MerchantContextProvider>
  );
}
