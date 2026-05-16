"use client";

// Merchant manual opt-out override (Sprint 07, chunk 11). Posts to the
// conversation opt-out route; on success the page is refreshed so the thread
// re-renders in its opted-out state. Calm register — a quiet secondary
// action, not a destructive-styled button.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, toast } from "@lapsed/ui";

export function OptOutButton({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function markOptedOut(): Promise<void> {
    setPending(true);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/opt-out`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(
          body.error === "no_phone"
            ? "This customer has no phone number on file."
            : "Could not record the opt-out. Please try again.",
        );
        return;
      }
      toast.success("Customer marked as opted out.");
      router.refresh();
    } catch {
      toast.error("Could not record the opt-out. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={markOptedOut} disabled={pending}>
      {pending ? "Recording…" : "Mark opt-out"}
    </Button>
  );
}
