"use client";

import { useId } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * The reports' filters: doctor, treatment and lead source. Each choice
 * rewrites the URL (period and tab kept) and the server page recomputes every
 * metric; the filters each metric honours are listed on the Definitions tab.
 */
export function ReportFilters({
  basePath,
  params,
  doctors,
  treatments,
  sources,
  className,
}: {
  basePath: string;
  /** The current query entries (period, tab, filters). */
  params: Record<string, string>;
  doctors: FilterOption[];
  treatments: FilterOption[];
  sources: FilterOption[];
  className?: string;
}) {
  const router = useRouter();
  const id = useId();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`${basePath}?${next.toString()}`, { scroll: false });
  };
  const active = Boolean(params.doctorId || params.treatment || params.source);
  const clear = () => {
    const next = new URLSearchParams(params);
    for (const k of ["doctorId", "treatment", "source"]) next.delete(k);
    router.replace(`${basePath}?${next.toString()}`, { scroll: false });
  };

  const select = (key: string, label: string, options: FilterOption[], all: string) => (
    <label className="min-w-0 flex-1 space-y-1 sm:max-w-[14rem]">
      <span className="data-label block">{label}</span>
      <Select
        id={`${id}-${key}`}
        value={params[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
        className={cn("h-9", params[key] && "border-accent text-accent")}
      >
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </label>
  );

  return (
    <div className={cn("flex flex-wrap items-end gap-2", className)} role="group" aria-label="Filters">
      {select("doctorId", "Doctor", doctors, "All")}
      {select("treatment", "Treatment", treatments, "All")}
      {select("source", "Lead source", sources, "All")}
      {active ? (
        <button type="button" onClick={clear} className="inline-flex h-9 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
