"use client";

import { useId, useState, type FormEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz, formatTimeInTz, fromLocalInput } from "@/lib/time";
import type { AppointmentDTO, FreeSlotsDTO, SlotSuggestionDTO } from "@/modules/appointments/dto";
import {
  APPOINTMENT_KINDS,
  DURATION_OPTIONS,
  KIND_LABEL,
  MAX_REASON_LENGTH,
  type AppointmentKind,
} from "@/modules/appointments/transitions";
import { PatientPicker, type PatientOption } from "./appointment-patient-picker";
import { SlotPicker } from "./appointment-slot-picker";
import { ConflictNotice, conflictInfo, describeApiError, freeSlotsUrl, useDoctors, type ConflictInfo } from "./appointment-shared";

/**
 * Book a new appointment: patient search, doctor, kind, date, start time and
 * duration on the clinic clock, with the day's free slots laid out for the
 * chosen doctor. A taken slot comes back as a 409 with the bookings in the
 * way, the next three free slots as one-tap buttons and the waitlist; a
 * patient who is already booked then can be booked anyway on purpose.
 */
export function NewAppointmentDialog({
  timezone,
  defaultDate,
  defaultDoctorId = "",
  defaultTime = "10:00",
  presetPatient = null,
  onOpenChange,
  onDone,
}: {
  timezone: string;
  /** `YYYY-MM-DD` on the clinic clock. */
  defaultDate: string;
  defaultDoctorId?: string;
  /** `HH:mm` on the clinic clock. */
  defaultTime?: string;
  /** Skip the patient search (booking from a patient's record). */
  presetPatient?: PatientOption | null;
  onOpenChange: (open: boolean) => void;
  onDone: (appointment: AppointmentDTO, waitlisted: boolean) => void;
}) {
  const id = useId();
  const { doctors, error: doctorsError } = useDoctors(true);
  const [patient, setPatient] = useState<PatientOption | null>(presetPatient);
  const [doctorId, setDoctorId] = useState(defaultDoctorId);
  const [kind, setKind] = useState<AppointmentKind>("CONSULTATION");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultTime);
  const [duration, setDuration] = useState<number>(30);
  const [room, setRoom] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  const [suggestions, setSuggestions] = useState<SlotSuggestionDTO[] | null>(null);
  const [showSlots, setShowSlots] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveDoctorId = doctorId || (doctors?.length === 1 ? (doctors[0]?.id ?? "") : "");
  const startsAt = fromLocalInput(`${date}T${time}`, timezone);

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

  async function submit(opts: { allowWaitlist?: boolean; allowPatientOverlap?: boolean; startsAt?: Date } = {}) {
    if (busy) return;
    const nextIssues: Record<string, string> = {};
    if (!patient) nextIssues.patientId = "Choose a patient.";
    if (!effectiveDoctorId) nextIssues.doctorId = "Choose a doctor.";
    const start = opts.startsAt ?? fromLocalInput(`${date}T${time}`, timezone);
    if (!start) nextIssues.startsAt = "Enter a valid date and time.";
    setIssues(nextIssues);
    if (!patient || !effectiveDoctorId || !start) return;

    const endsAt = new Date(start.getTime() + duration * 60_000);
    setBusy(true);
    setError(null);
    setConflict(null);
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
        },
      });
      onDone(res.appointment, res.appointment.status === "WAITLISTED");
    } catch (err) {
      const found = conflictInfo(err);
      if (found) {
        setConflict(found);
        void loadSuggestions(start);
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
    setDate(dateKeyInTz(d, timezone));
    setTime(formatTimeInTz(d, timezone));
    setConflict(null);
    setIssues((prev) => ({ ...prev, startsAt: "" }));
  }

  function pickSuggestion(s: SlotSuggestionDTO) {
    const d = new Date(s.startsAt);
    setDate(s.date);
    setTime(formatTimeInTz(d, timezone));
    setConflict(null);
    setSuggestions(null);
    void submit({ startsAt: d });
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
          {error ? <Alert>{error}</Alert> : null}
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
                    {d.fullName}
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

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Date" htmlFor={`${id}-date`} hint={issue("startsAt")}>
              <Input
                id={`${id}-date`}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-invalid={issues.startsAt ? true : undefined}
                required
              />
            </Field>
            <Field label="Start" htmlFor={`${id}-time`}>
              <Input id={`${id}-time`} type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} required />
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
