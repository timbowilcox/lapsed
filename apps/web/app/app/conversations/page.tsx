import { Panel } from "@lapsed/ui";
import { conversations } from "@lapsed/fixtures";
import { MerchantShell } from "../_components/merchant-shell";
import { ConversationsList } from "./_conversations-list";

export default function ConversationsPage() {
  return (
    <MerchantShell pageTitle="Conversations">
      <div className="mb-24">
        <h2 className="mb-4 text-h1 text-ink-900">Conversations</h2>
        <p className="text-meta text-ink-500">
          Two-way threads from active campaigns. Filter by tag, status or date.
        </p>
      </div>
      <Panel>
        <div className="flex items-center gap-8 border-b border-border px-16 py-10">
          <span className="text-mini text-ink-400">[demo data] — real conversations in Sprint 06</span>
        </div>
        <ConversationsList conversations={conversations} />
      </Panel>
    </MerchantShell>
  );
}
