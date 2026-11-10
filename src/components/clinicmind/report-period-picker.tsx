"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { PERIOD_PRESETS, PRESET_LABELS, type PeriodPreset } from "@/modules/reporting/period";

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "14 Oct" from a local date key (YYYY-MM-DD), built from the digits so server and browser agree. */
const dayMonth = (key: string) => `${Number(key.slice(8, 10))} ${MONTH[Number(key.slice(5, 7)) - 1] ?? ""}`;
const yearOf = (key: string) => key.slice(0, 4);

/**
 * A period in words: "14 Oct to 10 Nov 2026", "16 Dec 2025 to 13 Jan 2026", "10 Nov 2026" for
 * one day. `withYear` false leaves the year off a span inside the given year (the comparison
 * period, said after the period it is compared with).
 */
export function periodWords(fromKey: string, toKey: string, withYear = true): string {
  const sameYear = yearOf(fromKey) === yearOf(toKey);
  if (fromKey === toKey) return withYear ? `${dayMonth(fromKey)} ${yearOf(fromKey)}` : dayMonth(fromKey);
  if (!sameYear) return `${dayMonth(fromKey)} ${yearOf(fromKey)} to ${dayMonth(toKey)} ${yearOf(toKey)}`;
  return `${dayMonth(fromKey)} to ${dayMonth(toKey)}${withYear ? ` ${yearOf(toKey)}` : ""}`;
}

/**
 * The period picker of the finance dashboard, the reports and the patient
 * data dashboard: Today, 7 days, 28 days, this month, 90 days or a custom range, with
 * the comparison period (the equal period before) said in words. It only
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

  // The comparison period keeps its year only when it is not the period's own.
  const comparison = periodWords(previous.fromKey, previous.toKey, yearOf(previous.toKey) !== yearOf(toKey) || yearOf(previous.fromKey) !== yearOf(toKey));

  return (
    <div className={cn("space-y-2", className)}>
      <div className="-mx-1 overflow-x-auto px-1">
        <div className="inline-flex min-w-max items-center gap-0.5 rounded-lg bg-muted p-1 sm:gap-1" role="group" aria-label="Period">
          {PERIOD_PRESETS.map((p) => {
            const active = p === "custom" ? custom : !custom && preset === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => choose(p)}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-8 items-center whitespace-nowrap rounded-md px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
                  active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {PRESET_LABELS[p]}
              </button>
            );
          })}
        </div>
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
          <Button type="submit" size="sm" variant="outline" className="h-9">
            Show
          </Button>
          {error ? (
            <p role="alert" className="w-full text-xs text-danger">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      <p className="text-xs text-muted-foreground">
        <span className="tabular-nums">{periodWords(fromKey, toKey)}</span>, compared with <span className="tabular-nums">{comparison}</span>
      </p>
    </div>
  );
}
