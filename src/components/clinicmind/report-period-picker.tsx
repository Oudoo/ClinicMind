"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PERIOD_PRESETS, PRESET_LABELS, type PeriodPreset } from "@/modules/reporting/period";

/**
 * The period picker of the finance dashboard, the reports and the patient
 * data dashboard: Today, 7 d, 28 d, this month, 90 d or a custom range, with
 * the comparison period (the equal period before) spelled out. It only
 * rewrites the URL; the server page re-renders with the new period. Other
 * query parameters (filters, tab) are kept; the page number is dropped.
 */
export function PeriodPicker({
  basePath,
  preset,
  fromKey,
  toKey,
  previous,
  keep = {},
  className,
}: {
  basePath: string;
  preset: PeriodPreset;
  fromKey: string;
  toKey: string;
  /** The comparison period, as local date keys. */
  previous: { fromKey: string; toKey: string };
  /** Query entries to carry over (filters, tab). */
  keep?: Record<string, string>;
  className?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [custom, setCustom] = useState(preset === "custom");
  const [from, setFrom] = useState(fromKey);
  const [to, setTo] = useState(toKey);
  const [error, setError] = useState<string | null>(null);

  const go = (entries: Record<string, string>) => {
    const params = new URLSearchParams({ ...keep, ...entries });
    params.delete("page");
    router.replace(`${basePath}?${params.toString()}`, { scroll: false });
  };

  const choose = (p: PeriodPreset) => {
    if (p === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    const next = { ...keep };
    delete next.from;
    delete next.to;
    const params = new URLSearchParams({ ...next, period: p });
    params.delete("page");
    router.replace(`${basePath}?${params.toString()}`, { scroll: false });
  };

  const apply = (e: FormEvent) => {
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

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Period">
        {PERIOD_PRESETS.map((p) => {
          const active = p === "custom" ? custom : !custom && preset === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => choose(p)}
              aria-pressed={active}
              className={cn(
                "inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors",
                active ? "border-accent bg-accent-muted text-accent" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {p === "custom" ? <CalendarRange className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> : null}
              {PRESET_LABELS[p]}
            </button>
          );
        })}
      </div>
      {custom ? (
        <form onSubmit={apply} className="flex flex-wrap items-end gap-2" noValidate>
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
      <p className="text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">
          {fromKey} → {toKey}
        </span>{" "}
        compared with{" "}
        <span className="font-mono tabular-nums">
          {previous.fromKey} → {previous.toKey}
        </span>
      </p>
    </div>
  );
}
