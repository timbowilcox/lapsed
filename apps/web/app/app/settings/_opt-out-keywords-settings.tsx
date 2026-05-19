"use client";

// Always-editable opt-out keyword panel (Chunk 6).
//
// Two sections:
//  1. Opt-out detection keywords — inbound SMS matching any of these opts the
//     customer out immediately. STOP and STOPALL are Twilio-reserved and shown
//     as non-removable. Merchant-configured extras are removable.
//  2. Agent draft defaults — words the agent is instructed to include in
//     outbound drafts so customers always have an opt-out path.
//
// Edit pattern: always-editable + inline auto-save. One keyword changes at a
// time (add or remove); each change writes immediately to the API. Errors are
// shown inline; no explicit Save button needed.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { X, Plus, Check } from "lucide-react";
import { TWILIO_RESERVED } from "../../api/settings/opt-out-keywords/_validate";

interface OptOutConfig {
  optOutKeywords: string[];
  agentDraftDefaults: string[];
}

type ListName = "opt_out_keywords" | "agent_draft_defaults";

// ── Keyword tag ───────────────────────────────────────────────────────────────

function KeywordTag({
  keyword,
  removable,
  onRemove,
  removing,
}: {
  keyword: string;
  removable: boolean;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-4 rounded-full border border-cream-300 bg-cream-100 px-10 py-4 text-meta text-ink-700">
      {keyword}
      {removable && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          aria-label={`Remove ${keyword}`}
          className="ml-2 flex h-16 w-16 items-center justify-center rounded-full text-ink-400 hover:bg-cream-200 hover:text-ink-700 focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-50"
        >
          <X size={10} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

// ── Keyword add row ───────────────────────────────────────────────────────────

function AddKeywordRow({
  listName,
  onAdd,
  inputRef: externalInputRef,
}: {
  listName: ListName;
  onAdd: (keyword: string) => Promise<string | null>;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? localRef;

  const handleAdd = useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    setError(null);
    const err = await onAdd(trimmed);
    setSaving(false);
    if (err) {
      setError(err);
    } else {
      setValue("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      inputRef.current?.focus();
    }
  }, [value, onAdd, inputRef]);

  const inputId = `add-${listName}`;

  return (
    <div className="mt-8 flex flex-col gap-4">
      <div className="flex items-center gap-8">
        <label htmlFor={inputId} className="sr-only">
          Add keyword
        </label>
        <input
          ref={inputRef}
          id={inputId}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAdd();
          }}
          placeholder="Add a keyword…"
          maxLength={30}
          aria-describedby={error ? `${inputId}-error` : undefined}
          aria-invalid={error ? true : undefined}
          className="h-32 w-[180px] rounded-sm border border-cream-300 bg-cream-50 px-10 text-meta text-ink-900 placeholder:text-ink-400 focus-visible:border-lavender-500 focus-visible:outline-none focus-visible:shadow-focus"
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={saving || value.trim().length === 0}
          aria-label="Add keyword"
          className="flex h-32 w-32 items-center justify-center rounded-sm border border-cream-300 bg-cream-50 text-ink-500 hover:bg-cream-100 hover:text-ink-900 focus-visible:outline-none focus-visible:shadow-focus disabled:pointer-events-none disabled:opacity-40"
        >
          {saved ? (
            <Check size={14} strokeWidth={2.5} className="text-green-600" aria-hidden="true" />
          ) : (
            <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
          )}
        </button>
      </div>
      {error && (
        <p id={`${inputId}-error`} role="alert" className="text-mini text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}

// ── Keyword list section ──────────────────────────────────────────────────────

function KeywordSection({
  title,
  description,
  keywords,
  listName,
  reservedSet,
  onMutate,
}: {
  title: string;
  description: string;
  keywords: string[];
  listName: ListName;
  reservedSet: ReadonlySet<string>;
  onMutate: (list: ListName, action: "add" | "remove", keyword: string) => Promise<string | null>;
}) {
  const [removingKeyword, setRemovingKeyword] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  const handleRemove = useCallback(
    async (keyword: string) => {
      setRemovingKeyword(keyword);
      setRemoveError(null);
      const err = await onMutate(listName, "remove", keyword);
      setRemovingKeyword(null);
      if (err) {
        setRemoveError(err);
      } else {
        // Move focus to the add input so the user doesn't lose their place in
        // the DOM after the remove button is unmounted (WCAG 2.4.3).
        addInputRef.current?.focus();
      }
    },
    [listName, onMutate],
  );

  const handleAdd = useCallback(
    async (keyword: string): Promise<string | null> => {
      setRemoveError(null);
      return onMutate(listName, "add", keyword);
    },
    [listName, onMutate],
  );

  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="text-label text-ink-700">{title}</p>
        <p className="mt-2 text-mini text-ink-500">{description}</p>
      </div>
      <div className="flex flex-wrap gap-6">
        {keywords.map((kw) => {
          const isReserved = reservedSet.has(kw.toUpperCase());
          return (
            <KeywordTag
              key={kw}
              keyword={kw}
              removable={!isReserved}
              onRemove={() => void handleRemove(kw)}
              removing={removingKeyword === kw}
            />
          );
        })}
        {keywords.length === 0 && (
          <span className="text-mini text-ink-400">No keywords yet.</span>
        )}
      </div>
      {removeError && (
        <p role="alert" className="text-mini text-danger-700">
          {removeError}
        </p>
      )}
      <AddKeywordRow listName={listName} onAdd={handleAdd} inputRef={addInputRef} />
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export function OptOutKeywordsSettings() {
  const [config, setConfig] = useState<OptOutConfig | null>(null);
  const [loadError, setLoadError] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    fetch("/api/settings/opt-out-keywords", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data: OptOutConfig) => {
        if (mountedRef.current) setConfig(data);
      })
      .catch(() => {
        if (mountedRef.current) setLoadError(true);
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutate = useCallback(
    async (list: ListName, action: "add" | "remove", keyword: string): Promise<string | null> => {
      try {
        const res = await fetch("/api/settings/opt-out-keywords", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ list, action, keyword }),
        });
        const body = (await res.json()) as OptOutConfig & { error?: string };
        if (!mountedRef.current) return null;
        if (!res.ok) {
          return body.error ?? "Something went wrong. Please try again.";
        }
        setConfig(body);
        return null;
      } catch {
        return "Something went wrong. Please try again.";
      }
    },
    [],
  );

  const reservedSet = new Set(TWILIO_RESERVED);

  if (loadError) {
    return (
      <p className="text-meta text-ink-700" role="alert">
        Keyword settings couldn&apos;t be loaded. Please refresh the page.
      </p>
    );
  }

  if (!config) {
    return (
      <div
        role="status"
        aria-label="Loading keyword settings"
        className="flex flex-col gap-12 motion-safe:animate-pulse"
      >
        <div className="h-10 w-40 rounded bg-cream-300" />
        <div className="flex gap-6">
          <div className="h-24 w-[56px] rounded-full bg-cream-300" />
          <div className="h-24 w-[72px] rounded-full bg-cream-300" />
          <div className="h-24 w-[48px] rounded-full bg-cream-300" />
        </div>
        <div className="mt-8 h-10 w-40 rounded bg-cream-300" />
        <div className="flex gap-6">
          <div className="h-24 w-[60px] rounded-full bg-cream-300" />
          <div className="h-24 w-[80px] rounded-full bg-cream-300" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-20">
      <KeywordSection
        title="Opt-out detection keywords"
        description="Any inbound message matching these (case-insensitive) opts the customer out immediately. STOP and STOPALL are Twilio-reserved and cannot be removed."
        keywords={config.optOutKeywords}
        listName="opt_out_keywords"
        reservedSet={reservedSet}
        onMutate={mutate}
      />
      <div className="border-t border-border" />
      <KeywordSection
        title="Agent draft defaults"
        description="The agent includes one of these words in outbound drafts so customers always know how to opt out."
        keywords={config.agentDraftDefaults}
        listName="agent_draft_defaults"
        reservedSet={new Set()}
        onMutate={mutate}
      />
    </div>
  );
}
