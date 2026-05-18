import { notFound } from "next/navigation";
import { Panel, PanelHeader, PanelBody } from "@lapsed/ui";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { DemoShell } from "../../_components/demo-shell";
import { demoFixtures } from "@lapsed/core/demo-fixtures";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DemoConversationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const conversation = demoFixtures.conversations.find((c) => c.id === id);

  if (!conversation) notFound();

  return (
    <DemoShell>
      <div className="mb-24">
        <Link
          href="/preview/conversations"
          className="mb-12 inline-flex items-center gap-6 text-meta text-ink-500 hover:text-ink-900"
        >
          <ArrowLeft strokeWidth={1.75} size={14} />
          Conversations
        </Link>
        <h1 className="mb-4 text-h1 text-ink-900">{conversation.customerName}</h1>
        <p className="text-meta text-ink-500">
          {conversation.campaignName} · {conversation.tagLabel}
        </p>
      </div>

      <Panel>
        <PanelHeader title="Thread" />
        <PanelBody>
          <div className="flex flex-col gap-12 p-4">
            {conversation.messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "customer" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[70%] rounded-lg px-14 py-10 text-body ${
                    msg.role === "customer"
                      ? "bg-ink-900 text-cream-50"
                      : "border border-border bg-cream-50 text-ink-900"
                  }`}
                >
                  {msg.role === "ai" && (
                    <div className="mb-4 text-mini font-medium text-ink-500">Agent</div>
                  )}
                  {msg.role === "merchant" && (
                    <div className="mb-4 text-mini font-medium text-ink-500">You</div>
                  )}
                  <p>{msg.body}</p>
                </div>
              </div>
            ))}
          </div>
        </PanelBody>
      </Panel>

      {conversation.attributedRevenue && (
        <div className="mt-16 rounded-lg border border-border bg-cream-50 px-24 py-16">
          <div className="text-label text-ink-500">Restored revenue</div>
          <div className="mt-4 text-display tabular-nums text-success-500">
            ${conversation.attributedRevenue.toLocaleString("en-US")}
          </div>
          <div className="mt-4 text-mini text-ink-500">
            Order attributed to this conversation within the campaign window
          </div>
        </div>
      )}
    </DemoShell>
  );
}

export const dynamicParams = false;

export async function generateStaticParams() {
  return demoFixtures.conversations.map((c) => ({ id: c.id }));
}
