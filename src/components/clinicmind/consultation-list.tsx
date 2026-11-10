"use client";

import { AudioLines, Ban, CheckCheck, Mic, PenLine, Plus, Sparkles, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge, Card, EmptyState, type Tone } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDate, formatNumber, formatTime } from "@/lib/utils";
import type { ConsultationListItem, ConsultationStatus } from "@/modules/consultations/types";

export const STATUS_LABEL: Record<ConsultationStatus, string> = {
  RECORDING: "Recording",
  TRANSCRIBING: "Transcribing",
  EXTRACTING: "Extracting",
  PENDING_REVIEW: "Pending review",
  SIGNED: "Signed",
  DISCARDED: "Discarded",
};

/**
 * How each status reads: its word, a mark of its own and a tone, so none is told by colour
 * alone. Amber is a draft waiting for a clinician's signature; the accent is a capture under way.
 */
const STATUS_STYLE: Record<ConsultationStatus, { tone: Tone; Icon: LucideIcon }> = {
  RECORDING: { tone: "accent", Icon: Mic },
  TRANSCRIBING: { tone: "accent", Icon: AudioLines },
  EXTRACTING: { tone: "accent", Icon: Sparkles },
  PENDING_REVIEW: { tone: "warning", Icon: PenLine },
  SIGNED: { tone: "success", Icon: CheckCheck },
  DISCARDED: { tone: "default", Icon: Ban },
};

/** The consultation's status as a chip: word, mark and tone, the same everywhere. */
export function ConsultationStatusBadge({ status, className }: { status: ConsultationStatus; className?: string }) {
  const { tone, Icon } = STATUS_STYLE[status];
  return (
    <Badge tone={tone} className={cn("gap-1", className)}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Drafts awaiting review first, then in-flight captures, then signed, then discarded. */
const STATUS_RANK: Record<ConsultationStatus, number> = {
  PENDING_REVIEW: 0,
  RECORDING: 1,
  TRANSCRIBING: 1,
  EXTRACTING: 1,
  SIGNED: 2,
  DISCARDED: 3,
};

export type ListFilter = "ALL" | "PENDING_REVIEW" | "SIGNED" | "DISCARDED";

const FILTERS: { value: ListFilter; label: string }[] = [
  { value: "ALL", label: "All consultations" },
  { value: "PENDING_REVIEW", label: "Pending review" },
  { value: "SIGNED", label: "Signed" },
  { value: "DISCARDED", label: "Discarded" },
];

export function sortForReview(items: ConsultationListItem[]): ConsultationListItem[] {
  return [...items].sort(
    (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.createdAt.localeCompare(a.createdAt),
  );
}

/** "9 drafts waiting to be signed · 286 in all": what the list holds, for the chosen filter. */
function countLine(filter: ListFilter, total: number, pending: number): string {
  const drafts = (n: number) => `${formatNumber(n)} ${n === 1 ? "draft" : "drafts"} waiting to be signed`;
  switch (filter) {
    case "PENDING_REVIEW":
      return drafts(total);
    case "SIGNED":
      return `${formatNumber(total)} signed`;
    case "DISCARDED":
      return `${formatNumber(total)} discarded`;
    default:
      return `${drafts(pending)} · ${formatNumber(total)} in all`;
  }
}

export function ConsultationList({
  items,
  total,
  pendingCount,
  loading,
  filter,
  selectedId,
  onFilterChange,
  onSelect,
  onNew,
}: {
  items: ConsultationListItem[];
  total: number;
  /** Drafts awaiting a clinician across the whole clinic (the list shows a page of them). */
  pendingCount?: number;
  loading: boolean;
  filter: ListFilter;
  selectedId: string | null;
  onFilterChange: (filter: ListFilter) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const sorted = sortForReview(items);
  const pending = pendingCount ?? items.filter((c) => c.status === "PENDING_REVIEW").length;
  return (
    <Card className="flex flex-col overflow-hidden p-0">
      {/* The filter is the list's heading: it says what the rows are. */}
      <div className="space-y-2 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="consultation-filter" className="sr-only">
            Show
          </label>
          <Select
            id="consultation-filter"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value as ListFilter)}
            className="h-9 min-w-0 flex-1 font-medium sm:max-w-[13rem]"
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
          <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onNew}>
            <Plus />
            New consultation
          </Button>
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">{countLine(filter, total, pending)}</p>
      </div>

      {loading ? (
        <div className="space-y-2 p-4" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : sorted.length ? (
        <ul className="max-h-[70vh] divide-y divide-border overflow-y-auto" aria-label="Consultations">
          {sorted.map((c) => {
            const selected = c.id === selectedId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={selected ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    selected && "bg-accent-muted/60",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.patient.fullName}</span>
                    <ConsultationStatusBadge status={c.status} className="shrink-0" />
                  </span>
                  <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <time dateTime={c.createdAt} suppressHydrationWarning className="shrink-0 tabular-nums">
                      {formatDate(c.createdAt)} · {formatTime(c.createdAt)}
                    </time>
                    {c.doctor?.fullName ? <span className="truncate">{c.doctor.fullName}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          inCard
          title={filter === "ALL" ? "No consultations yet" : "Nothing with this status"}
          hint={filter === "ALL" ? "Start one with “New consultation”." : "Choose another status above."}
        />
      )}
    </Card>
  );
}
