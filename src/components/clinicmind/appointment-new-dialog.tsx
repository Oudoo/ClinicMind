"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz, formatTimeInTz, fromDateKey, fromLocalInput } from "@/lib/time";
import type { AppointmentDTO, FreeSlotsDTO, SlotSuggestionDTO } from "@/modules/appointments/dto";
import { nextOpenStart } from "@/modules/appointments/rules";
import {
  APPOINTMENT_KINDS,
  DEFAULT_WORKING_HOURS,
  DURATION_OPTIONS,
  KIND_LABEL,
  MAX_REASON_LENGTH,
  type AppointmentKind,
  type WorkingHours,
} from "@/modules/appointments/transitions";
import { PatientPicker, type PatientOption } from "./appointment-patient-picker";
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

const DEFAULT_DURATION = 30;

/**
 * Where the form starts: the first slot inside the opening hours from now on
 * (or from the start of `defaultDate` when that day is still ahead), so a
 * booking never defaults to a closed day, a time before opening or the past.
 */
function initialSlot(defaultDate: string, hours: WorkingHours, timezone: string): { date: string; time: string; from: Date } {
  const now = new Date();
  const dayStart = fromDateKey(defaultDate, timezone);
  const from = dayStart && dayStart.getTime() > now.getTime() ? dayStart : now;
  const start = nextOpenStart(from, hours, timezone, DEFAULT_DURATION);
  if (!start) return { date: defaultDate, time: hours.start, from };
  return { date: dateKeyInTz(start, timezone), time: formatTimeInTz(start, timezone), from };
}

/**
 * Book a new appointment: patient search, doctor, kind, date, start time and
 * duration on the clinic clock, with the day's free slots laid out for the
 * chosen doctor. The form opens on the next free slot inside the opening
 * hours. A taken slot comes back as a 409 with the bookings in the way, the
 * next three free slots as one-tap buttons and the waitlist; a patient who is
 * already booked then can be booked anyway on purpose. A time in the past or
 * outside the opening hours is refused with the reason; the owner may
 * back-enter or book outside the hours on purpose.
 */
