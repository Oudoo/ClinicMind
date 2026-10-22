"use client";

import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDate, formatTime } from "@/lib/utils";
import type { ConsultationListItem, ConsultationStatus } from "@/modules/consultations/types";

export const STATUS_LABEL: Record<ConsultationStatus, string> = {
  RECORDING: "Recording",
  TRANSCRIBING: "Transcribing",
  EXTRACTING: "Extracting",
  PENDING_REVIEW: "Pending review",
  SIGNED: "Signed",
  DISCARDED: "Discarded",
};

export const STATUS_TONE: Record<ConsultationStatus, "default" | "accent" | "success" | "warning" | "danger"> = {
  RECORDING: "accent",
  TRANSCRIBING: "accent",
  EXTRACTING: "accent",
  PENDING_REVIEW: "warning",
  SIGNED: "success",
  DISCARDED: "default",
};

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

export function ConsultationList({
  items,
  total,
  loading,
  filter,
  selectedId,
  onFilterChange,
  onSelect,
  onNew,
}: {
  items: ConsultationListItem[];
  total: number;
  loading: boolean;
  filter: ListFilter;
  selectedId: string | null;
  onFilterChange: (filter: ListFilter) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const sorted = sortForReview(items);
  return (
    <Card className="flex flex-col p-0">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="font-display text-base font-semibold tracking-tight">Consultations</h2>
          <p className="text-xs text-muted-foreground">
            {total} {total === 1 ? "record" : "records"} · pending review first
          </p>
        </div>
        <Button type="button" size="sm" onClick={onNew}>
          <Plus />
          New consultation
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3">
        <Field label="Show" htmlFor="consultation-filter">
          <div className="relative">
            <Select
              id="consultation-filter"
              value={filter}
              onChange={(e) => onFilterChange(e.target.value as ListFilter)}
              className="h-9"
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>
        </Field>
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
                    <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                  </span>
                  <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <time dateTime={c.createdAt} suppressHydrationWarning>
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
        <div className="p-4">
          <EmptyState
            title={filter === "ALL" ? "No consultations yet" : "Nothing with this status"}
            hint="Start one with “New consultation”."
          />
        </div>
      )}
    </Card>
  );
}
