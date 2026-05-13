"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
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
} from "@lapsed/ui";
import { Search } from "lucide-react";
import type { Conversation, ConversationTagTone } from "@lapsed/fixtures";

type TagFilter = "all" | ConversationTagTone;

export function ConversationsList({ conversations }: { conversations: Conversation[] }) {
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<TagFilter>("all");

  const filtered = useMemo(() => {
    return conversations.filter((c) => {
      const matchesSearch =
        search.length === 0 ||
        `${c.customerName} ${c.campaignName} ${c.preview}`
          .toLowerCase()
          .includes(search.toLowerCase());
      const matchesTag = tagFilter === "all" || c.tagTone === tagFilter;
      return matchesSearch && matchesTag;
    });
  }, [conversations, search, tagFilter]);

  return (
    <>
      <div className="flex items-center gap-12 border-b border-border p-16">
        <div className="relative flex-1">
          <Search
            strokeWidth={1.75}
            size={16}
            className="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 text-ink-300"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, campaign or message"
            className="pl-32"
            aria-label="Search conversations"
          />
        </div>
        <div className="w-[180px]">
          <Select value={tagFilter} onValueChange={(v) => setTagFilter(v as TagFilter)}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tags</SelectItem>
              <SelectItem value="converted">Converted</SelectItem>
              <SelectItem value="active">AI replying</SelectItem>
              <SelectItem value="stalled">Re-scheduled</SelectItem>
              <SelectItem value="churned">Opted out</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="text-meta text-ink-500">
          {filtered.length} of {conversations.length}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Campaign</TableHead>
            <TableHead>Latest message</TableHead>
            <TableHead>Last activity</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link
                  href={`/app/conversations/${c.id}`}
                  className="flex items-center gap-12 hover:text-ink-900"
                >
                  <Avatar initials={c.initials} size="sm" />
                  <span className="text-body-strong text-ink-900">{c.customerName}</span>
                </Link>
              </TableCell>
              <TableCell className="text-mini text-ink-500">{c.campaignName}</TableCell>
              <TableCell className="max-w-[280px] truncate text-mini text-ink-500">
                {c.preview}
              </TableCell>
              <TableCell className="text-mini text-ink-500">{c.time}</TableCell>
              <TableCell>
                <Tag tone={c.tagTone}>{c.tagLabel}</Tag>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
