"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CalendarPlus,
  Check,
  CheckCircle2,
  Clock,
  Loader2,
  LogIn,
  Mic,
  Play,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { addDays, dateKeyInTz, formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { describeCountdown, isRunningLate, type CountdownTone } from "@/modules/appointments/countdown";
import type { AppointmentDTO, NextAppointmentDTO } from "@/modules/appointments/dto";
import { availableTransitions, transitionTimeBlock } from "@/modules/appointments/rules";
import { isReschedulable, KIND_LABEL, STATUS_LABEL, type AppointmentStatus } from "@/modules/appointments/transitions";
import { NewAppointmentDialog } from "./appointment-new-dialog";
import { NoShowDialog } from "./appointment-no-show-dialog";
import { AppointmentNotesDialog } from "./appointment-notes-dialog";
import { RescheduleAppointmentDialog } from "./appointment-reschedule-dialog";
import { describeApiError, describeConfirmation, shortDayLabel } from "./appointment-shared";
import { AppointmentKindBadge, AppointmentStatusBadge } from "./appointment-status";

/** The card asks the server for a fresh answer this often (while the tab is visible). */
export const REFRESH_MS = 30_000;

const NEXT_STEP: Partial<Record<AppointmentStatus, { status: AppointmentStatus; label: string; Icon: LucideIcon }>> = {
  SCHEDULED: { status: "CONFIRMED", label: "Confirm", Icon: Check },
  CONFIRMED: { status: "CHECKED_IN", label: "Check in", Icon: LogIn },
  CHECKED_IN: { status: "IN_PROGRESS", label: "Start consultation", Icon: Play },
  IN_PROGRESS: { status: "COMPLETED", label: "Complete", Icon: CheckCircle2 },
};

const TONE_CLASS: Record<CountdownTone, string> = {
  default: "bg-muted text-muted-foreground",
  accent: "bg-accent-muted text-accent",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
};

type DialogState = { kind: "notes" | "reschedule" | "no-show"; appointment: AppointmentDTO } | { kind: "book" } | null;

export interface NextAppointmentCardProps {
  initial: NextAppointmentDTO;
  timezone: string;
  /** `hero`: the overview button (the viewer's or the clinic's next); `patient`: one patient's next booking. */
  variant: "hero" | "patient";
  patientId?: string;
  patientName?: string;
  canWrite: boolean;
  /** May remove other people's dictated notes. */
  canManage: boolean;
  userId: string | null;
}

/**
 * The big "next appointment" button. Server-rendered with its first answer,
 * then alive on the client: the countdown ticks every second against the
 * server's clock, the data refreshes every 30 seconds (and whenever the tab
 * comes back), and the one-tap actions follow the state machine and the clock
 * (Confirm → Check in → Start consultation → Complete; Mark as no-show; Open):
 * check-in only on the appointment's day, a no-show only after the start and
 * always confirmed first.
 * Below it, the rest of today's queue with a "late" flag for anyone past
 * their start without a check-in.
 */
export function NextAppointmentCard({ initial, timezone, variant, patientId, patientName, canWrite, canManage, userId }: NextAppointmentCardProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [data, setData] = useState<NextAppointmentDTO>(initial);
  // Server minus client clock, measured once on mount and after every refresh.
  const offset = useRef(0);
  const [now, setNow] = useState(() => new Date(initial.now));
  useEffect(() => {
    offset.current = new Date(initial.now).getTime() - Date.now();
  }, [initial.now]);
  const [pending, setPending] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [stale, setStale] = useState(false);

  const url = patientId ? `/api/appointments/next?patientId=${encodeURIComponent(patientId)}` : "/api/appointments/next?scope=auto";
  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<NextAppointmentDTO>(url);
      offset.current = new Date(res.now).getTime() - Date.now();
      setData(res);
      setStale(false);
    } catch {
      setStale(true);
    }
  }, [url]);

  // The countdown ticks once a second on the server's clock.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date(Date.now() + offset.current)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // A fresh answer every 30 seconds while the tab is visible, and as soon as it comes back.
  useEffect(() => {
    const poll = () => {
      if (!document.hidden) void refresh();
    };
    const timer = window.setInterval(poll, REFRESH_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);

  async function transition(a: AppointmentDTO, status: AppointmentStatus, then?: () => void) {
    if (pending) return;
    setPending(`${a.id}:${status}`);
    try {
      await apiFetch(`/api/appointments/${a.id}/transition`, { method: "POST", body: { status } });
      toast({ title: `${a.patient.fullName} · ${STATUS_LABEL[status]}`, tone: "success" });
      if (then) {
        then();
        return;
      }
      await refresh();
      router.refresh();
    } catch (err) {
      toast({ title: "Could not update the appointment", description: describeApiError(err), tone: "danger" });
      await refresh();
    } finally {
      setPending(null);
    }
  }

  function startConsultation(a: AppointmentDTO) {
    void transition(a, "IN_PROGRESS", () => router.push(`/dashboard/consultations?appointmentId=${encodeURIComponent(a.id)}`));
  }

  function afterDialog(message: string, description?: string | null, tone: "success" | "info" = "success") {
    setDialog(null);
    toast({ title: message, ...(description ? { description } : {}), tone });
    void refresh();
    router.refresh();
  }

  const a = data.appointment;
  const todayKey = dateKeyInTz(now, timezone);
  const tomorrowKey = dateKeyInTz(addDays(now, 1, timezone), timezone);
  const dayLabel = (d: Date) => {
    const key = dateKeyInTz(d, timezone);
    return key === todayKey ? "Today" : key === tomorrowKey ? "Tomorrow" : shortDayLabel(d, timezone);
  };

  const eyebrow =
    variant === "patient"
      ? "Next appointment"
      : a?.status === "IN_PROGRESS"
        ? "Now in consultation"
        : a?.status === "CHECKED_IN"
          ? "Waiting in the clinic"
          : data.scope === "mine"
            ? "Your next appointment"
            : data.fallback
              ? "Nothing of your own ahead · next in the clinic"
              : "Next in the clinic";

  const dialogs = (
    <>
      {dialog?.kind === "notes" ? (
        <AppointmentNotesDialog
          key={dialog.appointment.id}
          appointment={dialog.appointment}
          timezone={timezone}
          canWrite={canWrite}
          canManage={canManage}
          userId={userId}
          onOpenChange={(open) => {
            if (!open) {
              setDialog(null);
              void refresh();
              router.refresh();
            }
          }}
        />
      ) : null}
      {dialog?.kind === "no-show" ? (
        <NoShowDialog
          key={dialog.appointment.id}
          appointment={dialog.appointment}
          timezone={timezone}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onDone={(marked) => afterDialog(`${marked.patient.fullName} · ${STATUS_LABEL.NO_SHOW}`)}
        />
      ) : null}
      {dialog?.kind === "reschedule" ? (
        <RescheduleAppointmentDialog
          key={dialog.appointment.id}
          appointment={dialog.appointment}
          timezone={timezone}
          hours={data.hours}
          canOverride={canManage}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onDone={(moved, waitlisted, confirmation) =>
            afterDialog(
              waitlisted ? "Moved to the waitlist" : `Rescheduled · ${moved.patient.fullName}`,
              describeConfirmation(confirmation, moved.patient.fullName),
              confirmation && !confirmation.requested ? "info" : "success",
            )
          }
        />
      ) : null}
      {dialog?.kind === "book" ? (
        <NewAppointmentDialog
          timezone={timezone}
          hours={data.hours}
          canOverride={canManage}
          defaultDate={todayKey}
          presetPatient={patientId && patientName ? { id: patientId, fullName: patientName } : null}
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          onDone={(booked, waitlisted) => afterDialog(waitlisted ? "Added to the waitlist" : `Appointment booked · ${booked.patient.fullName}`)}
        />
      ) : null}
    </>
  );

  if (!a) {
    return (
      <>
        <Card className="border-dashed p-5 sm:p-6" data-testid="next-appointment-empty">
          <div className={cn("flex flex-col items-start gap-3", variant === "hero" && "sm:flex-row sm:items-center sm:justify-between")}>
            <div className="min-w-0">
              <p className="data-label">{eyebrow}</p>
              <p className="mt-1 font-display text-xl font-semibold tracking-tight">
                {variant === "patient" ? "No upcoming appointment" : "Nothing booked ahead"}
              </p>
              <p className="text-sm text-muted-foreground">
                {variant === "patient" ? "Book the next visit so the follow-up is not lost." : "The next live booking appears here the moment it is made."}
              </p>
            </div>
            {canWrite ? (
              <Button type="button" size="lg" onClick={() => setDialog({ kind: "book" })}>
                <CalendarPlus />
                Book an appointment
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link href="/dashboard/appointments">Open the schedule</Link>
              </Button>
            )}
          </div>
        </Card>
        {dialogs}
      </>
    );
  }

  const hero = variant === "hero";
  const start = new Date(a.startsAt);
  const end = new Date(a.endsAt);
  const countdown = describeCountdown(a, now);
  // What the clock allows right now: no check-in before the day, no no-show before the start.
  const available = availableTransitions(a, now, timezone);
  const nextStep = NEXT_STEP[a.status];
  const step = nextStep && available.includes(nextStep.status) ? nextStep : undefined;
  const stepLater = nextStep && !step ? transitionTimeBlock(a, nextStep.status, now, timezone) : null;
  const StepIcon = step?.Icon ?? Check;
  const busy = pending?.startsWith(`${a.id}:`) ?? false;
  const dayKey = dateKeyInTz(start, timezone);

  return (
    <>
      <Card
        data-testid="next-appointment-card"
        aria-live="polite"
        className={cn("relative overflow-hidden border-accent/40 p-5 sm:p-6", countdown.late && "border-warning/70")}
      >
        <div className="pointer-events-none absolute inset-y-0 right-0 w-2/3 bg-gradient-to-l from-accent-muted/70 to-transparent" aria-hidden="true" />
        {/* The hero spans the overview; the patient card sits in the record's side column, so it stays one column at every width. */}
        <div className={cn("relative grid gap-5", hero && "lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center")}>
          <div className="min-w-0 space-y-3">
            <p className="data-label">{eyebrow}</p>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              {hero ? (
                <Link
                  href={`/dashboard/patients/${a.patientId}`}
                  className="max-w-full truncate font-display text-2xl font-semibold tracking-tight hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-3xl"
                >
                  {a.patient.fullName}
                </Link>
              ) : (
                // On the patient's own record the day is the headline, not their name.
                <span className="font-display text-2xl font-semibold tracking-tight">{dayLabel(start)}</span>
              )}
              <span className="font-mono text-xl tabular-nums sm:text-2xl">
                {formatTimeInTz(start, timezone)}
                <span className="text-muted-foreground">–{formatTimeInTz(end, timezone)}</span>
              </span>
              {hero ? <span className="text-sm text-muted-foreground">{dayLabel(start)}</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                data-testid="next-appointment-countdown"
                className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs tabular-nums", TONE_CLASS[countdown.tone])}
              >
                {countdown.late ? <AlertTriangle className="h-3 w-3" aria-hidden="true" /> : <Clock className="h-3 w-3" aria-hidden="true" />}
                {countdown.label}
              </span>
              <AppointmentKindBadge kind={a.kind} />
              <AppointmentStatusBadge status={a.status} awaitingSince={a.confirmationRequestedAt} />
              {a.notesCount ? (
                <button
                  type="button"
                  onClick={() => setDialog({ kind: "notes", appointment: a })}
                  className="inline-flex items-center gap-1 rounded-md bg-accent-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent hover:bg-accent/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Mic className="h-3 w-3" aria-hidden="true" />
                  {a.notesCount} {a.notesCount === 1 ? "note" : "notes"}
                </button>
              ) : null}
            </div>
            <p className="truncate text-sm text-muted-foreground">
              {a.reason ?? "No reason given"} · {a.doctor?.fullName ?? "No doctor"}
              {a.room ? ` · ${a.room}` : ""}
            </p>
          </div>

          <div className={cn("flex flex-col gap-2", hero && "lg:w-64")}>
            {canWrite && step ? (
              <Button
                type="button"
                size="lg"
                className="h-12 w-full text-base"
                disabled={Boolean(pending)}
                onClick={() => (step.status === "IN_PROGRESS" ? startConsultation(a) : void transition(a, step.status))}
              >
                {busy ? <Loader2 className="animate-spin" /> : <StepIcon />}
                {step.label}
              </Button>
            ) : canWrite && stepLater ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground" data-testid="next-step-later">
                {stepLater.message}
              </p>
            ) : null}
            {a.status === "IN_PROGRESS" ? (
              <Button asChild variant="outline">
                <Link href={`/dashboard/consultations?appointmentId=${encodeURIComponent(a.id)}`}>
                  <Play />
                  Open consultation
                </Link>
              </Button>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {canWrite && available.includes("NO_SHOW") ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-danger hover:bg-danger/10"
                  disabled={Boolean(pending)}
                  onClick={() => setDialog({ kind: "no-show", appointment: a })}
                >
                  <UserX />
                  Mark as no-show…
                </Button>
              ) : null}
              {variant === "patient" && canWrite && isReschedulable(a.status) ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: "reschedule", appointment: a })}>
                  <CalendarClock />
                  Reschedule
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: "notes", appointment: a })}>
                <Mic />
                {a.notesCount ? `Notes · ${a.notesCount}` : canWrite ? "Dictate a note" : "Notes"}
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={`/dashboard/appointments?view=day&date=${dayKey}`}>
                  Open
                  <ArrowRight />
                </Link>
              </Button>
            </div>
            {variant === "patient" && canWrite ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ kind: "book" })}>
                <CalendarPlus />
                Book the next visit
              </Button>
            ) : null}
          </div>
        </div>

        {data.queue.length ? (
          <div className="relative mt-5 border-t border-border pt-4">
            <p className="data-label mb-2">
              {variant === "patient" ? "Also booked" : "Rest of today's queue"} · {data.queue.length}
            </p>
            <ul className={cn("grid gap-2", hero && "sm:grid-cols-3")} data-testid="next-appointment-queue">
              {data.queue.map((q) => {
                const late = isRunningLate(q, now);
                const qStart = new Date(q.startsAt);
                return (
                  <li
                    key={q.id}
                    className={cn("flex min-w-0 items-center gap-3 rounded-md border border-border bg-card/80 p-2.5", late && "border-warning/70")}
                  >
                    <span className="shrink-0 font-mono text-sm tabular-nums">{formatTimeInTz(qStart, timezone)}</span>
                    <div className="min-w-0 flex-1">
                      {variant === "patient" ? (
                        // On the patient's own page their name says nothing: show what the visit is for.
                        <Link
                          href={`/dashboard/appointments?view=day&date=${dateKeyInTz(qStart, timezone)}`}
                          className="block truncate text-sm font-medium hover:underline"
                          title={q.reason ?? KIND_LABEL[q.kind]}
                        >
                          {q.reason ?? KIND_LABEL[q.kind]}
                        </Link>
                      ) : (
                        <Link href={`/dashboard/patients/${q.patientId}`} className="block truncate text-sm font-medium hover:underline">
                          {q.patient.fullName}
                        </Link>
                      )}
                      <p className="truncate text-xs text-muted-foreground">
                        {variant === "patient" ? `${dayLabel(qStart)} · ` : ""}
                        {q.doctor?.fullName ?? "No doctor"}
                        {q.room ? ` · ${q.room}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {late ? <Badge tone="danger">late</Badge> : null}
                      <AppointmentStatusBadge status={q.status} awaitingSince={q.confirmationRequestedAt} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : variant === "hero" ? (
          <p className="relative mt-4 border-t border-border pt-3 text-xs text-muted-foreground">Nothing else in today's queue.</p>
        ) : null}
        {stale ? <p className="relative mt-2 text-[11px] text-muted-foreground">Live refresh paused — showing the last answer from the server.</p> : null}
      </Card>
      {dialogs}
    </>
  );
}
