"use client";

import * as Primitive from "@radix-ui/react-dropdown-menu";
import { type ReactNode } from "react";
import { cn } from "../lib/cn";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;

export function DropdownMenuContent({
  children,
  className,
  align = "end",
  sideOffset = 8,
  ...props
}: Primitive.DropdownMenuContentProps & { children: ReactNode }) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-[200px] overflow-hidden rounded-md border border-border bg-cream-50 p-4 shadow-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          "data-[side=bottom]:slide-in-from-top-2",
          className,
        )}
        {...props}
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DropdownMenuItem({
  children,
  className,
  disabled,
  onSelect,
  ...props
}: Primitive.DropdownMenuItemProps & { children: ReactNode }) {
  return (
    <Primitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-center rounded px-8 py-6 text-body text-ink-700 outline-none",
        "transition-colors hover:bg-cream-200 focus:bg-cream-200",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </Primitive.Item>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return (
    <Primitive.Separator className={cn("my-4 h-px bg-border", className)} />
  );
}
