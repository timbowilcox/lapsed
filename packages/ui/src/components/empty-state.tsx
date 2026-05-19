import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface EmptyStateProps {
  /**
   * Optional Lucide icon or illustration — rendered in a decorative cream-200
   * circle. The circle is aria-hidden: the heading and body carry all meaning,
   * so the icon is not exposed to assistive tech and is exempt from text
   * contrast (it is a decorative graphic, not text).
   */
  icon?: ReactNode;
  /** Primary heading — what's missing. Keep to one short phrase. */
  heading: string;
  /** Explainer using when/then language: "X appears here once Y has happened." */
  body: string;
  /** Primary action — pass a Button/Link with full styles from the call site. */
  cta?: ReactNode;
  /** Secondary action — typically a plain underline link. */
  secondaryAction?: ReactNode;
  className?: string;
}

/**
 * Unified empty-state shell. Layout: icon → heading → body → cta → secondaryAction.
 *
 * Enforce when/then language in `body`: "Content appears here once trigger has happened."
 * Provide a `cta` that moves the merchant toward the trigger.
 *
 * Example:
 * ```tsx
 * <EmptyState
 *   heading="No campaigns yet"
 *   body="Your first campaign appears here once the agent prepares one for your approval."
 *   cta={
 *     <Button asChild variant="primary">
 *       <Link href="/app/campaigns/new">Create your first campaign</Link>
 *     </Button>
 *   }
 * />
 * ```
 */
export function EmptyState({ icon, heading, body, cta, secondaryAction, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-24 py-48 text-center",
        className,
      )}
    >
      {icon && (
        <div aria-hidden="true" className="mb-16 flex h-40 w-40 items-center justify-center rounded-full bg-cream-200 text-ink-300">
          {icon}
        </div>
      )}
      <h3 className="text-h3 text-ink-900">{heading}</h3>
      <p className="mt-8 max-w-sm text-meta text-ink-500">{body}</p>
      {cta && <div className="mt-20">{cta}</div>}
      {secondaryAction && <div className="mt-12">{secondaryAction}</div>}
    </div>
  );
}
