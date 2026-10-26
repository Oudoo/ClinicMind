"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { apiFetch } from "@/lib/http";
import { fromLocalInput, minutesBetween, toLocalInput } from "@/lib/time";
import type { AppointmentDTO, FreeSlotsDTO, SlotSuggestionDTO } from "@/modules/appointments/dto";
import { MAX_DURATION_MINUTES, MIN_DURATION_MINUTES } from "@/modules/appointments/transitions";
import { SlotPicker } from "./appointment-slot-picker";
import { ConflictNotice, conflictInfo, describeApiError, freeSlotsUrl, useDoctors, type ConflictInfo } from "./appointment-shared";

/**
 * Move an appointment: new start/end on the clinic clock, doctor and room,
 * with the target day's free slots for the chosen doctor. A 409 lists the
 * bookings in the way, offers the next three free slots and the waitlist; a
 * patient overlap can be kept on purpose.
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
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [suggestions, setSuggestions] = useState<SlotSuggestionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startsAt = fromLocalInput(start, timezone);
  const endsAt = fromLocalInput(end, timezone);
  const durationMinutes = startsAt && endsAt && endsAt > startsAt ? Math.round(minutesBetween(startsAt, endsAt)) : 30;
  const dayKey = start.slice(0, 10);

  /** Moving the start keeps the appointment's length. */
  function moveStart(value: string) {
    const prevStart = fromLocalInput(start, timezone);
    const prevEnd = fromLocalInput(end, timezone);
    const next = fromLocalInput(value, timezone);
    setStart(value);
    if (prevStart && prevEnd && next) {
      setEnd(toLocalInput(new Date(next.getTime() + (prevEnd.getTime() - prevStart.getTime())), timezone));
    }
  }

  async function loadSuggestions(after: Date) {
    setSuggestions(null);
    try {
      const res = await apiFetch<FreeSlotsDTO>(
        freeSlotsUrl({
          doctorId: doctorId || undefined,
          room: room.trim() || undefined,
          date: dayKey,
          duration: durationMinutes,
          excludeId: appointment.id,
          after: after.toISOString(),
        }),
      );
      setSuggestions(res.suggestions);
    } catch {
      setSuggestions([]);
    }
  }

  async function submit(opts: { allowWaitlist?: boolean; allowPatientOverlap?: boolean; startsAt?: Date } = {}) {
    if (busy) return;
    const from = opts.startsAt ?? fromLocalInput(start, timezone);
    const to = opts.startsAt ? new Date(opts.startsAt.getTime() + durationMinutes * 60_000) : fromLocalInput(end, timezone);
    if (!from || !to) {
      setError("Enter a valid start and end time.");
      return;
    }
    if (to.getTime() <= from.getTime()) {
      setError("The end must be after the start.");
      return;
    }
    const minutes = minutesBetween(from, to);
    if (minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
      setError(`Appointments last between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes.`);
      return;
    }
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const res = await apiFetch<{ appointment: AppointmentDTO }>(`/api/appointments/${appointment.id}`, {
        method: "PATCH",
        body: {
          startsAt: from.toISOString(),
          endsAt: to.toISOString(),
          doctorId: doctorId || null,
          room: room.trim() || null,
          allowWaitlist: Boolean(opts.allowWaitlist),
          allowPatientOverlap: Boolean(opts.allowPatientOverlap),
        },
      });
      onDone(res.appointment, res.appointment.status === "WAITLISTED");
    } catch (err) {
      const found = conflictInfo(err);
      if (found) {
        setConflict(found);
        void loadSuggestions(from);
      } else {
        setError(describeApiError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function pickSlot(startsAtIso: string) {
    moveStart(toLocalInput(new Date(startsAtIso), timezone));
    setConflict(null);
  }

  function pickSuggestion(s: SlotSuggestionDTO) {
    const d = new Date(s.startsAt);
    moveStart(toLocalInput(d, timezone));
    setConflict(null);
    setSuggestions(null);
    void submit({ startsAt: d });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
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
        className="max-w-xl"
      >
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {conflict ? (
            <ConflictNotice
              conflict={conflict}
              timezone={timezone}
              dayKey={dayKey}
              suggestions={suggestions}
              onPickSuggestion={pickSuggestion}
              onWaitlist={conflict.kind === "slot" ? () => void submit({ allowWaitlist: true }) : undefined}
              onOverride={conflict.kind === "patient" ? () => void submit({ allowPatientOverlap: true }) : undefined}
              busy={busy}
            />
          ) : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Starts" htmlFor={`${id}-start`}>
              <Input id={`${id}-start`} type="datetime-local" value={start} onChange={(e) => moveStart(e.target.value)} required />
            </Field>
            <Field label="Ends" htmlFor={`${id}-end`}>
              <Input id={`${id}-end`} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Doctor" htmlFor={`${id}-doctor`} hint={doctorsError ?? undefined}>
              <Select id={`${id}-doctor`} value={doctorId} onChange={(e) => setDoctorId(e.target.value)} disabled={doctors === null}>
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
              <Input id={`${id}-room`} value={room} onChange={(e) => setRoom(e.target.value)} maxLength={60} placeholder="e.g. Room 2" />
            </Field>
          </div>

          <section aria-label="Free slots" className="rounded-lg border border-border p-3">
            <p className="mb-3 text-sm font-medium">Free slots on {dayKey}</p>
            <SlotPicker
              doctorId={doctorId}
              room={room.trim() || undefined}
              date={dayKey}
              durationMinutes={durationMinutes}
              excludeId={appointment.id}
              selectedStart={startsAt}
              onPick={pickSlot}
              timezone={timezone}
              disabled={busy}
            />
          </section>

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
