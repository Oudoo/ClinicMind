"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Search, UserRound } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CHANNELS, CHANNEL_LABELS, type ChannelKey } from "@/modules/crm/shared";
import { INBOX_FILTERS, INBOX_FILTER_LABELS, type InboxCountsDTO, type InboxFilterKey } from "@/modules/messaging/dto";
import { inboxHref, type InboxState } from "./inbox-shared";

const COUNT_OF: Partial<Record<InboxFilterKey, keyof InboxCountsDTO>> = { open: "open", waiting_clinic: "waitingClinic", waiting_patient: "waitingPatient", closed: "closed" };

/**
 * The inbox's list controls: the status queues with their counts, the
 * channel, "Mine" and a search over names and numbers. Each control rewrites
 * the URL; the server re-reads it. The selected thread is kept.
 */
export function InboxFilters({ state, counts }: { state: InboxState; counts: InboxCountsDTO }) {
  const router = useRouter();
  const id = useId();
  const [q, setQ] = useState(state.q ?? "");
  const go = (next: InboxState) => router.replace(inboxHref({ ...next, page: undefined }), { scroll: false });
  const status = state.status ?? "open";

  function onSearch(e: FormEvent) {
    e.preventDefault();
    go({ ...state, q: q.trim() || undefined });
  }

  return (
    <div className="space-y-3 border-b border-border p-3">
      <div className="flex flex-wrap gap-1" role="navigation" aria-label="Inbox queues">
        {INBOX_FILTERS.map((f) => {
          const count = COUNT_OF[f] ? counts[COUNT_OF[f]!] : null;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={status === f}
              onClick={() => go({ ...state, status: f })}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                status === f ? "border-accent bg-accent-muted text-accent" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {INBOX_FILTER_LABELS[f]}
              {count !== null ? <span className="font-mono text-[10px]">{count}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Select
          aria-label="Channel"
          value={state.channel ?? ""}
          onChange={(e) => go({ ...state, channel: (e.target.value || undefined) as ChannelKey | undefined })}
          className="h-8 min-w-0 flex-1 text-xs"
        >
          <option value="">All channels</option>
          {CHANNELS.filter((c) => c !== "IN_PERSON").map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
            </option>
          ))}
        </Select>
        <button
          type="button"
          aria-pressed={state.mine === "1"}
          onClick={() => go({ ...state, mine: state.mine === "1" ? undefined : "1" })}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors",
            state.mine === "1" ? "border-accent bg-accent-muted text-accent" : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
          Mine
        </button>
      </div>
      <form onSubmit={onSearch} role="search" className="relative">
        <label htmlFor={`${id}-q`} className="sr-only">
          Search conversations
        </label>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input id={`${id}-q`} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or number, then Enter" className="h-9 pl-9" />
      </form>
    </div>
  );
}

/** Re-reads the inbox every 30 seconds while the tab is visible, so new messages show up. */
export function InboxAutoRefresh({ everyMs = 30_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => window.clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
