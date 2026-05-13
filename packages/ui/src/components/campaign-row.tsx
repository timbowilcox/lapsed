import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { StatusDot } from "./status-dot";

export type CampaignStatus = "live" | "draft" | "paused" | "error";

export interface CampaignRowProps extends HTMLAttributes<HTMLDivElement> {
  name: string;
  meta: string;
  status: CampaignStatus;
  statusLabel: string;
  revenue?: string;
  revenueLabel?: string;
}

export const CampaignRow = forwardRef<HTMLDivElement, CampaignRowProps>(function CampaignRow(
  {
    name,
    meta,
    status,
    statusLabel,
    revenue = "—",
    revenueLabel = "recovered",
    className,
    ...props
  },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "grid cursor-pointer grid-cols-[1fr_auto_auto] items-center gap-16 border-b border-border px-22 py-16 transition-colors last:border-b-0 hover:bg-cream-100",
        className,
      )}
      {...props}
    >
      <div>
        <div className="mb-4 text-body-strong text-ink-900">{name}</div>
        <div className="text-mini text-ink-500">{meta}</div>
      </div>
      <StatusDot status={status} label={statusLabel} />
      <div className="text-right">
        <div className="text-body-strong font-semibold text-ink-900 tabular-nums">{revenue}</div>
        <div className="text-[11px] text-ink-500">{revenueLabel}</div>
      </div>
    </div>
  );
});
