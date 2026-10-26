"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pause, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch } from "@/lib/http";
import type { EnrolmentStatus } from "@/modules/concierge/dto";
import { describeConciergeError } from "@/components/clinicmind/escalation-actions";

/**
 * Pause (optional reason), Resume, and Stop (reason required) for one
 * enrolment. Pausing holds every new message; stopping ends the follow-up
 * and closes the links still open.
 */
export function EnrolmentActions({ enrolmentId, status, patientName }: { enrolmentId: string; status: EnrolmentStatus; patientName: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<"pause" | "stop" | null>(null);
  const [busy, setBusy] = useState(false);

  async function resume() {
    setBusy(true);
    try {
      await apiFetch(`/api/concierge/enrolments/${enrolmentId}/resume`, { method: "POST" });
      toast({ title: "Follow-up resumed", description: "Steps that came due while paused go out now; any more than a day late are skipped.", tone: "success" });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not resume", description: describeConciergeError(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  if (status === "COMPLETED" || status === "STOPPED") return null;
  return (
    <div className="flex flex-wrap gap-2">
      {status === "ACTIVE" ? (
        <Button size="sm" variant="outline" onClick={() => setDialog("pause")} disabled={busy}>
          <Pause className="h-4 w-4" />
          Pause
        </Button>
      ) : (
        <Button size="sm" onClick={() => void resume()} disabled={busy}>
          <Play className="h-4 w-4" />
          {busy ? "Resuming…" : "Resume"}
        </Button>
      )}
      <Button size="sm" variant="outline" className="text-danger" onClick={() => setDialog("stop")} disabled={busy}>
        <Square className="h-4 w-4" />
        Stop
      </Button>
      {dialog ? (
        <ReasonDialog
          kind={dialog}
          patientName={patientName}
          enrolmentId={enrolmentId}
          onOpenChange={(open) => setDialog(open ? dialog : null)}
          onDone={() => {
            toast({ title: dialog === "pause" ? "Follow-up paused" : "Follow-up stopped", description: patientName, tone: "success" });
            setDialog(null);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function ReasonDialog({
  kind,
  patientName,
  enrolmentId,
  onOpenChange,
  onDone,
}: {
  kind: "pause" | "stop";
  patientName: string;
  enrolmentId: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stop = kind === "stop";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (stop && !reason.trim()) {
      setError("Say why the follow-up stops (it goes on the patient's timeline).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/concierge/enrolments/${enrolmentId}/${kind}`, { method: "POST", body: { reason: reason.trim() } });
      onDone();
    } catch (err) {
      setError(describeConciergeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title={stop ? "Stop the follow-up" : "Pause the follow-up"}
        description={
          stop
            ? `${patientName}: nothing more goes out, and check-in links still open stop working. This cannot be undone.`
            : `${patientName}: nothing new goes out until you resume. Links already sent still work.`
        }
      >
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label={stop ? "Reason" : "Reason (optional)"} htmlFor={id} hint={stop ? "Required" : "e.g. travelling, admitted elsewhere"}>
            <DictationField onDictated={setReason} disabled={busy}>
              <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus className="min-h-[4.5rem]" />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant={stop ? "danger" : "primary"} disabled={busy || (stop && !reason.trim())}>
              {busy ? (stop ? "Stopping…" : "Pausing…") : stop ? "Stop follow-up" : "Pause follow-up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
