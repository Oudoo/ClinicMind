"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { apiFetch } from "@/lib/http";
import { fromLocalInput, minutesBetween, toLocalInput } from "@/lib/time";
import type { AppointmentConflictDTO, AppointmentDTO } from "@/modules/appointments/dto";
import { MAX_DURATION_MINUTES, MIN_DURATION_MINUTES } from "@/modules/appointments/transitions";
import { ConflictNotice, conflictsFrom, describeApiError, useDoctors } from "./appointment-shared";

/**
 * Move an appointment: new start/end on the clinic clock, doctor and room.
 * A 409 lists the bookings in the way and offers the waitlist instead.
 */
export function RescheduleAppointmentDialog({
  appointment,
  timezone,
  onOpenChange,
  onDone,
}: {
  appointment: AppointmentDTO;
  timezone: string;
  onOpenChange: (open: boolean) => void;
  onDone: (appointment: AppointmentDTO, waitlisted: boolean) => void;
}) {
  const id = useId();
  const { doctors, error: doctorsError } = useDoctors(true);
  const [start, setStart] = useState(() => toLocalInput(new Date(appointment.startsAt), timezone));
  const [end, setEnd] = useState(() => toLocalInput(new Date(appointment.endsAt), timezone));
  const [doctorId, setDoctorId] = useState(appointment.doctorId ?? "");
  const [room, setRoom] = useState(appointment.room ?? "");
  const [conflicts, setConflicts] = useState<AppointmentConflictDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Moving the start keeps the appointment's length. */
  function onStartChange(value: string) {
    const prevStart = fromLocalInput(start, timezone);
    const prevEnd = fromLocalInput(end, timezone);
    const next = fromLocalInput(value, timezone);
    setStart(value);
    if (prevStart && prevEnd && next) {
      setEnd(toLocalInput(new Date(next.getTime() + (prevEnd.getTime() - prevStart.getTime())), timezone));
    }
  }

  async function submit(allowWaitlist: boolean) {
    if (busy) return;
    const startsAt = fromLocalInput(start, timezone);
    const endsAt = fromLocalInput(end, timezone);
    if (!startsAt || !endsAt) {
      setError("Enter a valid start and end time.");
      return;
    }
    if (endsAt.getTime() <= startsAt.getTime()) {
      setError("The end must be after the start.");
      return;
    }
    const minutes = minutesBetween(startsAt, endsAt);
    if (minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
      setError(`Appointments last between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`);
      return;
    }
    setBusy(true);
    setError(null);
    setConflicts(null);
    try {
      const res = await apiFetch<{ appointment: AppointmentDTO }>(`/api/appointments/${appointment.id}`, {
        method: "PATCH",
        body: {
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          doctorId: doctorId || null,
          room: room.trim() || null,
          allowWaitlist,
        },
      });
      onDone(res.appointment, res.appointment.status === "WAITLISTED");
    } catch (err) {
      const found = conflictsFrom(err);
      if (found) setConflicts(found);
      else setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(false);
  }

  // The current doctor stays selectable even when they are not in the DOCTOR
  // list any more (other role, disabled), so an unchanged form still submits.
  const options = doctors ?? [];
  const currentMissing = appointment.doctor && !options.some((d) => d.id === appointment.doctor?.id);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title="Reschedule appointment"
        description={`${appointment.patient.fullName} · times on the clinic clock (${timezone})`}
      >
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {conflicts ? (
            <ConflictNotice
              conflicts={conflicts}
              timezone={timezone}
              busy={busy}
              onWaitlist={() => void submit(true)}
            />
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Starts" htmlFor={`${id}-start`}>
              <Input
                id={`${id}-start`}
                type="datetime-local"
                value={start}
                onChange={(e) => onStartChange(e.target.value)}
                required
              />
            </Field>
            <Field label="Ends" htmlFor={`${id}-end`}>
              <Input id={`${id}-end`} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Doctor" htmlFor={`${id}-doctor`} hint={doctorsError ?? undefined}>
              <Select
                id={`${id}-doctor`}
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                disabled={doctors === null}
              >
                {doctors === null ? (
                  <option value={doctorId}>Loading…</option>
                ) : (
                  <>
                    {!appointment.doctorId ? <option value="">Unassigned</option> : null}
                    {currentMissing && appointment.doctor ? (
                      <option value={appointment.doctor.id}>{appointment.doctor.fullName}</option>
                    ) : null}
                    {options.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.fullName}
                      </option>
                    ))}
                  </>
                )}
              </Select>
            </Field>
            <Field label="Room" htmlFor={`${id}-room`} hint="Optional">
              <Input
                id={`${id}-room`}
                value={room}
                onChange={(e) => setRoom(e.target.value)}
                maxLength={60}
                placeholder="e.g. Room 2"
              />
            </Field>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Reschedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
