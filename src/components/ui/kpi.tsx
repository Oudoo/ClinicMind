import * as React from "react";
import { TrendingDown, TrendingUp, Check, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/**
 * Dashboard building blocks: a KPI tile with the change against a comparison
 * period and a sparkline, a change chip, week-over-week columns and horizontal
 * bars. Pure markup and inline SVG, so they render in server components.
 */

export type Direction = "up" | "down";

/** Relative change with the colour decided by which direction is good. */
export function DeltaChip({
  current,
  previous,
  goodWhen,
  format = (v) => String(v),
}: {
  current: number;
  previous: number | null | undefined;
  goodWhen: Direction;
  format?: (v: number) => string;
}) {
  if (previous == null || !Number.isFinite(previous)) return null;
  const change = previous ? ((current - previous) / Math.abs(previous)) * 100 : current ? 100 : 0;
  const flat = Math.abs(change) < 1;
  const good = goodWhen === "up" ? change > 0 : change < 0;
  const tone = flat ? "bg-muted text-muted-foreground" : good ? "bg-success/10 text-success" : "bg-danger/10 text-danger";
  const Icon = change > 0 ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn("inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] tabular-nums", tone)}
      title={`${format(previous)} in the comparison period`}
    >
      {flat ? null : <Icon className="h-3 w-3" aria-hidden="true" />}
      {flat ? "flat" : `${Math.abs(Math.round(change))}%`}
    </span>
  );
}

export function Spark({ values, tone = "accent", className }: { values: number[]; tone?: "accent" | "warning"; className?: string }) {
  if (!values.length) return null;
  const w = 100;
  const h = 28;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  const points = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const colour = tone === "warning" ? "hsl(var(--warning))" : "hsl(var(--accent))";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("h-7 w-full", className)} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} fill={colour} fillOpacity="0.12" />
      <path d={line} fill="none" stroke={colour} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Kpi({
  label,
  value,
  delta,
  hint,
  target,
  spark,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  hint?: React.ReactNode;
  target?: { ok: boolean; text: string };
  spark?: number[];
  tone?: "default" | "accent" | "warning";
}) {
  return (
    <Card className="flex min-w-0 flex-col gap-1.5 p-4 sm:p-5">
      <span className="data-label">{label}</span>
      <div className="flex flex-wrap items-baseline gap-2">
        <span
          className={cn(
            "font-display text-2xl font-semibold tracking-tightest tabular-nums sm:text-3xl",
            tone === "accent" && "text-accent",
            tone === "warning" && "text-warning",
          )}
        >
          {value}
        </span>
        {delta}
      </div>
      {hint || target ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {hint ? <span>{hint}</span> : null}
          {target ? (
            <span className={cn("inline-flex items-center gap-1", target.ok ? "text-success" : "text-warning")}>
              {target.ok ? <Check className="h-3 w-3" aria-hidden="true" /> : <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
              {target.text}
            </span>
          ) : null}
        </div>
      ) : null}
      {spark && spark.length ? (
        <div className="mt-auto pt-1">
          <Spark values={spark} tone={tone === "warning" ? "warning" : "accent"} />
        </div>
      ) : null}
    </Card>
  );
}

/** Vertical columns, optionally paired with a comparison value (grey, behind). */
export function Columns({
  items,
  height = "h-44",
  note,
  format = (v) => String(v),
}: {
  items: { label: string; value: number; compare?: number }[];
  height?: string;
  note?: string;
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...items.map((x) => Math.max(x.value, x.compare ?? 0)));
  return (
    <div>
      <div className={cn("flex items-end gap-1 sm:gap-1.5", height)}>
        {items.map((x) => (
          <div
            key={x.label}
            className="flex h-full min-w-0 flex-1 items-end justify-center gap-px"
            title={`${x.label}: ${format(x.value)}${x.compare != null ? ` (comparison ${format(x.compare)})` : ""}`}
          >
            {x.compare != null ? (
              <div className="w-full rounded-t bg-muted-foreground/30" style={{ height: `${Math.max(2, Math.round((x.compare / max) * 100))}%` }} />
            ) : null}
            <div className="w-full rounded-t bg-accent" style={{ height: `${Math.max(2, Math.round((x.value / max) * 100))}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 sm:gap-1.5">
        {items.map((x) => (
          <span key={x.label} className="min-w-0 flex-1 truncate text-center font-mono text-[10px] text-muted-foreground">
            {x.label}
          </span>
        ))}
      </div>
      {note ? <p className="mt-1 text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

export function HBars({
  items,
  format = (v) => String(v),
  labelWidth = "w-36 sm:w-56",
}: {
  items: { label: string; value: number }[];
  format?: (v: number) => string;
  labelWidth?: string;
}) {
  const max = Math.max(1, ...items.map((x) => x.value));
  return (
    <ul className="space-y-2">
      {items.map((x) => (
        <li key={x.label} className="flex items-center gap-3 text-sm">
          <span className={cn("shrink-0 truncate", labelWidth)} title={x.label}>
            {x.label}
          </span>
          <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded bg-muted">
            <div className="h-full rounded bg-accent" style={{ width: `${Math.round((x.value / max) * 100)}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums">{format(x.value)}</span>
        </li>
      ))}
    </ul>
  );
}
