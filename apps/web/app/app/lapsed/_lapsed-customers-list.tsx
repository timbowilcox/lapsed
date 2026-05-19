"use client";

import { useState, useMemo } from "react";
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
  Badge,
  Avatar,
  Tag,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  formatCurrency,
} from "@lapsed/ui";
import { Search, ChevronDown, Check } from "lucide-react";
import Link from "next/link";
import type { Database, CustomerInferredStateRow } from "@lapsed/db";

type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];
type LifecycleStage = Database["public"]["Enums"]["lifecycle_stage"];

export type LapsedCustomerListItem = Pick<
  CustomerRow,
  | "id"
  | "shopify_customer_gid"
  | "first_name"
  | "last_name"
  | "email"
  | "tags"
  | "total_order_count"
  | "total_ltv_cents"
  | "last_order_days_ago"
  | "lapsed_score"
> & {
  inferred_state: CustomerInferredStateRow | null;
};

type SortBy = "propensity_90d" | "last_order_days_ago" | "total_ltv_cents";

type BadgeTone = "neutral" | "live" | "draft" | "paused" | "error" | "info";

function lifecycleBadgeTone(stage: LifecycleStage | null): BadgeTone {
  switch (stage) {
    case "new": return "info";
    case "engaged": return "live";
    case "at_risk": return "paused";
    case "lapsed": return "info";
    case "won_back": return "live";
    case "churned": return "error";
    default: return "info";
  }
}

function lifecycleLabel(stage: LifecycleStage | null): string {
  switch (stage) {
    case "new": return "New";
    case "engaged": return "Engaged";
    case "at_risk": return "At Risk";
    case "lapsed": return "Lapsed";
    case "won_back": return "Won Back";
    case "churned": return "Churned";
    default: return "—";
  }
}

function getInitials(firstName: string | null, lastName: string | null, email: string | null): string {
  if (firstName && lastName) return (firstName[0]! + lastName[0]!).toUpperCase();
  if (firstName) return firstName.slice(0, 2).toUpperCase();
  if (email) return email[0]!.toUpperCase();
  return "?";
}

function shopifyNumericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function sortCustomers(
  customers: LapsedCustomerListItem[],
  sortBy: SortBy,
): LapsedCustomerListItem[] {
  return [...customers].sort((a, b) => {
    if (sortBy === "propensity_90d") {
      const ap = a.inferred_state?.propensity_90d ?? -1;
      const bp = b.inferred_state?.propensity_90d ?? -1;
      return bp - ap;
    }
    if (sortBy === "last_order_days_ago") {
      const ad = a.last_order_days_ago ?? Infinity;
      const bd = b.last_order_days_ago ?? Infinity;
      return ad - bd;
    }
    return (b.total_ltv_cents ?? 0) - (a.total_ltv_cents ?? 0);
  });
}

