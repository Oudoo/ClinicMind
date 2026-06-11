import * as React from "react";
import { cn } from "@/lib/utils";

/** Simple progress bar (server-component friendly). */
export function Progress({
  value,
  className,
  barClassName,
}: {
  value: number;
  className?: string;
  barClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-secondary", className)}>
      <div
        className={cn("h-full rounded-full bg-primary transition-all", barClassName)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** Confidence pill — the Confidence Framework's visual unit. */
export function ConfidenceBadge({
  score,
  evidenceCount,
  sources,
}: {
  score: number | string | null;
  evidenceCount?: number | null;
  sources?: string[] | null;
}) {
  if (score === null || score === undefined) return null;
  const n = Number(score);
  const color =
    n >= 85 ? "bg-emerald-100 text-emerald-800" : n >= 70 ? "bg-sky-100 text-sky-800" : n >= 50 ? "bg-amber-100 text-amber-800" : "bg-red-100 text-red-800";
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", color)}
      title={`Confidence ${n}%${evidenceCount ? ` · ${evidenceCount} evidence items` : ""}${sources?.length ? ` · sources: ${sources.join(", ")}` : ""}`}
    >
      {n.toFixed(0)}% confidence
      {evidenceCount ? <span className="opacity-70">· {evidenceCount} evidence</span> : null}
    </span>
  );
}
