import { Mail } from "lucide-react";
import { DeltaChip } from "@/components/ui/kpi";
import { Card, EmptyState } from "@/components/ui/primitives";
import { formatDateTimeInTz } from "@/lib/time";
import type { BriefLine, WeeklyBrief } from "@/modules/reporting/brief";
import { METRIC_BY_ID, type MetricUnit } from "@/modules/reporting/definitions";
import { MetricBadge, fmtCount, fmtEgp, fmtPct, fmtScore, fmtSeconds } from "./report-shared";

export function fmtMetric(unit: MetricUnit, v: number | null): string {
  switch (unit) {
    case "percent":
      return fmtPct(v);
    case "egp":
      return fmtEgp(v);
    case "seconds":
      return fmtSeconds(v);
    case "score":
      return v === null ? "—" : `${fmtScore(v)}/5`;
    default:
      return fmtCount(v);
  }
}

/**
 * The weekly brief: the five largest changes of last week against the week
 * before, each with its driver. The same text goes to the owner as a
 * notification on Sunday at 08:00 (clinic time).
 */
export function ReportBriefCard({ brief, sentAt, timezone }: { brief: WeeklyBrief; sentAt: string | null; timezone: string }) {
  return (
    <Card className="min-w-0 space-y-3 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-base font-semibold tracking-tight">Weekly brief</h3>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono text-xs">
              {brief.period.fromKey} → {brief.period.toKey}
            </span>{" "}
            against the week before: the five largest changes.
          </p>
        </div>
        <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Mail className="h-3.5 w-3.5" aria-hidden="true" />
          {sentAt ? `Sent to the owner ${formatDateTimeInTz(new Date(sentAt), timezone)}` : "Goes to the owner on Sunday at 08:00"}
        </p>
      </div>
      {brief.lines.length ? (
        <ol className="space-y-2">
          {brief.lines.map((l, i) => (
            <BriefRow key={l.metric} line={l} index={i} />
          ))}
        </ol>
      ) : (
        <EmptyState title="Not enough activity last week for a brief" />
      )}
    </Card>
  );
}

function BriefRow({ line, index }: { line: BriefLine; index: number }) {
  // The M13 line counts procedures from campaigns (more is better); the others follow their metric.
  const goodWhen = line.metric === "M13" ? "up" : METRIC_BY_ID[line.metric].goodWhen;
  return (
    <li className="flex gap-3 rounded-md border border-border p-3">
      <span className="font-mono text-xs text-muted-foreground">{index + 1}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <MetricBadge id={line.metric} />
          <span className="text-sm font-medium">{line.label}</span>
          <span className="font-mono text-sm tabular-nums">{fmtMetric(line.unit, line.current)}</span>
          {line.current !== null && line.previous !== null ? (
            <DeltaChip
              current={line.current}
              previous={line.previous}
              goodWhen={goodWhen}
              format={(v) => fmtMetric(line.unit, v)}
              mode={line.unit === "percent" ? "points" : "relative"}
              currentLabel="last week"
              previousLabel="the week before"
            />
          ) : null}
          <span className="text-xs text-muted-foreground">was {fmtMetric(line.unit, line.previous)}</span>
        </div>
        <p className="text-xs text-muted-foreground">{line.driver}</p>
      </div>
    </li>
  );
}
