import Link from "next/link";
import { CalendarClock, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { formatDateInTz } from "@/lib/time";
import type { BoardColumnDTO, LeadCardDTO } from "@/modules/crm/dto";
import { STAGE_LABELS, ageLabel } from "@/modules/crm/shared";
import { LeadMoveMenu } from "./lead-move-menu";
import { LostReasonBadge, OwnerChip, SourceBadge, leadsHref, whenLabel, type LeadQueryState } from "./lead-shared";

/**
 * The pipeline: one column per stage, newest leads first. On a phone the
 * board scrolls sideways inside its own box (snapping column by column) and
 * the page itself never does. Each card moves through its "Move to" menu.
 */
export function LeadBoard({
  columns,
  treatmentNames,
  canWrite,
  timezone,
  now,
  query,
}: {
  columns: BoardColumnDTO[];
  treatmentNames: Record<string, string>;
  canWrite: boolean;
  timezone: string;
  now: Date;
  query: LeadQueryState;
}) {
  return (
    // `relative`: the scroll box must be the containing block of the cards' visually-hidden
    // (absolutely positioned) labels, or they escape the clip and widen the page.
    <div className="relative w-full max-w-full overflow-x-auto overscroll-x-contain pb-3 [scrollbar-width:thin] snap-x snap-mandatory sm:snap-none" tabIndex={0} aria-label="Lead pipeline, scrolls sideways">
      <ol className="flex w-max gap-3">
        {columns.map((column) => (
          <li
            key={column.stage}
            aria-label={`${STAGE_LABELS[column.stage]}: ${column.total} leads`}
            className={cn(
              "flex w-[80vw] max-w-[17rem] shrink-0 snap-start flex-col rounded-lg border border-border bg-muted/40 sm:w-64",
              column.stage === "WON" && "bg-success/5",
              column.stage === "LOST" && "bg-danger/5",
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <h3 className="truncate text-sm font-semibold">{STAGE_LABELS[column.stage]}</h3>
              <Badge tone={column.stage === "WON" ? "success" : column.stage === "LOST" ? "danger" : "default"}>{column.total}</Badge>
            </div>
            {column.leads.length ? (
              <ol className="flex max-h-[36rem] flex-col gap-2 overflow-y-auto p-2">
                {column.leads.map((lead) => (
                  <LeadCard key={lead.id} lead={lead} treatmentNames={treatmentNames} canWrite={canWrite} timezone={timezone} now={now} />
                ))}
              </ol>
            ) : (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">No leads here.</p>
            )}
            {column.total > column.leads.length ? (
              <Link href={leadsHref("list", { ...query, stage: column.stage })} className="border-t border-border px-3 py-2 text-xs text-accent hover:underline">
                +{column.total - column.leads.length} more in the list
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LeadCard({
  lead,
  treatmentNames,
  canWrite,
  timezone,
  now,
}: {
  lead: LeadCardDTO;
  treatmentNames: Record<string, string>;
  canWrite: boolean;
  timezone: string;
  now: Date;
}) {
  const interests = lead.interests.map((k) => treatmentNames[k] ?? k).join(", ");
  const due = lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt) : null;
  const overdue = due ? due.getTime() < now.getTime() : false;
  const created = new Date(lead.createdAt);
  return (
    <li className="rounded-md border border-border bg-card p-3 shadow-[0_1px_2px_rgba(26,32,44,0.04)]">
      <div className="flex items-start justify-between gap-2">
        <Link href={`/dashboard/leads/${lead.id}`} className="min-w-0 truncate text-sm font-medium underline-offset-2 hover:text-accent hover:underline">
          {lead.fullName}
        </Link>
        <OwnerChip owner={lead.owner} />
      </div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={interests || undefined}>
        {interests || "No treatment named yet"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <SourceBadge source={lead.source} />
        {lead.stage === "LOST" ? <LostReasonBadge reason={lead.lostReason} /> : null}
        {lead.patientId ? <Badge tone="success">Patient</Badge> : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
        {lead.wonAt ? (
          <span className="inline-flex items-center gap-1 text-success" title="Won">
            <Trophy className="h-3 w-3" aria-hidden="true" />
            {formatDateInTz(new Date(lead.wonAt), timezone, { day: "2-digit", month: "short" })}
          </span>
        ) : (
          <span title={`Came in ${formatDateInTz(created, timezone)}`}>
            <span className="sr-only">Lead age </span>
            {ageLabel(created, now)}
          </span>
        )}
        {due ? (
          <span className={cn("inline-flex min-w-0 items-center gap-1 truncate", overdue && "text-danger")} title={overdue ? "Follow-up overdue" : "Next follow-up"}>
            <CalendarClock className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="sr-only">{overdue ? "Follow-up overdue since " : "Next follow-up "}</span>
            {whenLabel(due, timezone, now)}
          </span>
        ) : null}
      </div>
      {canWrite ? (
        <div className="mt-2 flex justify-end">
          <LeadMoveMenu lead={{ id: lead.id, fullName: lead.fullName, stage: lead.stage, objections: lead.objections }} />
        </div>
      ) : null}
    </li>
  );
}
