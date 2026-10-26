"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, BellRing, Camera, Moon, PhoneCall, RefreshCw, Star, Sun } from "lucide-react";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Kpi } from "@/components/ui/kpi";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import { formatDateTimeInTz, formatTimeInTz, isSameDayInTz } from "@/lib/time";
import type { BoardCheckInDTO, BoardDTO, BoardTaskDTO, EscalationDTO } from "@/modules/concierge/dto";
import { formatMinutes, stepTitle } from "@/modules/concierge/labels";
import { CountdownText, useServerClock } from "@/components/clinicmind/concierge-countdown";
import { EscalationActions } from "@/components/clinicmind/escalation-actions";
import { FlagList, StepKindIcon, TriageBadge } from "@/components/clinicmind/concierge-badges";

const POLL_MS = 30_000;

/**
 * The concierge board: open escalations by target with a live countdown
 * (overdue in red) and Acknowledge / Resolve, who is on call, the two KPI
 * targets of the spec, and today's check-ins (due, awaiting an answer,
 * answered). Refreshes itself every 30 seconds while the tab is visible.
 */
export function ConciergeBoard({ initial, canWrite }: { initial: BoardDTO; canWrite: boolean }) {
  const [board, setBoard] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const now = useServerClock(board.now);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch<{ board: BoardDTO }>("/api/concierge/board");
      setBoard(res.board);
    } catch {
      /* keep the last board; the next poll tries again */
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const { kpis, onCall, timezone } = board;
  const tz = timezone;
  const answer = kpis.answerRate;
  const ack = kpis.highRiskAck;
  const time = (iso: string) => {
    const d = new Date(iso);
    return isSameDayInTz(d, new Date(now), tz) ? formatTimeInTz(d, tz) : formatDateTimeInTz(d, tz);
  };

  return (
    <div className="space-y-6">
      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-md", onCall.outOfHours ? "bg-muted text-foreground" : "bg-accent-muted text-accent")}>
            {onCall.outOfHours ? <Moon className="h-4 w-4" aria-hidden="true" /> : <Sun className="h-4 w-4" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <p className="data-label">{onCall.outOfHours ? "Out of hours now" : "In hours now"}</p>
            <p className="text-sm">
              A high-risk reply goes to <span className="font-medium">{onCall.assigneeName ?? "nobody (set the roster)"}</span>, acknowledge within{" "}
              <span className="font-medium">{onCall.ackMinutes} min</span>
              {onCall.backupName ? <span className="text-muted-foreground"> · backup {onCall.backupName}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link href="/dashboard/concierge?tab=roster">Roster & hours</Link>
          </Button>
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh the board">
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4">
        <Kpi
          label={`Check-ins answered · ${board.windowDays} days`}
          value={answer.pct === null ? "—" : `${answer.pct}%`}
          tone={answer.pct !== null && answer.pct < answer.target ? "warning" : "default"}
          hint={answer.sent ? `${answer.answered} of ${answer.sent} · ${answer.afterReminder} after the reminder · ${answer.missed} missed` : "No check-in has closed yet"}
          target={answer.pct === null ? undefined : { ok: answer.pct >= answer.target, text: `target ${answer.target}%` }}
        />
        <Kpi
          label="High-risk acknowledged in time"
          value={ack.pct === null ? "—" : `${ack.pct}%`}
          tone={ack.pct !== null && ack.pct < ack.target ? "warning" : "default"}
          hint={ack.counted ? `${ack.within} of ${ack.counted}${ack.medianMinutes === null ? "" : ` · median ${ack.medianMinutes} min`}` : "No high-risk reply in the window"}
          target={ack.pct === null ? undefined : { ok: ack.pct >= ack.target, text: `target ${ack.target}% (15 min in hours, 30 out)` }}
        />
        <Kpi
          label="Open escalations"
          value={kpis.openEscalations}
          tone={kpis.overdueEscalations ? "warning" : "default"}
          hint={kpis.overdueEscalations ? `${kpis.overdueEscalations} past the target` : "None past the target"}
        />
        <Kpi
          label="Active follow-ups"
          value={kpis.activeEnrolments}
          hint={[
            kpis.photoRate.pct === null ? null : `photos sent back ${kpis.photoRate.pct}%`,
            kpis.satisfaction.average === null ? null : `satisfaction ${kpis.satisfaction.average}/5 (${kpis.satisfaction.count})`,
          ]
            .filter(Boolean)
            .join(" · ") || undefined}
        />
      </div>

      <section aria-labelledby="escalations-title" className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <h3 id="escalations-title" className="font-display text-base font-semibold tracking-tight">
            Escalations
          </h3>
          <span className="text-xs text-muted-foreground">Most urgent target first · refreshes every 30 s</span>
        </div>
        {board.escalations.length ? (
          <ul className="space-y-3">
            {board.escalations.map((e) => (
              <EscalationRow key={e.id} e={e} now={now} time={time} canWrite={canWrite} onChanged={() => void refresh()} />
            ))}
          </ul>
        ) : (
          <Card>
            <EmptyState title="No open escalations" hint="High-risk and out-of-range replies land here with a named owner and a target." />
          </Card>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <TaskColumn title="Due today" empty="Nothing else goes out today." count={board.dueToday.length}>
          {board.dueToday.map((t) => (
            <TaskRow key={t.id} t={t} meta={<span>goes out {time(t.dueAt)}</span>} />
          ))}
        </TaskColumn>
        <TaskColumn title="Awaiting answer" empty="Every check-in that went out is answered." count={board.awaiting.length}>
          {board.awaiting.map((t) => (
            <TaskRow
              key={t.id}
              t={t}
              meta={
                <>
                  <span>sent {t.sentAt ? `${formatMinutes((now - Date.parse(t.sentAt)) / 60_000)} ago` : "—"}</span>
                  {t.reminded ? (
                    <Badge tone="warning">
                      <BellRing className="h-3 w-3" aria-hidden="true" />
                      reminded
                    </Badge>
                  ) : null}
                  {t.missesAt ? <span>closes {time(t.missesAt)}</span> : null}
                </>
              }
            />
          ))}
        </TaskColumn>
        <TaskColumn title="Answered today" empty="No answers yet today." count={board.answeredToday.length}>
          {board.answeredToday.map((c) => (
            <AnsweredRow key={c.id} c={c} time={time} />
          ))}
        </TaskColumn>
      </div>
    </div>
  );
}

function EscalationRow({
  e,
  now,
  time,
  canWrite,
  onChanged,
}: {
  e: EscalationDTO;
  now: number;
  time: (iso: string) => string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const overdue = e.status === "OPEN" && Date.parse(e.dueAt) < now;
  const href = e.enrolmentId ? `/dashboard/concierge/enrolments/${e.enrolmentId}` : e.patientId ? `/dashboard/patients/${e.patientId}` : null;
  return (
    <li className={cn("bento-tight space-y-2", overdue && "border-danger/50 bg-danger/5", e.level === "HIGH_RISK" && !overdue && e.status === "OPEN" && "border-warning/50")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <TriageBadge level={e.level} />
            {href ? (
              <Link href={href} className="font-medium underline-offset-2 hover:text-accent hover:underline">
                {e.patientName ?? "Patient"}
              </Link>
            ) : (
              <span className="font-medium">{e.patientName ?? "Patient"}</span>
            )}
            {e.status === "ACKNOWLEDGED" ? <Badge tone="accent">Acknowledged</Badge> : null}
            {overdue ? (
              <Badge tone="danger">
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Overdue
              </Badge>
            ) : null}
          </div>
          <p className="break-words text-sm">{e.summary}</p>
          <FlagList flags={e.flags} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">
          {e.status === "OPEN" ? <CountdownText dueAt={e.dueAt} now={now} className="text-sm" /> : null}
          <span className="text-xs text-muted-foreground">target {e.targetMinutes ?? "—"} min · {e.outOfHours ? "out of hours" : "in hours"}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
        <p className="min-w-0 text-xs text-muted-foreground">
          <PhoneCall className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
          {e.assignedToName ? <span className="font-medium text-foreground">{e.assignedToName}</span> : "Unassigned"} · opened {time(e.createdAt)}
          {e.status === "ACKNOWLEDGED" && e.acknowledgedAt ? (
            <>
              {" "}
              · acknowledged {time(e.acknowledgedAt)}
              {e.acknowledgedByName ? ` by ${e.acknowledgedByName}` : ""}{" "}
              <span className={e.acknowledgedWithinTarget ? "text-success" : "text-danger"}>
                ({e.acknowledgedWithinTarget ? "within target" : `${formatMinutes((Date.parse(e.acknowledgedAt) - Date.parse(e.dueAt)) / 60_000)} late`})
              </span>
            </>
          ) : null}
        </p>
        {canWrite ? <EscalationActions escalation={e} onChanged={onChanged} compact /> : null}
      </div>
    </li>
  );
}

function TaskColumn({ title, empty, count, children }: { title: string; empty: string; count: number; children: React.ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-base font-semibold tracking-tight">{title}</h3>
        <Badge>{count}</Badge>
      </div>
      {count ? <ul className="-mx-1 max-h-[28rem] space-y-1 overflow-y-auto px-1">{children}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>}
    </Card>
  );
}

function TaskRow({ t, meta }: { t: BoardTaskDTO; meta: React.ReactNode }) {
  return (
    <li>
      <Link href={`/dashboard/concierge/enrolments/${t.enrolmentId}`} className="flex items-start gap-2 rounded-md p-2 hover:bg-muted">
        <StepKindIcon kind={t.kind} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{t.patient.fullName}</span>
          <span className="block truncate text-xs text-muted-foreground">{stepTitle(t.dayLabel, t.title)}</span>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            {meta}
            {t.hasHighRisk ? <Badge tone="warning">red-flag questions</Badge> : null}
            {t.lastError ? <Badge tone="danger">{t.lastError.slice(0, 40)}</Badge> : null}
          </div>
        </div>
      </Link>
    </li>
  );
}

function AnsweredRow({ c, time }: { c: BoardCheckInDTO; time: (iso: string) => string }) {
  return (
    <li>
      <Link href={`/dashboard/concierge/enrolments/${c.enrolmentId}`} className="flex items-start gap-2 rounded-md p-2 hover:bg-muted">
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{c.patient.fullName}</span>
            <TriageBadge level={c.triage} />
          </div>
          <span className="block truncate text-xs text-muted-foreground">{c.title}</span>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>{time(c.submittedAt)}</span>
            {c.source === "staff" ? <span>by phone</span> : null}
            {c.satisfaction ? (
              <span className="inline-flex items-center gap-0.5" aria-label={`Satisfaction ${c.satisfaction} of 5`}>
                <Star className="h-3 w-3 fill-current text-warning" aria-hidden="true" />
                {c.satisfaction}/5
              </span>
            ) : null}
            {c.photos ? (
              <span className="inline-flex items-center gap-0.5">
                <Camera className="h-3 w-3" aria-hidden="true" />
                {c.photos}
              </span>
            ) : null}
          </div>
          {c.flags.length ? <FlagList flags={c.flags} className="mt-1 flex flex-wrap gap-1" /> : null}
        </div>
      </Link>
    </li>
  );
}
