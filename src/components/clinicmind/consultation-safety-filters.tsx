"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PERIOD_PRESETS, PRESET_LABELS, type PeriodPreset } from "@/modules/reporting/period";

/**
 * Filters of the safety-override review list: doctor (owner only), severity
 * and period. Each choice rewrites the URL; the server page re-reads it. The
 * CSV export link carries the same filters.
 */
export function SafetyOverrideFilters({
  params,
  doctors,
  preset,
  fromKey,
  toKey,
}: {
  /** The current query entries (filters and period). */
  params: Record<string, string>;
  /** Empty for a doctor, who only ever sees their own. */
  doctors: { id: string; fullName: string }[];
  preset: PeriodPreset;
  fromKey: string;
  toKey: string;
}) {
  const router = useRouter();
  const id = useId();
  const [custom, setCustom] = useState(preset === "custom");
  const [from, setFrom] = useState(fromKey);
  const [to, setTo] = useState(toKey);
  const [error, setError] = useState<string | null>(null);

  const go = (entries: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(entries)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("page");
    const qs = next.toString();
    router.replace(qs ? `/dashboard/safety?${qs}` : "/dashboard/safety", { scroll: false });
  };

  const choosePeriod = (value: string) => {
    if (value === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    go({ period: value, from: null, to: null });
  };

  const applyCustom = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      setError("Choose both dates.");
      return;
    }
    if (to < from) {
      setError("The end date is before the start date.");
      return;
    }
    setError(null);
    go({ period: "custom", from, to });
  };

  const exportQuery = new URLSearchParams(params);
  exportQuery.delete("page");
  const exportHref = `/api/safety-overrides/export${exportQuery.toString() ? `?${exportQuery.toString()}` : ""}`;
  const filtered = Boolean(params.doctorId || params.severity || (params.period && params.period !== "90d"));

  return (
    <div className="space-y-3">
      {/* Full-width filters on phones, a wrapping row from sm up. */}
      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-end" role="group" aria-label="Filters">
        {doctors.length ? (
          <label className="min-w-0 space-y-1 sm:w-56">
            <span className="data-label block">Doctor</span>
            <Select
              id={`${id}-doctor`}
              value={params.doctorId ?? ""}
              onChange={(e) => go({ doctorId: e.target.value || null })}
              className={cn("h-9", params.doctorId && "border-accent text-accent")}
            >
              <option value="">All doctors</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fullName}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <label className="min-w-0 space-y-1 sm:w-52">
          <span className="data-label block">Severity</span>
          <Select
            id={`${id}-severity`}
            value={params.severity ?? ""}
            onChange={(e) => go({ severity: e.target.value || null })}
            className={cn("h-9", params.severity && "border-accent text-accent")}
          >
            <option value="">Stops and warnings</option>
            <option value="stop">Stops (overridden)</option>
            <option value="warn">Warnings (acknowledged)</option>
          </Select>
        </label>
        <label className="min-w-0 space-y-1 sm:w-44">
          <span className="data-label block">Period</span>
          <Select id={`${id}-period`} value={custom ? "custom" : preset} onChange={(e) => choosePeriod(e.target.value)} className="h-9">
            {PERIOD_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p === "custom" ? "Custom dates…" : PRESET_LABELS[p]}
              </option>
            ))}
          </Select>
        </label>
        {filtered ? (
          <button
            type="button"
            onClick={() => {
              setCustom(false);
              go({ doctorId: null, severity: null, period: null, from: null, to: null });
            }}
            className="inline-flex h-9 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Clear filters
          </button>
        ) : null}
        <Button asChild variant="outline" size="sm" className="h-9 w-full sm:ml-auto sm:w-auto">
          <a href={exportHref} download>
            <Download />
            Export CSV
          </a>
        </Button>
      </div>
      {custom ? (
        <form onSubmit={applyCustom} className="flex flex-wrap items-end gap-2" noValidate>
          <label className="space-y-1">
            <span className="data-label block">From</span>
            <Input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 w-40" />
          </label>
          <label className="space-y-1">
            <span className="data-label block">To</span>
            <Input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 w-40" />
          </label>
          <Button type="submit" size="sm" className="h-9">
            Apply
          </Button>
          {error ? (
            <p role="alert" className="w-full text-xs text-danger">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      <p className="font-mono text-xs tabular-nums text-muted-foreground">
        {fromKey} → {toKey}
      </p>
    </div>
  );
}