export function LapsedCustomersList({ customers }: { customers: LapsedCustomerListItem[] }) {
  const [search, setSearch] = useState("");
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortBy>("propensity_90d");

  // When groups are active, only propensity_90d sort is supported (query-layer constraint).
  const effectiveSortBy: SortBy = selectedGroups.size > 0 ? "propensity_90d" : sortBy;

  const allGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const c of customers) {
      for (const g of c.inferred_state?.group_memberships ?? []) {
        groups.add(g);
      }
    }
    return Array.from(groups).sort();
  }, [customers]);

  const filtered = useMemo(() => {
    const base = customers.filter((c) => {
      const fullName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
      const matchesSearch =
        search.length === 0 ||
        `${fullName} ${c.email ?? ""}`.toLowerCase().includes(search.toLowerCase());
      const matchesGroup =
        selectedGroups.size === 0 ||
        (c.inferred_state?.group_memberships ?? []).some((g) => selectedGroups.has(g));
      return matchesSearch && matchesGroup;
    });
    return sortCustomers(base, effectiveSortBy);
  }, [customers, search, selectedGroups, effectiveSortBy]);

  function toggleGroup(group: string) {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-12 border-b border-border p-16">
        <div className="relative min-w-0 flex-1">
          <Search
            strokeWidth={1.75}
            size={16}
            className="pointer-events-none absolute left-12 top-1/2 -translate-y-1/2 text-ink-300"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email"
            className="pl-32"
            aria-label="Search lapsed customers"
          />
        </div>

        {allGroups.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-[38px] items-center gap-6 rounded-md border border-border bg-cream-50 px-12 text-meta text-ink-700 hover:bg-cream-100"
                aria-label={
                  selectedGroups.size > 0
                    ? `Groups filter: ${selectedGroups.size} selected`
                    : "Filter by group"
                }
              >
                Groups
                {selectedGroups.size > 0 && (
                  <span className="rounded-pill bg-lavender-50 px-6 py-2 text-micro text-lavender-700">
                    {selectedGroups.size}
                  </span>
                )}
                <ChevronDown size={14} strokeWidth={1.75} className="text-ink-300" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {allGroups.map((group) => (
                <DropdownMenuItem
                  key={group}
                  role="menuitemcheckbox"
                  aria-checked={selectedGroups.has(group)}
                  onSelect={(e) => {
                    e.preventDefault();
                    toggleGroup(group);
                  }}
                >
                  <span className="flex items-center gap-8">
                    <span className="flex h-14 w-14 items-center justify-center rounded border border-border bg-cream-50">
                      {selectedGroups.has(group) && (
                        <Check size={10} strokeWidth={2.5} className="text-lavender-700" />
                      )}
                    </span>
                    {group}
                  </span>
                </DropdownMenuItem>
              ))}
              {selectedGroups.size > 0 && (
                <DropdownMenuItem
                  onSelect={() => setSelectedGroups(new Set())}
                  className="mt-4 border-t border-border"
                >
                  Clear filter
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="w-full sm:w-[200px]">
          <Select
            value={effectiveSortBy}
            onValueChange={(v) => setSortBy(v as SortBy)}
            disabled={selectedGroups.size > 0}
          >
            <SelectTrigger
              aria-label={
                selectedGroups.size > 0
                  ? "Sort: reorder likelihood only (clear group filter to change)"
                  : "Sort customers"
              }
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="propensity_90d">Highest reorder likelihood</SelectItem>
              <SelectItem value="last_order_days_ago">Most recent order</SelectItem>
              <SelectItem value="total_ltv_cents">Highest LTV</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="text-meta text-ink-500">
          Showing {filtered.length} of {customers.length}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Lifecycle</TableHead>
            <TableHead>Lifetime value</TableHead>
            <TableHead>Last order</TableHead>
            <TableHead>Reorder likelihood (90d)</TableHead>
            <TableHead>Groups / Signal</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((c) => {
            const initials = getInitials(c.first_name, c.last_name, c.email);
            const fullName =
              [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Unknown";
            const numericId = shopifyNumericId(c.shopify_customer_gid);
            const state = c.inferred_state;
            const pct90 =
              state?.propensity_90d != null ? Math.round(state.propensity_90d * 100) : null;

            return (
              <TableRow key={c.id}>
                <TableCell>
                  <Link
                    href={`/app/lapsed/${numericId}`}
                    className="flex items-center gap-12 hover:text-ink-900"
                  >
                    <Avatar initials={initials} size="sm" />
                    <div>
                      <div className="text-body-strong text-ink-900">{fullName}</div>
                      {c.email && <div className="text-mini text-ink-500">{c.email}</div>}
                    </div>
                  </Link>
                </TableCell>
                <TableCell>
                  {state?.lifecycle_stage ? (
                    <Badge tone={lifecycleBadgeTone(state.lifecycle_stage)}>
                      {lifecycleLabel(state.lifecycle_stage)}
                    </Badge>
                  ) : (
                    <span className="text-mini text-ink-300">—</span>
                  )}
                </TableCell>
                <TableCell>{formatCurrency(c.total_ltv_cents)}</TableCell>
                <TableCell>
                  {c.last_order_days_ago != null ? `${c.last_order_days_ago}d ago` : "—"}
                </TableCell>
                <TableCell>
                  {pct90 != null ? (
                    <div className="flex items-center gap-8">
                      <div
                        className="relative h-6 w-40 overflow-hidden rounded-pill bg-cream-200"
                        role="progressbar"
                        aria-valuenow={pct90}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${pct90}% likelihood to reorder within 90 days`}
                      >
                        <div
                          className="h-full rounded-pill bg-lavender-400"
                          style={{ width: `${pct90}%` }}
                        />
                      </div>
                      <span className="text-mini tabular-nums text-ink-500">~{pct90}%</span>
                    </div>
                  ) : (
                    <span className="text-mini text-ink-300">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {state?.group_memberships && state.group_memberships.length > 0 ? (
                    <div className="flex flex-wrap gap-4">
                      {state.group_memberships.slice(0, 2).map((g) => (
                        <Tag key={g} tone="active">
                          {g}
                        </Tag>
                      ))}
                      {state.group_memberships.length > 2 && (
                        <span className="text-micro text-ink-300">
                          +{state.group_memberships.length - 2}
                        </span>
                      )}
                    </div>
                  ) : state?.top_signal ? (
                    <span className="text-mini text-ink-500 line-clamp-1">{state.top_signal}</span>
                  ) : (
                    <span className="text-mini text-ink-300">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
