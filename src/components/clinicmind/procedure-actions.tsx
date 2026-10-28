"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck2, CheckCheck, PenLine, PlayCircle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz, fromLocalInput, toLocalInput } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { financeErrorMessage } from "./finance-shared";

interface SignResponse {
  procedure: { id: string };
  enrolment: { enrolmentId: string; tasks: number } | null;
}

/**
 * Sign a procedure (clinicians): it is charged to the patient, becomes
 * revenue, lands on the timeline and the patient is enrolled in the
 * treatment's aftercare protocol. On a course under way it completes it,
 * charging the sessions left (`left`).
 */
export function ProcedureSignButton({
  procedureId,
  label,
  left,
  onDone,
}: {
  procedureId: string;
  label: string;
  /** A course under way: the sessions not charged yet and what they come to. */
  left?: { sessions: number; amount: number };
  onDone?: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function sign() {
    setBusy(true);
    try {
      const res = await apiFetch<SignResponse>(`/api/procedures/${procedureId}/sign`, { method: "POST" });
      toast({
        tone: "success",
        title: "Procedure signed",
        description: res.enrolment ? `Aftercare started: ${res.enrolment.tasks} steps scheduled.` : "It now counts as revenue.",
      });
      setOpen(false);
      onDone?.();
      router.refresh();
    } catch (err) {
      toast({ tone: "danger", title: "Could not sign", description: financeErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant={left ? "outline" : "primary"} onClick={() => setOpen(true)} disabled={busy}>
        <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
        {left ? "Complete" : "Sign"}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={left ? "Complete this course now?" : "Sign this procedure?"}
        description={
          left
            ? `${label}. Completing it now charges the ${left.sessions === 1 ? "last session" : `${left.sessions} sessions left`} (${formatNumber(left.amount)} EGP) today, signs it and starts the patient's aftercare messages.`
            : `${label}. Signing records it as performed, charges it to the patient and starts the patient's aftercare messages. A signed procedure can no longer be edited.`
        }
        confirmLabel={busy ? "Signing…" : left ? "Complete and sign" : "Sign procedure"}
        busy={busy}
        onConfirm={sign}
      />
    </>
  );
}

/** Cancel a procedure with a reason (a signed one only by a clinician; the server enforces it). */
export function ProcedureCancelButton({ procedureId, label, onDone }: { procedureId: string; label: string; onDone?: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Say why it is cancelled.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/procedures/${procedureId}/cancel`, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: "Procedure cancelled" });
      setOpen(false);
      setReason("");
      onDone?.();
      router.refresh();
    } catch (err) {
      setError(financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Cancel ${label}`} title="Cancel this procedure">
        <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Cancel</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Cancel this procedure?" description={label}>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Reason" htmlFor={`${id}-reason`}>
              <DictationField onDictated={setReason} disabled={busy}>
                <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[4.5rem]" />
              </DictationField>
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Keep it
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? "Cancelling…" : "Cancel procedure"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Start work done in stages (the sessions of a course) on the day it started.
 * Nothing is charged yet: each session is, as it is done.
 */
export function ProcedureStartButton({ procedureId, label, stages, timezone, onDone }: { procedureId: string; label: string; stages: number; timezone: string; onDone?: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState(() => dateKeyInTz(new Date(), timezone));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/procedures/${procedureId}/start`, { method: "POST", body: { startedAt: day } });
      toast({ tone: "success", title: "Course started", description: `${stages} sessions, each charged as it is done.` });
      setOpen(false);
      onDone?.();
      router.refresh();
    } catch (err) {
      const found = fieldErrors(err);
      setError(found.startedAt ?? financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
        Start
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Start this course?" description={`${label} · ${stages} sessions. Each is charged its share when a clinician marks it done.`}>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Started on" htmlFor={`${id}-day`} hint="Today or earlier">
              <Input id={`${id}-day`} type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Not now
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy || !day}>
                {busy ? "Starting…" : "Start course"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface StageResponse {
  stage: number;
  of: number;
  amount: number;
  procedure: { status: string };
}

/**
 * A clinician marks the next session of a course done: it is charged its
 * share on that day. The last session completes and signs the course.
 */
export function ProcedureStageButton({
  procedureId,
  label,
  nextStage,
  stages,
  share,
  timezone,
  appointmentId,
  defaultWhen,
  onDone,
}: {
  procedureId: string;
  label: string;
  nextStage: number;
  stages: number;
  /** What this session is charged. */
  share: number;
  timezone: string;
  /** The visit it was done at, when known. */
  appointmentId?: string;
  /** When it was probably done (the visit's start); now when not given. */
  defaultWhen?: string;
  onDone?: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const initial = () => toLocalInput(defaultWhen ? new Date(defaultWhen) : new Date(), timezone);
  const [when, setWhen] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const last = nextStage === stages;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const performedAt = fromLocalInput(when, timezone);
    if (!performedAt) {
      setError("Enter the day and time it was done.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<StageResponse>(`/api/procedures/${procedureId}/stages`, {
        method: "POST",
        body: { performedAt: performedAt.toISOString(), ...(appointmentId ? { appointmentId } : {}) },
      });
      toast({
        tone: "success",
        title: res.procedure.status === "SIGNED" ? "Course complete" : `Session ${res.stage} of ${res.of} done`,
        description: `${formatNumber(res.amount)} EGP charged${res.procedure.status === "SIGNED" ? "; the course is signed." : "."}`,
      });
      setOpen(false);
      onDone?.();
      router.refresh();
    } catch (err) {
      const found = fieldErrors(err);
      setError(found.performedAt ?? financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          setWhen(initial());
          setOpen(true);
        }}
      >
        {last ? <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> : <CalendarCheck2 className="h-3.5 w-3.5" aria-hidden="true" />}
        Session {nextStage} done
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Session ${nextStage} of ${stages} done?`}
          description={`${label}. It is charged ${formatNumber(share)} EGP on the day it was done${last ? "; as the last session, it also completes and signs the course" : ""}.`}
        >
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Done on" htmlFor={`${id}-when`} hint="Not in the future">
              <Input id={`${id}-when`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Not now
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : last ? "Done: complete the course" : `Session ${nextStage} done`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
