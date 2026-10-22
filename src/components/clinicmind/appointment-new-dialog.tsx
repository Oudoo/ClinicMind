"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { apiFetch, fieldErrors } from "@/lib/http";
import { fromLocalInput } from "@/lib/time";
import type { AppointmentConflictDTO, AppointmentDTO } from "@/modules/appointments/dto";
import { DURATION_OPTIONS, MAX_REASON_LENGTH } from "@/modules/appointments/transitions";
import { PatientPicker, type PatientOption } from "./appointment-patient-picker";
import { ConflictNotice, conflictsFrom, describeApiError, useDoctors } from "./appointment-shared";

/**
 * Book a new appointment: patient search, doctor, date, start time and
 * duration on the clinic clock. A taken slot comes back as a 409 with the
 * bookings in the way and the option to waitlist instead.
 */
export function NewAppointmentDialog({
  timezone,
  defaultDate,
  defaultDoctorId = "",
  onOpenChange,
  onDone,
}: {
  timezone: string;
  /** `YYYY-MM-DD` on the clinic clock. */
  defaultDate: string;
  defaultDoctorId?: string;
  onOpenChange: (open: boolean) => void;
  onDone: (appointment: AppointmentDTO, waitlisted: boolean) => void;
}) {
  const id = useId();
  const { doctors, error: doctorsError } = useDoctors(true);
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [doctorId, setDoctorId] = useState(defaultDoctorId);
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("09:00");
  const [duration, setDuration] = useState<number>(30);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<AppointmentConflictDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const effectiveDoctorId = doctorId || (doctors?.length === 1 ? (doctors[0]?.id ?? "") : "");

  async function submit(allowWaitlist: boolean) {
    if (busy) return;
    const nextIssues: Record<string, string> = {};
    if (!patient) nextIssues.patientId = "Choose a patient.";
    if (!effectiveDoctorId) nextIssues.doctorId = "Choose a doctor.";
    const startsAt = fromLocalInput(`${date}T${time}`, timezone);
    if (!startsAt) nextIssues.startsAt = "Enter a valid date and time.";
    setIssues(nextIssues);
    if (!patient || !effectiveDoctorId || !startsAt) return;

    const endsAt = new Date(startsAt.getTime() + duration * 60_000);
    setBusy(true);
    setError(null);
    setConflicts(null);
    try {
      const res = await apiFetch<{ appointment: AppointmentDTO }>("/api/appointments", {
        method: "POST",
        body: {
          patientId: patient.id,
          doctorId: effectiveDoctorId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          reason: reason.trim() || undefined,
          notes: notes.trim() || undefined,
          allowWaitlist,
        },
      });
      onDone(res.appointment, res.appointment.status === "WAITLISTED");
    } catch (err) {
      const found = conflictsFrom(err);
      if (found) {
        setConflicts(found);
      } else {
        const fields = fieldErrors(err);
        setIssues(fields);
        setError(Object.keys(fields).length ? "Please check the highlighted fields." : describeApiError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void submit(false);
  }

  const issue = (key: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : undefined);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="New appointment" description={`Times on the clinic clock (${timezone}).`}>
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

          <PatientPicker value={patient} onChange={setPatient} error={issues.patientId} />

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

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              <Input
                id={`${id}-time`}
                type="time"
                step={300}
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
              />
            </Field>
            <Field label="Duration" htmlFor={`${id}-duration`} hint={issue("endsAt")}>
              <Select
                id={`${id}-duration`}
                value={String(duration)}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {DURATION_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Reason" htmlFor={`${id}-reason`} hint={issue("reason") ?? "Optional · shown on the schedule"}>
            <Input
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={MAX_REASON_LENGTH}
              placeholder="e.g. Follow-up, blood pressure check"
            />
          </Field>
          <Field label="Notes" htmlFor={`${id}-notes`} hint={issue("notes") ?? "Optional · for the front desk and the doctor"}>
            <Textarea
              id={`${id}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              className="min-h-[4.5rem]"
            />
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
