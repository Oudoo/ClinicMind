"use client";

import { useId, useState, type FormEvent } from "react";
import { UserX } from "lucide-react";
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

/**
 * Marking a no-show is never one click: it counts towards the clinic's
 * no-show rate and records a missed appointment on the patient's timeline, so
 * the desk confirms it here, optionally with a note of what happened.
 */
export function NoShowDialog({
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
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ appointment: AppointmentDTO }>(`/api/appointments/${appointment.id}/transition`, {
        method: "POST",
        body: { status: "NO_SHOW", reason: reason.trim() || undefined },
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
        title={`Mark ${appointment.patient.fullName} as a no-show?`}
        description={`${formatDateTimeInTz(new Date(appointment.startsAt), timezone)}${appointment.doctor ? ` · ${appointment.doctor.fullName}` : ""}`}
      >
        <form onSubmit={submit} className="space-y-4" noValidate data-testid="no-show-dialog">
          {error ? <Alert>{error}</Alert> : null}
          <p className="text-sm text-muted-foreground">
            The booking counts towards the clinic&apos;s no-show rate and a missed appointment is added to the patient&apos;s
            timeline. If the patient turns up later today you can still re-book the slot and check them in.
          </p>
          <Field label="What happened" htmlFor={reasonId} hint={`Optional · up to ${MAX_REASON_LENGTH} characters`}>
            <DictationField onDictated={setReason} disabled={busy}>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={MAX_REASON_LENGTH}
                placeholder="e.g. Did not answer two calls"
              />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Keep the booking
              </Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={busy}>
              <UserX />
              {busy ? "Saving…" : "Mark as no-show"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
