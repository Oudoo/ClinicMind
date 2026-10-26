"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PenLine, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch } from "@/lib/http";
import { financeErrorMessage } from "./finance-shared";

interface SignResponse {
  procedure: { id: string };
  enrolment: { enrolmentId: string; tasks: number } | null;
}

/**
 * Sign a planned procedure (clinicians): it becomes revenue, lands on the
 * timeline and the patient is enrolled in the treatment's aftercare protocol.
 */
export function ProcedureSignButton({ procedureId, label, onDone }: { procedureId: string; label: string; onDone?: () => void }) {
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
      <Button type="button" size="sm" onClick={() => setOpen(true)} disabled={busy}>
        <PenLine className="h-3.5 w-3.5" aria-hidden="true" />
        Sign
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Sign this procedure?"
        description={`${label}. Signing records it as performed, counts it as revenue and starts the patient's aftercare messages. A signed procedure can no longer be edited.`}
        confirmLabel={busy ? "Signing…" : "Sign procedure"}
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
