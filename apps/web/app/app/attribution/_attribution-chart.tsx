"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import type { AttributionDay } from "@lapsed/fixtures";
import { formatCurrency } from "@lapsed/ui";

export function AttributionChart({ byDay }: { byDay: AttributionDay[] }) {
  const data = byDay.map((d) => ({
    date: new Date(d.date).toLocaleDateString("en-AU", { month: "short", day: "numeric" }),
    revenue: d.recoveredRevenue,
    orders: d.recoveredOrders,
  }));

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <defs>
            <linearGradient id="attribution-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#9C85EE" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#9C85EE" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#ECE6D6" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="#94918A"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="#94918A"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => "$" + (v / 1000).toFixed(1) + "k"}
          />
          <Tooltip
            contentStyle={{
              background: "#FCFAF5",
              border: "1px solid #ECE6D6",
              borderRadius: 8,
              fontSize: 13,
            }}
            formatter={(v: number) => [formatCurrency(v * 100), "Recovered"]}
          />
          <Area
            type="monotone"
            dataKey="revenue"
            stroke="#6B52C9"
            strokeWidth={2}
            fill="url(#attribution-grad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
