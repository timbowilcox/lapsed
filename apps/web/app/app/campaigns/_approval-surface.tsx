"use client";

// Campaign approval surface (Sprint 06, chunk 9). Three states behind one
// modal: a pending-review list of proposal cards, a detail view of all three
// variants side-by-side, and an inline editor. Each proposal is one decision
// — approve, edit, or reject (design tenet 2). Nothing is sent until the
// merchant approves (decision 13).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  Panel,
  Tag,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  formatCount,
  formatDate,
} from "@lapsed/ui";
import type { PendingProposalSummary, ProposalVariant } from "@lapsed/db";
import {
  groupLabel,
  offerTypeLabel,
  sendWindowLabel,
  toneLabel,
  readImpact,
  money,
  restoredRange,
  MESSAGE_MAX,
  SEND_WINDOWS,
} from "./_labels";

type DetailMode = "view" | "edit" | "reject";

interface EditableVariant {
  messageDraft: string;
  offerValue: string;
  sendTimeWindow: string;
}

export function ApprovalSurface({ operatorId }: { operatorId: string }) {
  const [proposals, setProposals] = useState<PendingProposalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<DetailMode>("view");
  const [edits, setEdits] = useState<Record<number, EditableVariant>>({});
  const [rejectReason, setRejectReason] = useState("");

  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  const loadPending = useCallback(async () => {
    try {
      const res = await fetch("/api/campaigns/pending", { cache: "no-store" });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const body = (await res.json()) as { proposals: PendingProposalSummary[] };
      if (!mountedRef.current) return;
      setProposals(body.proposals);
      setLoadError(false);
    } catch {
      if (mountedRef.current) setLoadError(true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadPending();
    return () => {
      mountedRef.current = false;
    };
  }, [loadPending]);

  const selected = proposals.find((p) => p.proposalId === selectedId) ?? null;

  const openDetail = useCallback((proposal: PendingProposalSummary) => {
    setSelectedId(proposal.proposalId);
    setMode("view");
    setActionError(null);
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setMode("view");
    setEdits({});
    setRejectReason("");
    setActionError(null);
  }, []);

  const startEditing = useCallback((proposal: PendingProposalSummary) => {
    const initial: Record<number, EditableVariant> = {};
    for (const v of proposal.variants) {
      initial[v.variantIndex] = {
        messageDraft: v.messageDraft,
        offerValue: v.offerValue,
        sendTimeWindow: v.sendTimeWindow,
      };
    }
    setEdits(initial);
    setActionError(null);
    setMode("edit");
  }, []);

  // ── Mutations ────────────────────────────────────────────────────────────

  async function runAction(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    setActionPending(true);
    setActionError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!mountedRef.current) return false;
      if (!res.ok) {
        setActionError(
          res.status === 409
            ? "This campaign changed since you opened it. Refreshing the list."
            : "Something went wrong. Please try again.",
        );
        if (res.status === 409) {
          await loadPending();
          closeDetail();
        }
        return false;
      }
      return true;
    } catch {
      if (mountedRef.current) {
        setActionError("Something went wrong. Please try again.");
      }
      return false;
    } finally {
      if (mountedRef.current) setActionPending(false);
    }
  }

  const handleApprove = useCallback(async () => {
    if (!selected) return;
    const ok = await runAction(`/api/campaigns/${selected.proposalId}/approve`, {
      userId: operatorId,
    });
    if (ok) {
      await loadPending();
      closeDetail();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, operatorId, loadPending, closeDetail]);

  const handleReject = useCallback(async () => {
    if (!selected || rejectReason.trim().length === 0) return;
    const ok = await runAction(`/api/campaigns/${selected.proposalId}/reject`, {
      userId: operatorId,
      reason: rejectReason.trim(),
    });
    if (ok) {
      await loadPending();
      closeDetail();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, operatorId, rejectReason, loadPending, closeDetail]);

  const handleSaveEdits = useCallback(async () => {
    if (!selected) return;
    const editsPayload = selected.variants.map((v) => ({
      variantIndex: v.variantIndex,
      messageDraft: edits[v.variantIndex]?.messageDraft ?? v.messageDraft,
      offerValue: edits[v.variantIndex]?.offerValue ?? v.offerValue,
      sendTimeWindow: edits[v.variantIndex]?.sendTimeWindow ?? v.sendTimeWindow,
    }));
    const ok = await runAction(`/api/campaigns/${selected.proposalId}/edit`, {
      userId: operatorId,
      edits: editsPayload,
    });
    if (ok) {
      await loadPending();
      closeDetail();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, operatorId, edits, loadPending, closeDetail]);

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Panel>
        <div
          className="h-160 w-full rounded-lg bg-cream-200 motion-safe:animate-pulse"
          aria-label="Loading campaigns"
        />
      </Panel>
    );
  }

  if (loadError) {
    return (
      <Panel>
        <p className="p-24 text-body text-ink-700" role="alert">
          We couldn&apos;t load your campaigns. Please refresh the page.
        </p>
      </Panel>
    );
  }

  if (proposals.length === 0) {
    return (
      <Panel>
        <div className="flex flex-col items-center justify-center py-64 text-center">
          <p className="text-body-strong text-ink-900">No campaigns are waiting for review.</p>
          <p className="mt-8 max-w-md text-meta text-ink-500">
            When the agent finishes preparing a campaign for one of your customer groups, it will
            appear here for your approval.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-12">
        {proposals.map((proposal) => (
          <li key={proposal.proposalId}>
            <ProposalCard proposal={proposal} onOpen={() => openDetail(proposal)} />
          </li>
        ))}
      </ul>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
      >
        <DialogContent className="max-w-[920px]">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>{groupLabel(selected.groupSlug)}</DialogTitle>
                <DialogDescription>
                  {formatCount(selected.customerCount)} customers ·{" "}
                  {formatCount(selected.holdoutCount)} held back to measure lift · version{" "}
                  {selected.versionNumber}
                </DialogDescription>
              </DialogHeader>

              {mode === "view" && (
                <ProposalDetailView
                  variants={selected.variants}
                  onApprove={() => void handleApprove()}
                  onEdit={() => startEditing(selected)}
                  onReject={() => {
                    setRejectReason("");
                    setActionError(null);
                    setMode("reject");
                  }}
                  actionPending={actionPending}
                />
              )}

              {mode === "edit" && (
                <ProposalEditor
                  variants={selected.variants}
                  edits={edits}
                  onChange={(index, patch) =>
                    setEdits((prev) => ({
                      ...prev,
                      [index]: { ...prev[index]!, ...patch },
                    }))
                  }
                  onSave={() => void handleSaveEdits()}
                  onCancel={() => {
                    setMode("view");
                    setActionError(null);
                  }}
                  actionPending={actionPending}
                />
              )}

              {mode === "reject" && (
                <RejectConfirm
                  reason={rejectReason}
                  onReasonChange={setRejectReason}
                  onConfirm={() => void handleReject()}
                  onCancel={() => {
                    setMode("view");
                    setActionError(null);
                  }}
                  actionPending={actionPending}
                />
              )}

              {actionError && (
                <p className="mt-12 text-meta text-danger-500" role="alert">
                  {actionError}
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending-review card
// ─────────────────────────────────────────────────────────────────────────────

function ProposalCard({
  proposal,
  onOpen,
}: {
  proposal: PendingProposalSummary;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border border-border bg-cream-50 p-16 text-left transition-colors hover:bg-cream-100 focus-visible:outline-none focus-visible:shadow-focus"
    >
      <div className="flex items-start justify-between gap-16">
        <div>
          <div className="text-h3 text-ink-900">{groupLabel(proposal.groupSlug)}</div>
          <div className="mt-2 text-mini text-ink-500">
            {formatCount(proposal.customerCount)} customers · {formatCount(proposal.holdoutCount)}{" "}
            held back · prepared {formatDate(proposal.generatedAt, "short")}
          </div>
        </div>
        <div className="text-right">
          <div className="text-label text-ink-500">Est. restored revenue</div>
          <div className="text-body-strong text-ink-900">
            {restoredRange(proposal.variants.map((v) => v.expectedImpact))}
          </div>
        </div>
      </div>

      <div className="mt-12 flex flex-col gap-6">
        {proposal.variants.map((v) => (
          <div key={v.armId} className="flex flex-wrap items-center gap-6">
            <Tag tone="active">{offerTypeLabel(v.offerType)}</Tag>
            <Tag tone="stalled">{sendWindowLabel(v.sendTimeWindow)}</Tag>
            <Tag tone="stalled">{toneLabel(v.tone)}</Tag>
          </div>
        ))}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail view — three variants side-by-side
// ─────────────────────────────────────────────────────────────────────────────

function ProposalDetailView({
  variants,
  onApprove,
  onEdit,
  onReject,
  actionPending,
}: {
  variants: ProposalVariant[];
  onApprove: () => void;
  onEdit: () => void;
  onReject: () => void;
  actionPending: boolean;
}) {
  return (
    <div>
      <div className="grid grid-cols-1 gap-12 md:grid-cols-3">
        {variants.map((v, i) => {
          const impact = readImpact(v.expectedImpact);
          return (
            <Card key={v.armId} className="flex flex-col gap-8 p-16">
              <div className="text-micro uppercase text-ink-300">Variant {i + 1}</div>
              <div className="flex flex-wrap gap-6">
                <Tag tone="active">{offerTypeLabel(v.offerType)}</Tag>
                <Tag tone="stalled">{toneLabel(v.tone)}</Tag>
              </div>
              <div className="text-meta text-ink-500">
                {offerTypeLabel(v.offerType)}: {v.offerValue} · {sendWindowLabel(v.sendTimeWindow)}
              </div>
              <p className="rounded-sm bg-cream-100 p-10 text-body text-ink-900">
                {v.messageDraft}
              </p>
              <div className="text-mini text-ink-300">{v.messageDraft.length}/{MESSAGE_MAX} characters</div>
              <div className="mt-auto border-t border-border pt-8 text-mini text-ink-500">
                Est. response {Math.round(impact.rate * 100)}% · {money(impact.revenue)} restored
              </div>
            </Card>
          );
        })}
      </div>

      <div className="mt-20 flex items-center justify-end gap-8">
        <Button variant="ghost" onClick={onReject} disabled={actionPending}>
          Reject
        </Button>
        <Button variant="secondary" onClick={onEdit} disabled={actionPending}>
          Edit
        </Button>
        <Button onClick={onApprove} disabled={actionPending}>
          {actionPending ? "Working…" : "Approve campaign"}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor — message draft / offer value / send window are editable; offer type
// and tone are the agent's structural choices and are read-only.
// ─────────────────────────────────────────────────────────────────────────────

function ProposalEditor({
  variants,
  edits,
  onChange,
  onSave,
  onCancel,
  actionPending,
}: {
  variants: ProposalVariant[];
  edits: Record<number, EditableVariant>;
  onChange: (index: number, patch: Partial<EditableVariant>) => void;
  onSave: () => void;
  onCancel: () => void;
  actionPending: boolean;
}) {
  return (
    <div>
      <div className="flex flex-col gap-16">
        {variants.map((v, i) => {
          const edit = edits[v.variantIndex];
          if (!edit) return null;
          const overLimit = edit.messageDraft.length > MESSAGE_MAX;
          return (
            <Card key={v.armId} className="flex flex-col gap-10 p-16">
              <div className="flex items-center gap-6">
                <span className="text-micro uppercase text-ink-300">Variant {i + 1}</span>
                <Tag tone="stalled">{offerTypeLabel(v.offerType)}</Tag>
                <Tag tone="stalled">{toneLabel(v.tone)}</Tag>
              </div>

              <div>
                <label
                  htmlFor={`msg-${v.armId}`}
                  className="mb-4 block text-label text-ink-700"
                >
                  Message
                </label>
                <textarea
                  id={`msg-${v.armId}`}
                  value={edit.messageDraft}
                  maxLength={MESSAGE_MAX}
                  rows={3}
                  onChange={(e) => onChange(v.variantIndex, { messageDraft: e.target.value })}
                  className="w-full rounded-sm border border-cream-300 bg-cream-50 p-10 text-body text-ink-900 focus-visible:border-lavender-500 focus-visible:outline-none focus-visible:shadow-focus"
                />
                <div
                  className={
                    overLimit
                      ? "mt-2 text-mini text-danger-500"
                      : edit.messageDraft.length >= 150
                        ? "mt-2 text-mini text-warning-500"
                        : "mt-2 text-mini text-ink-300"
                  }
                >
                  {edit.messageDraft.length}/{MESSAGE_MAX} characters
                </div>
              </div>

              <div className="grid grid-cols-1 gap-10 md:grid-cols-2">
                <div>
                  <label
                    htmlFor={`offer-${v.armId}`}
                    className="mb-4 block text-label text-ink-700"
                  >
                    Offer value
                  </label>
                  <input
                    id={`offer-${v.armId}`}
                    value={edit.offerValue}
                    maxLength={64}
                    onChange={(e) => onChange(v.variantIndex, { offerValue: e.target.value })}
                    className="h-40 w-full rounded-sm border border-cream-300 bg-cream-50 px-12 text-body text-ink-900 focus-visible:border-lavender-500 focus-visible:outline-none focus-visible:shadow-focus"
                  />
                </div>
                <div>
                  <label
                    htmlFor={`window-${v.armId}`}
                    className="mb-4 block text-label text-ink-700"
                  >
                    Send-time window
                  </label>
                  <select
                    id={`window-${v.armId}`}
                    value={edit.sendTimeWindow}
                    onChange={(e) => onChange(v.variantIndex, { sendTimeWindow: e.target.value })}
                    className="h-40 w-full rounded-sm border border-cream-300 bg-cream-50 px-12 text-body text-ink-900 focus-visible:border-lavender-500 focus-visible:outline-none focus-visible:shadow-focus"
                  >
                    {SEND_WINDOWS.map((w) => (
                      <option key={w} value={w}>
                        {sendWindowLabel(w)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="mt-20 flex items-center justify-end gap-8">
        <Button variant="secondary" onClick={onCancel} disabled={actionPending}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={actionPending}>
          {actionPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reject confirmation — a reason is required
// ─────────────────────────────────────────────────────────────────────────────

function RejectConfirm({
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
  actionPending,
}: {
  reason: string;
  onReasonChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  actionPending: boolean;
}) {
  return (
    <div>
      <label htmlFor="reject-reason" className="mb-4 block text-label text-ink-700">
        Why are you rejecting this campaign?
      </label>
      <textarea
        id="reject-reason"
        value={reason}
        rows={3}
        maxLength={500}
        onChange={(e) => onReasonChange(e.target.value)}
        placeholder="A short note — this is kept with the campaign for your records."
        className="w-full rounded-sm border border-cream-300 bg-cream-50 p-10 text-body text-ink-900 placeholder:text-ink-300 focus-visible:border-lavender-500 focus-visible:outline-none focus-visible:shadow-focus"
      />
      <div className="mt-20 flex items-center justify-end gap-8">
        <Button variant="secondary" onClick={onCancel} disabled={actionPending}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={actionPending || reason.trim().length === 0}>
          {actionPending ? "Working…" : "Reject campaign"}
        </Button>
      </div>
    </div>
  );
}
