import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { Tag, type TagProps } from "./tag";

export interface ConversationRowProps extends HTMLAttributes<HTMLDivElement> {
  initials: string;
  name: string;
  time: string;
  preview: string;
  tagTone: NonNullable<TagProps["tone"]>;
  tagLabel: string;
}

export const ConversationRow = forwardRef<HTMLDivElement, ConversationRowProps>(
  function ConversationRow(
    { initials, name, time, preview, tagTone, tagLabel, className, ...props },
    ref,
  ) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex cursor-pointer items-start gap-12 border-b border-border px-22 py-14 transition-colors last:border-b-0 hover:bg-cream-100",
          className,
        )}
        {...props}
      >
        <div
          className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-pill bg-lavender-100 text-[11px] font-semibold uppercase text-lavender-700"
          aria-hidden="true"
        >
          {initials.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-baseline justify-between gap-12">
            <span className="text-meta font-semibold text-ink-900">{name}</span>
            <span className="flex-shrink-0 text-[11px] text-ink-300">{time}</span>
          </div>
          <div className="line-clamp-1 text-mini text-ink-500">{preview}</div>
          <Tag tone={tagTone} className="mt-4">
            {tagLabel}
          </Tag>
        </div>
      </div>
    );
  },
);
