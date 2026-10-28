"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { apiFetch } from "@/lib/http";
import { fromLocalInput, minutesBetween, toLocalInput } from "@/lib/time";
import type { AppointmentDTO, FreeSlotsDTO, SlotSuggestionDTO } from "@/modules/appointments/dto";
import { DEFAULT_WORKING_HOURS, MAX_DURATION_MINUTES, MIN_DURATION_MINUTES, type WorkingHours } from "@/modules/appointments/transitions";
import { SlotPicker } from "./appointment-slot-picker";
import {
  ConflictNotice,
  conflictInfo,
  describeApiError,
  freeSlotsUrl,
  OpeningHoursHint,
  staffLabel,
  TimeRuleNotice,
  timeRuleInfo,
  useDoctors,
  type ConflictInfo,
  type TimeRuleInfo,
} from "./appointment-shared";

/**
 * Move an appointment: new start/end on the clinic clock, doctor and room,
 * with the target day's free slots for the chosen doctor. A 409 lists the
 * bookings in the way, offers the next three free slots and the waitlist; a
 * patient overlap can be kept on purpose. A new time in the past or outside
 * the opening hours is refused with the reason (the owner may override).
 */
export function RescheduleAppointmentDialog({
  appointment,
  timezone,
  hours = DEFAULT_WORKING_HOURS,
  canOverride = false,
  onOpenChange,
  onDone,
}: {
  appointment: AppointmentDTO;
  timezone: string;
  /** The clinic's opening hours, for the closed-day hint. */
  hours?: WorkingHours;
  /** The viewer may move a booking into the past or outside the hours on purpose (users:manage). */
  canOverride?: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (appointment: AppointmentDTO, waitlisted: boolean) => void;
}) {
  const id = useId();
  const { doctors, error: doctorsError } = useDoctors(true, appointment.kind);
  const [start, setStart] = useState(() => toLocalInput(new Date(appointment.startsAt), timezone));
  const [end, setEnd] = useState(() => toLocalInput(new Date(appointment.endsAt), timezone));
  const [doctorId, setDoctorId] = useState(appointment.doctorId ?? "");
  const [room, setRoom] = useState(appointment.room ?? "");
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [timeRule, setTimeRule] = useState<TimeRuleInfo | null>(null);
  // Owner overrides asked for on purpose; moving the start again drops them.
  const [overrides, setOverrides] = useState({ allowPast: false, allowOutsideHours: false });
  const [suggestions, setSuggestions] = useState<SlotSuggestionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The form scrolls inside the dialog and the refusal (with its suggestions) is
  // shown at its top: scroll back up when one arrives, or it lands out of sight.
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!conflict && !error && !timeRule) return;
    const box = noticeRef.current?.closest<HTMLElement>("[role=dialog]");
    if (box) box.scrollTop = 0;
    else noticeRef.current?.scrollIntoView({ block: "start" });
  }, [conflict, error, timeRule]);

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
    setOverrides({ allowPast: false, allowOutsideHours: false });
    setTimeRule(null);
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

  async function submit(
    opts: { allowWaitlist?: boolean; allowPatientOverlap?: boolean; startsAt?: Date; allowPast?: boolean; allowOutsideHours?: boolean } = {},
  ) {
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
    const allowPast = opts.allowPast ?? overrides.allowPast;
    const allowOutsideHours = opts.allowOutsideHours ?? overrides.allowOutsideHours;
    setBusy(true);
    setError(null);
    setConflict(null);
    setTimeRule(null);
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
          ...(allowPast ? { allowPast: true } : {}),
          ...(allowOutsideHours ? { allowOutsideHours: true } : {}),
        },
      });
      onDone(res.appointment, res.appointment.status === "WAITLISTED");
    } catch (err) {
      const found = conflictInfo(err);
      const rule = timeRuleInfo(err);
      if (found) {
        setConflict(found);
        void loadSuggestions(from);
      } else if (rule) {
        setTimeRule({ ...rule, overridable: rule.overridable && canOverride });
      } else {
        setError(describeApiError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  /** The owner confirms the refused time on purpose (audited on the server). */
  function override(rule: TimeRuleInfo) {
    const next = { ...overrides, ...(rule.code === "in_the_past" ? { allowPast: true } : { allowOutsideHours: true }) };
    setOverrides(next);
    void submit(next);
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
    void submit({ startsAt: d, allowPast: false, allowOutsideHours: false });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  // The current doctor stays selectable even when they are not in the clinician
  // list any more (no longer a clinician, disabled), so an unchanged form still submits.
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
          <div ref={noticeRef} className="space-y-4 empty:hidden">
            {error ? <Alert>{error}</Alert> : null}
            {timeRule ? <TimeRuleNotice rule={timeRule} onOverride={() => override(timeRule)} busy={busy} /> : null}
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
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Starts" htmlFor={`${id}-start`} hint={<OpeningHoursHint date={dayKey} hours={hours} timezone={timezone} />}>
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
                        {staffLabel(d)}
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
