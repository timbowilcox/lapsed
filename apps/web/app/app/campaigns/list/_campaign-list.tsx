"use client";

// Campaign list (Sprint 06, chunk 10). Four tabs over the merchant's full
// proposal set, plus a group-name search. Read-only browsing surface —
// approving / rejecting / editing happens on the approval surface
// (/app/campaigns). An approved campaign links through to its bandit-state
// inspector.

import { useState } from "react";
import Link from "next/link";
import {
  Panel,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Tag,
  Input,
  formatDate,
} from "@lapsed/ui";
import type { CampaignListItem, CampaignProposalStatus } from "@lapsed/db";
import { groupLabel } from "../_labels";

type TabValue = "pending" | "approved" | "rejected" | "all";

const TABS: ReadonlyArray<{ value: TabValue; label: string }> = [
  { value: "pending", label: "Pending review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

const STATUS_META: Record<
  CampaignProposalStatus,
  { label: string; tone: "converted" | "active" | "stalled" }
> = {
  proposed: { label: "Pending review", tone: "active" },
  approved: { label: "Approved", tone: "converted" },
  rejected: { label: "Rejected", tone: "stalled" },
  edited: { label: "Edited", tone: "stalled" },
};

function matchesTab(status: CampaignProposalStatus, tab: TabValue): boolean {
  if (tab === "all") return true;
  if (tab === "pending") return status === "proposed";
  return status === tab;
}

export function CampaignList({ items }: { items: CampaignListItem[] }) {
  const [search, setSearch] = useState("");

  const query = search.trim().toLowerCase();
  const visible = (tab: TabValue): CampaignListItem[] =>
    items.filter(
      (item) =>
        matchesTab(item.status, tab) &&
        (query === "" || groupLabel(item.groupSlug).toLowerCase().includes(query)),
    );

  return (
    <div className="flex flex-col gap-16">
      <div className="max-w-sm">
        <label htmlFor="campaign-search" className="mb-4 block text-label text-ink-700">
          Search by group
        </label>
        <Input
          id="campaign-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Group name…"
        />
      </div>

      <Tabs defaultValue="pending">
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {TABS.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            <CampaignCards items={visible(t.value)} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function CampaignCards({ items }: { items: CampaignListItem[] }) {
  if (items.length === 0) {
    return (
      <Panel>
        <p className="px-16 py-40 text-center text-meta text-ink-500">
          No campaigns here yet.
        </p>
      </Panel>
    );
  }

  return (
    <ul className="flex flex-col gap-8">
      {items.map((item) => (
        <li key={item.proposalId}>
          <CampaignCard item={item} />
        </li>
      ))}
    </ul>
  );
}

function CampaignCard({ item }: { item: CampaignListItem }) {
  const meta = STATUS_META[item.status];
  const body = (
    <div className="flex items-start justify-between gap-16">
      <div>
        <div className="flex items-center gap-8">
          <span className="text-h3 text-ink-900">{groupLabel(item.groupSlug)}</span>
          <Tag tone={meta.tone}>{meta.label}</Tag>
        </div>
        <div className="mt-2 text-mini text-ink-500">
          {item.variantCount} variants · version {item.versionNumber} · prepared{" "}
          {formatDate(item.generatedAt, "short")}
        </div>
        {item.status === "approved" && item.approvedAt && (
          <div className="mt-2 text-mini text-ink-500">
            Approved {formatDate(item.approvedAt, "short")}
          </div>
        )}
        {item.status === "rejected" && item.rejectionReason && (
          <div className="mt-2 text-mini text-ink-500">Reason: {item.rejectionReason}</div>
        )}
      </div>
    </div>
  );

  // An approved campaign links through to its bandit-state inspector; other
  // statuses are display-only on this surface.
  if (item.status === "approved") {
    return (
      <Link
        href={`/app/campaigns/${item.proposalId}/bandit`} /* vocab:allow — URL route path, not user-visible text */
        className="block rounded-md border border-border bg-cream-50 p-16 transition-colors hover:bg-cream-100 focus-visible:outline-none focus-visible:shadow-focus"
      >
        {body}
      </Link>
    );
  }

  return (
    <div className="rounded-md border border-border bg-cream-50 p-16">{body}</div>
  );
}
