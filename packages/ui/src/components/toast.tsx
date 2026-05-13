"use client";

import { Toaster as SonnerToaster, toast } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      toastOptions={{
        unstyled: false,
        classNames: {
          toast:
            "rounded-md bg-ink-900 text-cream-50 px-16 py-12 text-body shadow-none border-none",
          description: "text-cream-100",
          actionButton: "bg-lavender-400 text-ink-900",
        },
      }}
    />
  );
}

export { toast };
