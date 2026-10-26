"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Hand } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { ApiError, apiFetch } from "@/lib/http";
import type { EscalationDTO } from "@/modules/concierge/dto";
import { formatMinutes } from "@/modules/concierge/labels";

export function describeConciergeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Your role cannot do that.";
    if (err.status === 404) return "This no longer exists. Reload the page.";
    return err.message;
  }
  return "Could not reach the server. Please try again.";
}

/**
 * Acknowledge ("I have it") and Resolve (with a note of what was done) for one
 * escalation. Calls `onChanged` with the updated escalation, or refreshes the
 * server-rendered page when no handler is given.
 */
export function EscalationActions({
  escalation,
  onChanged,
  compact = false,
}: {
  escalation: EscalationDTO;
  onChanged?: (escalation: EscalationDTO) => void;
  compact?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(false);

  function changed(next: EscalationDTO) {
    if (onChanged) onChanged(next);
    else router.refresh();
  }

  async function acknowledge() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch<{ escalation: EscalationDTO }>(`/api/concierge/escalations/${escalation.id}/acknowledge`, { method: "POST" });
      const e = res.escalation;
      const late = e.acknowledgedAt ? (Date.parse(e.acknowledgedAt) - Date.parse(e.dueAt)) / 60_000 : 0;
      toast({
        title: e.acknowledgedWithinTarget ? "Acknowledged within the target" : `Acknowledged ${formatMinutes(late)} after the target`,
        description: `${e.patientName ?? "The patient"} · now call and resolve with a note.`,
        tone: e.acknowledgedWithinTarget ? "success" : "info",
      });
      changed(e);
    } catch (err) {
      toast({ title: "Could not acknowledge", description: describeConciergeError(err), tone: "danger" });
      if (err instanceof ApiError && err.status === 409) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (escalation.status === "RESOLVED") return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {escalation.status === "OPEN" ? (
        <Button size="sm" onClick={() => void acknowledge()} disabled={busy} aria-label={`Acknowledge the escalation for ${escalation.patientName ?? "this patient"}`}>
          <Hand className="h-4 w-4" />
          {busy ? "Acknowledging…" : "Acknowledge"}
        </Button>
      ) : null}
      <Button size="sm" variant="outline" onClick={() => setResolving(true)} disabled={busy} aria-label={`Resolve the escalation for ${escalation.patientName ?? "this patient"}`}>
        <CheckCheck className="h-4 w-4" />
        {compact ? "Resolve" : "Resolve…"}
      </Button>
      {resolving ? (
        <ResolveDialog
          escalation={escalation}
          onOpenChange={setResolving}
          onDone={(e) => {
            setResolving(false);
            toast({ title: "Escalation resolved", description: e.patientName ?? undefined, tone: "success" });
            changed(e);
          }}
        />
      ) : null}
    </div>
  );
}

function ResolveDialog({
  escalation,
  onOpenChange,
  onDone,
}: {
  escalation: EscalationDTO;
  onOpenChange: (open: boolean) => void;
  onDone: (escalation: EscalationDTO) => void;
}) {
  const id = useId();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const resolution = note.trim();
    if (!resolution) {
      setError("Say what was done (for example: called the patient, advice given, booked a review).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ escalation: EscalationDTO }>(`/api/concierge/escalations/${escalation.id}/resolve`, { method: "POST", body: { resolution } });
      onDone(res.escalation);
    } catch (err) {
      setError(describeConciergeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Resolve escalation" description={`${escalation.patientName ?? "Patient"} · ${escalation.summary}`}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {escalation.status === "OPEN" ? (
            <Alert tone="info">Resolving also acknowledges it now; the acknowledgement target is measured at this moment.</Alert>
          ) : null}
          <Field label="What was done" htmlFor={id} hint="Required · goes on the patient's timeline">
            <DictationField onDictated={setNote} disabled={busy}>
              <Textarea
                id={id}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                required
                autoFocus
                className="min-h-[6rem]"
                placeholder="e.g. Called the patient: light oozing, pressure advice given, review booked tomorrow 10:00"
              />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !note.trim()}>
              {busy ? "Resolving…" : "Resolve"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
