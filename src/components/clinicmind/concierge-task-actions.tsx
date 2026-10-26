"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PhoneCall, Send, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import type { EnrolmentStatus, TaskDTO } from "@/modules/concierge/dto";
import { stepTitle, TRIAGE_TEXT } from "@/modules/concierge/labels";
import { describeConciergeError } from "@/components/clinicmind/escalation-actions";
import { CheckInAnswerDialog } from "@/components/clinicmind/check-in-answer-dialog";

/**
 * Per-step controls on the enrolment page: Send now (a fresh message and
 * link; the previous link stops working), Skip, and Record answer by phone.
 * Which ones show depends on the step and the enrolment's status.
 */
export function TaskActions({
  task,
  enrolmentStatus,
  patientName,
  dueSoon,
}: {
  task: TaskDTO;
  enrolmentStatus: EnrolmentStatus;
  patientName: string;
  /** The step goes out within two days (a call may cover it ahead of the link). */
  dueSoon: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [confirm, setConfirm] = useState<"send" | "skip" | null>(null);
  const [answering, setAnswering] = useState(false);
  const [busy, setBusy] = useState(false);

  const closed = enrolmentStatus === "STOPPED" || enrolmentStatus === "COMPLETED";
  const canSend = !closed && task.status !== "ANSWERED";
  const canSkip = task.status === "PENDING" || (task.status === "SENT" && task.kind !== "INSTRUCTION");
  const canAnswer =
    task.kind !== "INSTRUCTION" && enrolmentStatus !== "STOPPED" && ((task.status === "PENDING" && dueSoon) || task.status === "SENT" || task.status === "MISSED");
  if (!canSend && !canSkip && !canAnswer) return null;
  const label = stepTitle(task.dayLabel, task.title);

  async function run(kind: "send" | "skip") {
    setBusy(true);
    try {
      if (kind === "send") {
        const res = await apiFetch<{ delivery: string }>(`/api/concierge/tasks/${task.id}/send`, { method: "POST" });
        toast({
          title: res.delivery === "FAILED" ? "Sent, but delivery failed" : res.delivery === "LOGGED" ? "Message logged on the conversation" : "Message sent",
          description: res.delivery === "LOGGED" ? "No WhatsApp channel is connected: the message is on the patient's conversation." : label,
          tone: res.delivery === "FAILED" ? "danger" : "success",
        });
      } else {
        await apiFetch(`/api/concierge/tasks/${task.id}/skip`, { method: "POST" });
        toast({ title: "Step skipped", description: label, tone: "success" });
      }
      setConfirm(null);
      router.refresh();
    } catch (err) {
      toast({ title: kind === "send" ? "Could not send" : "Could not skip", description: describeConciergeError(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canAnswer ? (
        <Button size="sm" variant="outline" onClick={() => setAnswering(true)} disabled={busy}>
          <PhoneCall className="h-4 w-4" />
          Record answer
        </Button>
      ) : null}
      {canSend ? (
        <Button size="sm" variant="outline" onClick={() => setConfirm("send")} disabled={busy}>
          <Send className="h-4 w-4" />
          {task.status === "PENDING" || task.status === "SKIPPED" ? "Send now" : "Re-send"}
        </Button>
      ) : null}
      {canSkip ? (
        <Button size="sm" variant="ghost" onClick={() => setConfirm("skip")} disabled={busy}>
          <SkipForward className="h-4 w-4" />
          Skip
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === "skip" ? "Skip this step?" : task.status === "PENDING" ? "Send this step now?" : "Send this step again?"}
        description={
          confirm === "skip"
            ? `${label}: it will not go out${task.status === "SENT" ? ", and the link already sent stops working" : ""}.`
            : `${patientName} gets the ${task.dayLabel.toLowerCase()} message now${task.kind === "INSTRUCTION" ? "" : " with a fresh link; any earlier link stops working"}.`
        }
        confirmLabel={confirm === "skip" ? "Skip step" : "Send now"}
        tone={confirm === "skip" ? "danger" : "primary"}
        busy={busy}
        onConfirm={() => (confirm ? run(confirm) : undefined)}
      />
      {answering ? (
        <CheckInAnswerDialog
          task={task}
          patientName={patientName}
          onOpenChange={setAnswering}
          onDone={(result) => {
            setAnswering(false);
            toast({
              title: `Answer recorded · ${TRIAGE_TEXT[result.triage]}`,
              description: result.escalation
                ? `Escalation opened for ${result.escalation.assignedToName ?? "the roster"} (target ${result.escalation.targetMinutes ?? "—"} min).`
                : "Inside the expected ranges.",
              tone: result.triage === "OK" ? "success" : "info",
            });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
