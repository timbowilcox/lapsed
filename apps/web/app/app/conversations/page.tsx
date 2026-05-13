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
        <ConversationsList conversations={conversations} />
      </Panel>
    </MerchantShell>
  );
}
