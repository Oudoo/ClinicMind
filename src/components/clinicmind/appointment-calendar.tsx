"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { dateKeyInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { AppointmentDTO } from "@/modules/appointments/dto";
import { STATUS_LABEL, type AppointmentStatus, type WorkingHours } from "@/modules/appointments/transitions";
import { AppointmentCard } from "./appointment-card";
import { CancelAppointmentDialog } from "./appointment-cancel-dialog";
import { NewAppointmentDialog } from "./appointment-new-dialog";
import { NoShowDialog } from "./appointment-no-show-dialog";
import { AppointmentNotesDialog } from "./appointment-notes-dialog";
import { RescheduleAppointmentDialog } from "./appointment-reschedule-dialog";
import { describeApiError, staffLabel, type StaffOption } from "./appointment-shared";

export type CalendarView = "week" | "day";

export interface CalendarDay {
  /** `YYYY-MM-DD` on the clinic clock. */
  key: string;
  /** e.g. "Sat 17 Oct". */
  label: string;
}

export interface AppointmentCalendarProps {
  view: CalendarView;
  timezone: string;
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
      await apiFetch(`/api/appointments/${appointment.id}/transition`, { method: "POST", body: { status } });
      toast({
        title: `${appointment.patient.fullName} · ${STATUS_LABEL[status]}`,
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
    <div className="space-y-6">
      <SectionTitle
        title="Appointments"
        description={`Schedule on the clinic clock (${timezone}). No double bookings: conflicts are refused per doctor, room and patient.`}
        action={
          canWrite ? (
            <Button type="button" onClick={() => setNewOpen(true)}>
              <CalendarPlus className="h-4 w-4" />
              New appointment
            </Button>
          ) : undefined
        }
      />

      <Card className="p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <nav aria-label="Date navigation" className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="icon" className="h-9 w-9">
              <Link href={href({ date: nav.prev })} aria-label={`Previous ${view}`}>
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={href({ date: nav.today })}>Today</Link>
            </Button>
            <Button asChild variant="outline" size="icon" className="h-9 w-9">
              <Link href={href({ date: nav.next })} aria-label={`Next ${view}`}>
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
            <h3 className="ml-1 font-display text-sm font-semibold tracking-tight">{rangeLabel}</h3>
          </nav>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div role="group" aria-label="View" className="inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1">
              {(["week", "day"] as const).map((v) => (
                <Link
                  key={v}
                  href={href({ view: v })}
                  aria-current={view === v ? "page" : undefined}
                  className={cn(
                    "inline-flex h-7 items-center rounded-md px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    view === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {v === "week" ? "Week" : "Day"}
                </Link>
              ))}
            </div>

            <form method="get" action="/dashboard/appointments" className="flex items-center gap-2">
              <input type="hidden" name="view" value={view} />
              <input type="hidden" name="date" value={anchorKey} />
              <label htmlFor="doctor-filter" className="data-label">
                Doctor
              </label>
              <Select id="doctor-filter" name="doctorId" defaultValue={doctorId} className="h-9 w-44">
                <option value="">All doctors</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {staffLabel(d)}
                  </option>
                ))}
              </Select>
              <Button type="submit" variant="outline" size="sm">
                Apply
              </Button>
            </form>
          </div>
        </div>
      </Card>

      {view === "week" ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-7">
          {days.map((day) => {
            const list = byDay.get(day.key) ?? [];
            const isToday = day.key === todayKey;
            return (
              <section
                key={day.key}
                aria-label={day.label}
                className={cn("bento-tight space-y-2", isToday && "border-accent/60 ring-1 ring-accent/30")}
              >
                <div className="flex items-center justify-between">
                  <Link href={href({ view: "day", date: day.key })} className={cn("data-label hover:text-foreground", isToday && "text-accent")}>
                    {day.label}
                  </Link>
                  <span className="font-mono text-xs text-muted-foreground">{list.length}</span>
                </div>
                <div className="space-y-2">
                  {list.length ? (
                    list.map((a) => (
                      <AppointmentCard
                        key={a.id}
                        appointment={a}
                        timezone={timezone}
                        canWrite={canWrite}
                        pending={pendingId === a.id}
                        actions={actions}
                      />
                    ))
                  ) : (
                    <p className="py-4 text-center text-xs text-muted-foreground">—</p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Card className="space-y-3">
          {appointments.length ? (
            appointments.map((a) => (
              <AppointmentCard
                key={a.id}
                appointment={a}
                timezone={timezone}
                canWrite={canWrite}
                pending={pendingId === a.id}
                layout="row"
                actions={actions}
              />
            ))
          ) : (
            <EmptyState
              title="Nothing booked on this day"
              hint={canWrite ? "Use “New appointment” to book a slot." : "Bookings from the front desk and the AI receptionist appear here."}
            />
          )}
        </Card>
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
          onDone={(appointment, waitlisted) => {
            setRescheduleTarget(null);
            toast({
              title: waitlisted ? "Moved to the waitlist" : "Appointment rescheduled",
              description: appointment.patient.fullName,
              tone: "success",
            });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
