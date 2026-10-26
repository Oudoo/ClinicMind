"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { EnrolmentStatus } from "@/modules/concierge/dto";
import { ENROLMENT_STATUS_TEXT } from "@/modules/concierge/labels";

export interface EnrolmentFilterState {
  status?: EnrolmentStatus;
  treatmentId?: string;
  q?: string;
}

const STATUSES: EnrolmentStatus[] = ["ACTIVE", "PAUSED", "COMPLETED", "STOPPED"];

/** Status chips with counts, a treatment picker and a patient search; every change rewrites the URL (the page filters server-side). */
export function EnrolmentFilters({
  filters,
  counts,
  treatments,
}: {
  filters: EnrolmentFilterState;
  counts: Record<EnrolmentStatus, number>;
  treatments: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const id = useId();
  const [q, setQ] = useState(filters.q ?? "");
  const first = useRef(true);

  function go(next: EnrolmentFilterState) {
    const params = new URLSearchParams({ tab: "enrolments" });
    if (next.status) params.set("status", next.status);
    if (next.treatmentId) params.set("treatmentId", next.treatmentId);
    if (next.q?.trim()) params.set("q", next.q.trim());
    router.push(`${pathname}?${params.toString()}`);
  }

  // Search as you type, a moment after the last key.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = window.setTimeout(() => go({ ...filters, q }), 350);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the search text drives this
  }, [q]);

  const total = STATUSES.reduce((sum, s) => sum + counts[s], 0);
  const chip = (active: boolean) =>
    cn(
      "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors",
      active ? "border-accent bg-accent-muted text-accent" : "border-border hover:bg-muted",
    );

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Status">
        <button type="button" className={chip(!filters.status)} onClick={() => go({ ...filters, status: undefined })} aria-pressed={!filters.status}>
          All <span className="font-mono text-xs tabular-nums text-muted-foreground">{total}</span>
        </button>
        {STATUSES.map((s) => (
          <button key={s} type="button" className={chip(filters.status === s)} onClick={() => go({ ...filters, status: s })} aria-pressed={filters.status === s}>
            {ENROLMENT_STATUS_TEXT[s]} <span className="font-mono text-xs tabular-nums text-muted-foreground">{counts[s]}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor={`${id}-treatment`} className="sr-only">
          Treatment
        </label>
        <Select id={`${id}-treatment`} className="sm:w-56" value={filters.treatmentId ?? ""} onChange={(e) => go({ ...filters, treatmentId: e.target.value || undefined })}>
          <option value="">All treatments</option>
          {treatments.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <div className="relative sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <label htmlFor={`${id}-q`} className="sr-only">
            Search patients
          </label>
          <Input id={`${id}-q`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Patient name or phone" className="pl-9 pr-9" maxLength={80} />
          {q ? (
            <button type="button" onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Clear the search">
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
