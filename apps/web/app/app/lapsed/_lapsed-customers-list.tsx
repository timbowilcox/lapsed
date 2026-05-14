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
import type { LapsedCustomer, CustomerTier } from "@lapsed/fixtures";

type TierFilter = "all" | CustomerTier;

export function LapsedCustomersList({ customers }: { customers: LapsedCustomer[] }) {
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");

  const filtered = useMemo(() => {
    return customers.filter((c) => {
      const matchesSearch =
        search.length === 0 ||
        `${c.firstName} ${c.lastName} ${c.email} ${c.city}`
          .toLowerCase()
          .includes(search.toLowerCase());
      const matchesTier = tierFilter === "all" || c.tier === tierFilter;
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
            placeholder="Search by name, email or city"
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
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((c) => (
            <TableRow key={c.id}>
              <TableCell>
                <Link
                  href={`/app/lapsed/${c.id}`}
                  className="flex items-center gap-12 hover:text-ink-900"
                >
                  <Avatar initials={c.initials} size="sm" />
                  <div>
                    <div className="text-body-strong text-ink-900">
                      {c.firstName} {c.lastName}
                    </div>
                    <div className="text-mini text-ink-500">
                      {c.email} · {c.city}
                    </div>
                  </div>
                </Link>
              </TableCell>
              <TableCell>
                <Badge tone={c.tier === "vip" ? "info" : "neutral"}>
                  {c.tier === "vip" ? "VIP" : c.tier === "repeat" ? "Repeat" : "New"}
                </Badge>
              </TableCell>
              <TableCell>
                {formatCurrency(Math.round(c.lifetimeValue * 100))}
              </TableCell>
              <TableCell>{c.lastOrderDaysAgo} days ago</TableCell>
              <TableCell>{c.cadenceDays > 0 ? `${c.cadenceDays} d` : "—"}</TableCell>
              <TableCell>
                <span className="font-semibold tabular-nums">
                  {c.reactivationScore.toFixed(2)}
                </span>
              </TableCell>
              <TableCell>
                <Badge
                  tone={
                    c.status === "reactivating"
                      ? "live"
                      : c.status === "churned"
                        ? "error"
                        : "neutral"
                  }
                >
                  {c.status === "reactivating" ? "Reactivating" : c.status === "churned" ? "Churned" : "Lapsed"}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
