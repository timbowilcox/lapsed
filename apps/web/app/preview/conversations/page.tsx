import { Panel, PanelHeader, PanelBody, ConversationRow } from "@lapsed/ui";
import Link from "next/link";
import { DemoShell } from "../_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";

export default function DemoConversationsPage() {
  const { conversations } = demoFixtures;

  return (
    <DemoShell>
      <div className="mb-24">
        <h1 className="mb-4 text-h1 text-ink-900">Conversations</h1>
        <p className="text-meta text-ink-500">
          Every two-way SMS thread the agent is running — one thread per customer, across all
          their campaigns.
        </p>
      </div>

      <Panel>
        <PanelHeader title={`${conversations.length} threads`} />
        <PanelBody>
          {conversations.map((c) => {
            const [first, ...rest] = c.customerName.split(" ");
            const last = rest.at(-1) ?? "";
            const display = last ? `${first} ${last.charAt(0)}.` : (first ?? c.customerName);
            return (
              <Link key={c.id} href={`/preview/conversations/${c.id}`} className="block">
                <ConversationRow
                  initials={c.initials}
                  name={display}
                  time={c.time}
                  preview={c.preview}
                  tagTone={c.tagTone}
                  tagLabel={c.tagLabel}
                />
              </Link>
            );
          })}
        </PanelBody>
      </Panel>
    </DemoShell>
  );
}
