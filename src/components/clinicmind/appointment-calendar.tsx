"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { balanceWords } from "@/modules/finance/ledger-copy";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { AppointmentDTO } from "@/modules/appointments/dto";
import { isClosedDay } from "@/modules/appointments/rules";
import { STATUS_LABEL, type AppointmentStatus, type WorkingHours } from "@/modules/appointments/transitions";
import { AppointmentCard } from "./appointment-card";
import { CancelAppointmentDialog } from "./appointment-cancel-dialog";
import { NewAppointmentDialog } from "./appointment-new-dialog";
import { NoShowDialog } from "./appointment-no-show-dialog";
import { AppointmentNotesDialog } from "./appointment-notes-dialog";
import { RescheduleAppointmentDialog } from "./appointment-reschedule-dialog";
import { describeApiError, describeConfirmation, staffLabel, type StaffOption } from "./appointment-shared";

export type CalendarView = "week" | "day";

export interface CalendarDay {
  /** `YYYY-MM-DD` on the clinic clock. */
  key: string;
  /** e.g. "Sat 17 Oct"; today reads "Today 17 Oct". */
  label: string;
}

/** The day's list in one line, what needs someone first: who is waiting, who is in, what is still to come. */
function daySummary(list: AppointmentDTO[]): string {
  const count = (...statuses: AppointmentStatus[]) => list.filter((a) => statuses.includes(a.status)).length;
  const parts: [number, string][] = [
    [count("CHECKED_IN"), "waiting in the clinic"],
    [count("IN_PROGRESS"), "in consultation"],
    [count("SCHEDULED", "CONFIRMED"), "to come"],
    [count("COMPLETED"), "done"],
    [count("NO_SHOW"), count("NO_SHOW") === 1 ? "no-show" : "no-shows"],
    [count("CANCELLED"), "cancelled"],
    [count("WAITLISTED"), "on the waitlist"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(" · ");
}

export interface AppointmentCalendarProps {
  view: CalendarView;
  timezone: string;
  /** The server's clock when the page was rendered (ISO): "late" marks and the next step follow it. */
  now: string;
  /** The selected day (`YYYY-MM-DD`). */
  anchorKey: string;
  todayKey: string;
  /** Human label of the visible range. */
  rangeLabel: string;
  days: CalendarDay[];
  appointments: AppointmentDTO[];
  /** Clinicians (and nurses, for nurse-led procedures) the schedule can be filtered by. */
  doctors: StaffOption[];
  /** The clinic's opening hours (booking form default time and closed-day hint). */
  hours: WorkingHours;
  /** Current doctor filter ("" for all). */
  doctorId: string;
  nav: { prev: string; next: string; today: string };
  canWrite: boolean;
  /** May remove other people's dictated notes and back-enter or book outside the hours (users:manage). */
  canManage?: boolean;
  userId?: string | null;
}

/** The schedule page's client tree; mounts its own toast provider. */
export function AppointmentCalendar(props: AppointmentCalendarProps) {
  return (
    <ToastProvider>
      <Calendar {...props} />
    </ToastProvider>
  );
}

function Calendar({
  view,
  timezone,
  now: renderedAt,
  anchorKey,
  todayKey,
  rangeLabel,
  days,
  appointments,
  doctors,
  hours,
  doctorId,
  nav,
  canWrite,
  canManage = false,
  userId = null,
}: AppointmentCalendarProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [newOpen, setNewOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<AppointmentDTO | null>(null);
  const [noShowTarget, setNoShowTarget] = useState<AppointmentDTO | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<AppointmentDTO | null>(null);
  const [notesTarget, setNotesTarget] = useState<AppointmentDTO | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // The clock the list is read against: the server's at first, then kept moving on the
  // server's time (this device's clock may be off), so a patient turns "late" without a reload.
  const [now, setNow] = useState(() => new Date(renderedAt));
  const offset = useRef(0);
  useEffect(() => {
    offset.current = new Date(renderedAt).getTime() - Date.now();
    const timer = window.setInterval(() => setNow(new Date(Date.now() + offset.current)), 30_000);
    return () => window.clearInterval(timer);
  }, [renderedAt]);

  const href = (overrides: Partial<{ view: CalendarView; date: string; doctorId: string }>) => {
    const next = { view, date: anchorKey, doctorId, ...overrides };
    const params = new URLSearchParams();
    params.set("view", next.view);
    params.set("date", next.date);
    if (next.doctorId) params.set("doctorId", next.doctorId);
    return `/dashboard/appointments?${params.toString()}`;
  };

  async function transition(appointment: AppointmentDTO, status: AppointmentStatus) {
    if (pendingId) return;
    setPendingId(appointment.id);
    try {
      const res = await apiFetch<{ balance?: number }>(`/api/appointments/${appointment.id}/transition`, { method: "POST", body: { status } });
      toast({
        title: `${appointment.patient.fullName} · ${STATUS_LABEL[status]}`,
        // Checked in: what the patient owes (or has in credit), there and then.
        ...(res.balance ? { description: balanceWords(res.balance) } : {}),
        tone: "success",
      });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not update the appointment", description: describeApiError(err), tone: "danger" });
    } finally {
      setPendingId(null);
    }
  }

  const actions = {
    onTransition: (a: AppointmentDTO, status: AppointmentStatus) => void transition(a, status),
    onCancel: setCancelTarget,
    onNoShow: setNoShowTarget,
    onReschedule: setRescheduleTarget,
    onNotes: setNotesTarget,
  };

  const byDay = new Map<string, AppointmentDTO[]>();
  for (const a of appointments) {
    const key = dateKeyInTz(new Date(a.startsAt), timezone);
    byDay.set(key, [...(byDay.get(key) ?? []), a]);
  }
  return (
    <div className="space-y-4">
      <SectionTitle
        title="Appointments"
        description={`Times are on the clinic clock (${timezone}).`}
        action={
          canWrite ? (
            <Button type="button" onClick={() => setNewOpen(true)}>
              <CalendarPlus className="h-4 w-4" />
              New appointment
            </Button>
          ) : undefined
        }
      />

      {/* The controls of the list below, not a panel of their own. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <nav aria-label="Date navigation" className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="icon">
            <Link href={href({ date: nav.prev })} aria-label={`Previous ${view}`}>
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={href({ date: nav.today })}>Today</Link>
          </Button>
          <Button asChild variant="outline" size="icon">
            <Link href={href({ date: nav.next })} aria-label={`Next ${view}`}>
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
          <h3 className="ml-1 text-sm font-semibold">{rangeLabel}</h3>
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="View" className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1">
            {(["week", "day"] as const).map((v) => (
              <Link
                key={v}
                href={href({ view: v })}
                aria-current={view === v ? "page" : undefined}
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-3 text-sm font-medium transition-colors",
                  view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v === "week" ? "Week" : "Day"}
              </Link>
            ))}
          </div>
          {/* Choosing a doctor shows their schedule at once. */}
          <Select
            key={doctorId}
            aria-label="Doctor"
            defaultValue={doctorId}
            onChange={(e) => router.push(href({ doctorId: e.target.value }))}
            className="h-9 w-full bg-card sm:w-52"
          >
            <option value="">All doctors</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {staffLabel(d)}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {view === "week" ? (
        // One surface for the week: the days are divided by rules, and so are a day's bookings.
        <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-[0_1px_2px_rgba(26,32,44,0.04)] md:grid-cols-2 xl:grid-cols-7">
          {days.map((day) => {
            const list = byDay.get(day.key) ?? [];
            const isToday = day.key === todayKey;
            const date = fromDateKey(day.key, timezone);
            return (
              <section key={day.key} aria-label={day.label} className="min-w-0 bg-card md:last:col-span-2 xl:last:col-span-1">
                <div className={cn("flex items-center justify-between gap-2 border-b border-border px-2.5 py-2", isToday && "bg-accent-muted")}>
                  <Link
                    href={href({ view: "day", date: day.key })}
                    aria-current={isToday ? "date" : undefined}
                    className={cn("truncate text-sm font-medium hover:underline", isToday ? "font-semibold text-accent" : "text-foreground")}
                  >
                    {day.label}
                  </Link>
                  <span className={cn("text-xs tabular-nums", isToday ? "text-accent" : "text-muted-foreground")} title={`${list.length} booked`}>
                    {list.length}
                  </span>
                </div>
                {list.length ? (
                  <div className="divide-y divide-border">
                    {list.map((a) => (
                      <AppointmentCard
                        key={a.id}
                        appointment={a}
                        timezone={timezone}
                        now={now}
                        canWrite={canWrite}
                        pending={pendingId === a.id}
                        showDoctor={!doctorId}
                        actions={actions}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="px-2.5 py-3 text-xs text-muted-foreground">{date && isClosedDay(date, hours, timezone) ? "Closed" : "Nothing booked"}</p>
                )}
              </section>
            );
          })}
        </div>
      ) : appointments.length ? (
        <Card className="overflow-hidden p-0">
          <p className="border-b border-border px-4 py-2.5 text-sm text-muted-foreground md:px-5" data-testid="day-summary">
            {daySummary(appointments)}
          </p>
          <div className="divide-y divide-border">
            {appointments.map((a) => (
              <AppointmentCard key={a.id} appointment={a} timezone={timezone} now={now} canWrite={canWrite} pending={pendingId === a.id} layout="row" actions={actions} />
            ))}
          </div>
        </Card>
      ) : (
        <EmptyState
          title="Nothing booked on this day"
          hint={canWrite ? "Use “New appointment” to book a slot." : "Bookings from the front desk and the AI receptionist appear here."}
        />
      )}

      {newOpen ? (
        <NewAppointmentDialog
          timezone={timezone}
          hours={hours}
          canOverride={canManage}
          defaultDate={anchorKey}
          defaultDoctorId={doctorId}
          onOpenChange={(open) => {
            if (!open) setNewOpen(false);
          }}
          onDone={(appointment, waitlisted) => {
            setNewOpen(false);
            toast({
              title: waitlisted ? "Added to the waitlist" : "Appointment booked",
              description: `${appointment.patient.fullName} with ${appointment.doctor?.fullName ?? "no doctor"}`,
              tone: "success",
            });
            router.refresh();
          }}
        />
      ) : null}

      {cancelTarget ? (
        <CancelAppointmentDialog
          key={cancelTarget.id}
          appointment={cancelTarget}
          timezone={timezone}
          onOpenChange={(open) => {
            if (!open) setCancelTarget(null);
          }}
          onDone={(appointment) => {
            setCancelTarget(null);
            toast({ title: `${appointment.patient.fullName} · Cancelled`, tone: "success" });
            router.refresh();
          }}
        />
      ) : null}

      {noShowTarget ? (
        <NoShowDialog
          key={noShowTarget.id}
          appointment={noShowTarget}
          timezone={timezone}
          onOpenChange={(open) => {
            if (!open) setNoShowTarget(null);
          }}
          onDone={(appointment) => {
            setNoShowTarget(null);
            toast({ title: `${appointment.patient.fullName} · ${STATUS_LABEL.NO_SHOW}`, tone: "success" });
            router.refresh();
          }}
        />
      ) : null}

      {notesTarget ? (
        <AppointmentNotesDialog
          key={notesTarget.id}
          appointment={notesTarget}
          timezone={timezone}
          canWrite={canWrite}
          canManage={canManage}
          userId={userId}
          onOpenChange={(open) => {
            if (!open) setNotesTarget(null);
          }}
          onChanged={() => router.refresh()}
        />
      ) : null}

      {rescheduleTarget ? (
        <RescheduleAppointmentDialog
          key={rescheduleTarget.id}
          appointment={rescheduleTarget}
          timezone={timezone}
          hours={hours}
          canOverride={canManage}
          onOpenChange={(open) => {
            if (!open) setRescheduleTarget(null);
          }}
          onDone={(appointment, waitlisted, confirmation) => {
            setRescheduleTarget(null);
            toast({
              title: waitlisted ? "Moved to the waitlist" : "Appointment rescheduled",
              description: describeConfirmation(confirmation, appointment.patient.fullName) ?? appointment.patient.fullName,
              tone: confirmation && !confirmation.requested ? "info" : "success",
            });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
