"use client";

// Conversation list (Sprint 07, chunk 10). One row per customer thread.
// Search by customer name / message text; filter by status (unread, opted
// out) and by source campaign. Read-only browsing surface — the thread view
// is the detail page. Calm register (tenet 7): the unread marker is a quiet
// dot, never a red badge or a growing count.

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Panel,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  Tag,
  Avatar,
  formatRelativeTime,
} from "@lapsed/ui";
import { Search } from "lucide-react";
import type { ConversationListItem } from "@lapsed/db";
import { groupLabel } from "../campaigns/_labels";

type StatusFilter = "all" | "unread" | "opted_out";

/** Maps a classified inbound sentiment to a Vellum Tag tone. */
function sentimentTone(sentiment: string): "converted" | "stalled" | "churned" {
  if (sentiment === "positive") return "converted";
  if (sentiment === "negative") return "churned";
  return "stalled";
}

function sentimentLabel(sentiment: string): string {
  return sentiment.charAt(0).toUpperCase() + sentiment.slice(1);
}

/** Up-to-two-letter initials from a display name. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function ConversationsList({ items }: { items: ConversationListItem[] }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [campaign, setCampaign] = useState<string>("all");

  // Distinct source campaign slugs across every thread, for the filter.
  const campaignSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const item of items) for (const slug of item.sourceCampaignSlugs) set.add(slug);
    return Array.from(set).sort();
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      const matchesSearch =
        q.length === 0 ||
        item.customerName.toLowerCase().includes(q) ||
        item.latestPreview.toLowerCase().includes(q);
      const matchesStatus =
        status === "all" ||
        (status === "unread" && item.hasUnread) ||
        (status === "opted_out" && item.optedOut);
      const matchesCampaign =
        campaign === "all" || item.sourceCampaignSlugs.includes(campaign);
      return matchesSearch && matchesStatus && matchesCampaign;
    });
  }, [items, search, status, campaign]);

  if (items.length === 0) {
    return (
      <Panel>
        <div className="px-24 py-48 text-center">
          <p className="text-body text-ink-700">No conversations yet.</p>
          <p className="mt-4 text-meta text-ink-500">
            Threads appear here once an approved campaign sends its first message.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-12 border-b border-border p-16">
        <div className="relative min-w-[220px] flex-1">
          <Search
            strokeWidth={1.75}
            size={16}
            className="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 text-ink-300"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by customer name or message"
            className="pl-32"
            aria-label="Search conversations"
          />
        </div>
        <div className="w-[170px]">
          <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
            <SelectTrigger aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All threads</SelectItem>
              <SelectItem value="unread">Unread</SelectItem>
              <SelectItem value="opted_out">Opted out</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-[200px]">
          <Select value={campaign} onValueChange={setCampaign}>
            <SelectTrigger aria-label="Filter by campaign">
              <SelectValue placeholder="Campaign" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaigns</SelectItem>
              {campaignSlugs.map((slug) => (
                <SelectItem key={slug} value={slug}>
                  {groupLabel(slug)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="text-meta text-ink-500">
          {filtered.length} of {items.length}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="px-24 py-32 text-center text-meta text-ink-500">
          No conversations match these filters.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Latest message</TableHead>
              <TableHead>Campaigns</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>Latest reply</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((item) => (
              <TableRow key={item.conversationId}>
                <TableCell>
                  <Link
                    href={`/app/conversations/${item.conversationId}`}
                    className="flex items-center gap-12 hover:text-ink-900"
                  >
                    <Avatar initials={initialsOf(item.customerName)} size="sm" />
                    <span className="flex items-center gap-8">
                      <span className="text-body-strong text-ink-900">{item.customerName}</span>
                      {item.hasUnread && (
                        <>
                          <span
                            className="inline-block h-6 w-6 rounded-full bg-lavender-400"
                            aria-hidden="true"
                          />
                          <span className="sr-only">Unread reply</span>
                        </>
                      )}
                    </span>
                  </Link>
                </TableCell>
                <TableCell className="max-w-[300px] truncate text-mini text-ink-500">
                  {item.latestPreview || "—"}
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-4">
                    {item.sourceCampaignSlugs.length === 0 ? (
                      <span className="text-mini text-ink-400">—</span>
                    ) : (
                      item.sourceCampaignSlugs.map((slug) => (
                        <Tag key={slug} tone="active">
                          {groupLabel(slug)}
                        </Tag>
                      ))
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-mini text-ink-500">
                  {item.lastMessageAt ? formatRelativeTime(item.lastMessageAt) : "—"}
                </TableCell>
                <TableCell>
                  {item.optedOut ? (
                    <Tag tone="churned">Opted out</Tag>
                  ) : item.latestInboundSentiment ? (
                    <Tag tone={sentimentTone(item.latestInboundSentiment)}>
                      {sentimentLabel(item.latestInboundSentiment)}
                    </Tag>
                  ) : (
                    <span className="text-mini text-ink-400">No reply yet</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
