"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch } from "@/lib/http";
import { formatDateTimeInTz } from "@/lib/time";
import type { AppointmentDTO } from "@/modules/appointments/dto";
import { MAX_REASON_LENGTH } from "@/modules/appointments/transitions";
import { describeApiError } from "./appointment-shared";

/** Cancelling needs a reason; it is stored on the booking and the patient timeline. */
export function CancelAppointmentDialog({
  appointment,
  timezone,
  onOpenChange,
  onDone,
}: {
  appointment: AppointmentDTO;
  timezone: string;
  onOpenChange: (open: boolean) => void;
  onDone: (appointment: AppointmentDTO) => void;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setError("Please say why the appointment is being cancelled.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ appointment: AppointmentDTO }>(`/api/appointments/${appointment.id}/transition`, {
        method: "POST",
        body: { status: "CANCELLED", reason: trimmed },
      });
      onDone(res.appointment);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title="Cancel appointment"
        description={`${appointment.patient.fullName} · ${formatDateTimeInTz(new Date(appointment.startsAt), timezone)}`}
      >
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Reason" htmlFor={reasonId} hint={`Required · up to ${MAX_REASON_LENGTH} characters`}>
            <DictationField onDictated={setReason} disabled={busy}>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={MAX_REASON_LENGTH}
                required
                autoFocus
                placeholder="e.g. Patient asked to cancel by phone"
              />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Keep appointment
              </Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={busy || !reason.trim()}>
              {busy ? "Cancelling…" : "Cancel appointment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
