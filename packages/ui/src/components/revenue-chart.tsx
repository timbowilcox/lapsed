"use client";

import { useId } from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { formatCurrency } from "../lib/format";

export interface RevenueChartProps {
  data: Array<{ date: string; value: number }>;
  height?: number;
  range?: "auto" | "compact";
}

export function RevenueChart({ data, height = 280, range = "auto" }: RevenueChartProps) {
  const uid = useId();
  const gradId = `rev-grad-${uid.replace(/:/g, "")}`;
  const isCompact = range === "compact";

  const formattedData = data.map((d) => ({
    date: isCompact
      ? d.date
      : new Date(d.date).toLocaleDateString("en-AU", { month: "short", day: "numeric" }),
    value: d.value,
  }));

  if (isCompact) {
    return (
      <div style={{ height }} className="w-full">
        <ResponsiveContainer>
          <AreaChart data={formattedData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#9C85EE" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#9C85EE" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="value"
              stroke="#6B52C9"
              strokeWidth={2}
              fill={`url(#${gradId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <AreaChart data={formattedData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
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
            formatter={(v: number) => [formatCurrency(v * 100), "Restored"]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#6B52C9"
            strokeWidth={2}
            fill={`url(#${gradId})`}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
