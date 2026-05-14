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
  formatCurrency,
} from "@lapsed/ui";
import { Search } from "lucide-react";
import Link from "next/link";
import type { Database } from "@lapsed/db";

type CustomerRow = Database["public"]["Tables"]["customers"]["Row"];

// Narrow type — excludes phone and other PII not needed by the list UI
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
>;

type TierFilter = "all" | "vip" | "repeat" | "new";

function getInitials(firstName: string | null, lastName: string | null, email: string | null): string {
  if (firstName && lastName) return (firstName[0]! + lastName[0]!).toUpperCase();
  if (firstName) return firstName.slice(0, 2).toUpperCase();
  if (email) return email[0]!.toUpperCase();
  return "?";
}

function deriveTier(tags: string[], orderCount: number): "vip" | "repeat" | "new" {
  if (tags.some((t) => t.trim().toLowerCase() === "vip")) return "vip";
  if (orderCount > 1) return "repeat";
  return "new";
}

function shopifyNumericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

export function LapsedCustomersList({ customers }: { customers: LapsedCustomerListItem[] }) {
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");

  const filtered = useMemo(() => {
    return customers.filter((c) => {
      const fullName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim();
      const matchesSearch =
        search.length === 0 ||
        `${fullName} ${c.email ?? ""}`.toLowerCase().includes(search.toLowerCase());
      const tier = deriveTier(c.tags, c.total_order_count);
      const matchesTier = tierFilter === "all" || tier === tierFilter;
      return matchesSearch && matchesTier;
    });
  }, [customers, search, tierFilter]);

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
            placeholder="Search by name or email"
            className="pl-32"
            aria-label="Search lapsed customers"
          />
        </div>
        <div className="w-[200px]">
          <Select value={tierFilter} onValueChange={(v) => setTierFilter(v as TierFilter)}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by tier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tiers</SelectItem>
              <SelectItem value="vip">VIP</SelectItem>
              <SelectItem value="repeat">Repeat</SelectItem>
              <SelectItem value="new">New buyer</SelectItem>
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
            <TableHead>Tier</TableHead>
            <TableHead>Lifetime value</TableHead>
            <TableHead>Last order</TableHead>
            <TableHead>Cadence</TableHead>
            <TableHead>Score</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((c) => {
            const initials = getInitials(c.first_name, c.last_name, c.email);
            const fullName = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Unknown";
            const tier = deriveTier(c.tags, c.total_order_count);
            const numericId = shopifyNumericId(c.shopify_customer_gid);

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
                      {c.email && (
                        <div className="text-mini text-ink-500">{c.email}</div>
                      )}
                    </div>
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge tone={tier === "vip" ? "info" : "neutral"}>
                    {tier === "vip" ? "VIP" : tier === "repeat" ? "Repeat" : "New"}
                  </Badge>
                </TableCell>
                <TableCell>
                  {formatCurrency(c.total_ltv_cents)}
                </TableCell>
                <TableCell>
                  {c.last_order_days_ago != null ? `${c.last_order_days_ago} days ago` : "—"}
                </TableCell>
                <TableCell>—</TableCell>
                <TableCell>
                  <span className="font-semibold tabular-nums">
                    {c.lapsed_score != null ? c.lapsed_score.toFixed(2) : "—"}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