export function NewAppointmentDialog({
  timezone,
  hours = DEFAULT_WORKING_HOURS,
  canOverride = false,
  defaultDate,
  defaultDoctorId = "",
  defaultTime,
  presetPatient = null,
  onOpenChange,
  onDone,
}: {
  timezone: string;
  /** The clinic's opening hours (the default start and the closed-day hint follow them). */
  hours?: WorkingHours;
  /** The viewer may back-enter a past booking or book outside the hours (users:manage). */
  canOverride?: boolean;
  /** `YYYY-MM-DD` on the clinic clock. */
  defaultDate: string;
  defaultDoctorId?: string;
  /** `HH:mm` on the clinic clock; by default the next free slot inside the opening hours. */
  defaultTime?: string;
  /** Skip the patient search (booking from a patient's record). */
  presetPatient?: PatientOption | null;
  onOpenChange: (open: boolean) => void;
  onDone: (appointment: AppointmentDTO, waitlisted: boolean) => void;
}) {
  const id = useId();
  const [initial] = useState(() => initialSlot(defaultDate, hours, timezone));
  const [patient, setPatient] = useState<PatientOption | null>(presetPatient);
  const [doctorId, setDoctorId] = useState(defaultDoctorId);
  const [kind, setKind] = useState<AppointmentKind>("CONSULTATION");
  const { doctors, error: doctorsError } = useDoctors(true, kind);
  const [date, setDate] = useState(defaultTime ? defaultDate : initial.date);
  const [time, setTime] = useState(defaultTime ?? initial.time);
  // Once the user picks a date, a time or a slot, the form stops moving the start for them.
  const [touched, setTouched] = useState(Boolean(defaultTime));
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION);
  const [room, setRoom] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [timeRule, setTimeRule] = useState<TimeRuleInfo | null>(null);
  // Owner overrides asked for on purpose; any change of date or time drops them.
  const [overrides, setOverrides] = useState({ allowPast: false, allowOutsideHours: false });
  const [suggestions, setSuggestions] = useState<SlotSuggestionDTO[] | null>(null);
  const [showSlots, setShowSlots] = useState(true);
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

  // A doctor who cannot take this kind of booking (a nurse once it is no longer a procedure) is dropped.
  const selectable = doctors === null || !doctorId || doctors.some((d) => d.id === doctorId);
  const effectiveDoctorId = (selectable ? doctorId : "") || (doctors?.length === 1 ? (doctors[0]?.id ?? "") : "");
  const startsAt = fromLocalInput(`${date}T${time}`, timezone);

  // Until the user chooses a time, move the start to the doctor's first free slot.
  useEffect(() => {
    if (touched || !effectiveDoctorId) return;
    const controller = new AbortController();
    apiFetch<FreeSlotsDTO>(
      freeSlotsUrl({
        doctorId: effectiveDoctorId,
        date: initial.date,
        duration,
        after: new Date(initial.from.getTime() - 1).toISOString(),
      }),
      { signal: controller.signal },
    )
      .then((res) => {
        const first = res.suggestions[0];
        if (!first) return;
        setDate(first.date);
        setTime(formatTimeInTz(new Date(first.startsAt), timezone));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [touched, effectiveDoctorId, duration, initial, timezone]);

  function changeDate(value: string) {
    setTouched(true);
    setDate(value);
    setOverrides({ allowPast: false, allowOutsideHours: false });
    setTimeRule(null);
  }

  function changeTime(value: string) {
    setTouched(true);
    setTime(value);
    setOverrides({ allowPast: false, allowOutsideHours: false });
    setTimeRule(null);
  }

  async function loadSuggestions(after: Date) {
    setSuggestions(null);
    try {
      const res = await apiFetch<FreeSlotsDTO>(
        freeSlotsUrl({ doctorId: effectiveDoctorId || undefined, room: room.trim() || undefined, date, duration, after: after.toISOString() }),
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
    const nextIssues: Record<string, string> = {};
    if (!patient) nextIssues.patientId = "Choose a patient.";
    if (!effectiveDoctorId) nextIssues.doctorId = "Choose a doctor.";
    const start = opts.startsAt ?? fromLocalInput(`${date}T${time}`, timezone);
    if (!start) nextIssues.startsAt = "Enter a valid date and time.";
    setIssues(nextIssues);
    if (!patient || !effectiveDoctorId || !start) return;

    const endsAt = new Date(start.getTime() + duration * 60_000);
    const allowPast = opts.allowPast ?? overrides.allowPast;
    const allowOutsideHours = opts.allowOutsideHours ?? overrides.allowOutsideHours;
    setBusy(true);
    setError(null);
    setConflict(null);
    setTimeRule(null);
    try {
      const res = await apiFetch<{ appointment: AppointmentDTO }>("/api/appointments", {
        method: "POST",
        body: {
          patientId: patient.id,
          doctorId: effectiveDoctorId,
          kind,
          room: room.trim() || undefined,
          startsAt: start.toISOString(),
          endsAt: endsAt.toISOString(),
          reason: reason.trim() || undefined,
          notes: notes.trim() || undefined,
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
        void loadSuggestions(start);
      } else if (rule) {
        setTimeRule({ ...rule, overridable: rule.overridable && canOverride });
      } else {
        const fields = fieldErrors(err);
        setIssues(fields);
        setError(Object.keys(fields).length ? "Please check the highlighted fields." : describeApiError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function pickSlot(startsAtIso: string) {
    const d = new Date(startsAtIso);
    changeDate(dateKeyInTz(d, timezone));
    changeTime(formatTimeInTz(d, timezone));
    setConflict(null);
    setIssues((prev) => ({ ...prev, startsAt: "" }));
  }

  function pickSuggestion(s: SlotSuggestionDTO) {
    const d = new Date(s.startsAt);
    changeDate(s.date);
    changeTime(formatTimeInTz(d, timezone));
    setConflict(null);
    setSuggestions(null);
    void submit({ startsAt: d, allowPast: false, allowOutsideHours: false });
  }

  /** The owner confirms the refused time on purpose (audited on the server). */
  function override(rule: TimeRuleInfo) {
    const next = { ...overrides, ...(rule.code === "in_the_past" ? { allowPast: true } : { allowOutsideHours: true }) };
    setOverrides(next);
    void submit(next);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  const issue = (key: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : undefined);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="New appointment" description={`Times on the clinic clock (${timezone}).`} className="max-w-xl">
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div ref={noticeRef} className="space-y-4 empty:hidden">
            {error ? <Alert>{error}</Alert> : null}
            {timeRule ? <TimeRuleNotice rule={timeRule} onOverride={() => override(timeRule)} busy={busy} /> : null}
            {conflict ? (
              <ConflictNotice
                conflict={conflict}
                timezone={timezone}
                dayKey={date}
                suggestions={suggestions}
                onPickSuggestion={pickSuggestion}
                onWaitlist={conflict.kind === "slot" ? () => void submit({ allowWaitlist: true }) : undefined}
                onOverride={conflict.kind === "patient" ? () => void submit({ allowPatientOverlap: true }) : undefined}
                busy={busy}
              />
            ) : null}
          </div>

          <PatientPicker value={patient} onChange={setPatient} error={issues.patientId} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Doctor" htmlFor={`${id}-doctor`} hint={issue("doctorId") ?? doctorsError ?? undefined}>
              <Select
                id={`${id}-doctor`}
                value={effectiveDoctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                disabled={doctors === null}
                aria-invalid={issues.doctorId ? true : undefined}
                required
              >
                {doctors === null ? (
                  <option value="">Loading…</option>
                ) : (
                  <option value="">{doctors.length ? "Choose a doctor" : "No active doctors"}</option>
                )}
                {(doctors ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {staffLabel(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Kind" htmlFor={`${id}-kind`} hint={issue("kind")}>
              <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as AppointmentKind)}>
                {APPOINTMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1.45fr)_minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Field label="Date" htmlFor={`${id}-date`} hint={issue("startsAt")}>
              <Input
                id={`${id}-date`}
                type="date"
                value={date}
                onChange={(e) => changeDate(e.target.value)}
                aria-invalid={issues.startsAt ? true : undefined}
                aria-describedby={`${id}-hours`}
                required
              />
            </Field>
            <Field label="Start" htmlFor={`${id}-time`}>
              <Input id={`${id}-time`} type="time" step={900} value={time} onChange={(e) => changeTime(e.target.value)} required />
            </Field>
            <Field label="Duration" htmlFor={`${id}-duration`} hint={issue("endsAt")}>
              <Select id={`${id}-duration`} value={String(duration)} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATION_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Room" htmlFor={`${id}-room`} hint={issue("room") ?? "Optional"}>
              <Input id={`${id}-room`} value={room} onChange={(e) => setRoom(e.target.value)} maxLength={60} placeholder="e.g. Room 2" />
            </Field>
          </div>
          <p id={`${id}-hours`} className="-mt-2 text-xs text-muted-foreground">
            <OpeningHoursHint date={date} hours={hours} timezone={timezone} />
          </p>

          <section aria-label="Free slots" className="rounded-lg border border-border p-3">
            <button
              type="button"
              onClick={() => setShowSlots((v) => !v)}
              aria-expanded={showSlots}
              className="flex w-full items-center justify-between text-left text-sm font-medium"
            >
              <span>Free slots {effectiveDoctorId ? "for this doctor" : ""}</span>
              {showSlots ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
            {showSlots ? (
              <div className="mt-3">
                <SlotPicker
                  doctorId={effectiveDoctorId}
                  room={room.trim() || undefined}
                  date={date}
                  durationMinutes={duration}
                  selectedStart={startsAt}
                  onPick={pickSlot}
                  timezone={timezone}
                  disabled={busy}
                />
              </div>
            ) : null}
          </section>

          <Field label="Reason" htmlFor={`${id}-reason`} hint={issue("reason") ?? "Optional · shown on the schedule"}>
            <DictationField multiline={false} onDictated={setReason} disabled={busy}>
              <Input
                id={`${id}-reason`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={MAX_REASON_LENGTH}
                placeholder="e.g. Follow-up, blood pressure check"
              />
            </DictationField>
          </Field>
          <Field label="Notes" htmlFor={`${id}-notes`} hint={issue("notes") ?? "Optional · for the front desk and the doctor"}>
            <DictationField onDictated={setNotes} disabled={busy}>
              <Textarea
                id={`${id}-notes`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                className="min-h-[4.5rem]"
              />
            </DictationField>
          </Field>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Booking…" : "Book appointment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
