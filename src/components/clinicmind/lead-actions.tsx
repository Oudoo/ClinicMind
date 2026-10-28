"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlus, Check, Pencil, RotateCcw, UserCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import { PIPELINE_STAGES, STAGE_LABELS, canMoveStage, stageIndex, type LeadSourceKey, type LeadStageKey, type ObjectionTagKey } from "@/modules/crm/shared";
import { LeadBookDialog } from "./lead-book-dialog";
import { LeadConvertDialog } from "./lead-convert-dialog";
import { LostDialog, ReopenDialog } from "./lead-lost-dialog";
import { LeadFormDialog, type LeadFormOptions, type LeadFormValues } from "./lead-new-dialog";
import { crmErrorMessage, type StaffOption } from "./lead-shared";

export interface LeadActionTarget {
  id: string;
  fullName: string;
  phone: string | null;
  stage: LeadStageKey;
  source: LeadSourceKey;
  patientId: string | null;
  objections: ObjectionTagKey[];
}

/** The buttons under a lead's name: edit, book, convert (or open the patient), lose or reopen. */
export function LeadHeaderActions({
  lead,
  form,
  options,
  doctors,
  timezone,
  defaultReason,
  canWrite,
  canBook,
}: {
  lead: LeadActionTarget;
  form: LeadFormValues;
  options: LeadFormOptions;
  doctors: StaffOption[];
  timezone: string;
  defaultReason: string;
  canWrite: boolean;
  canBook: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<null | "edit" | "book" | "convert" | "lost" | "reopen">(null);
  const close = (open: boolean) => !open && setDialog(null);
  const done = () => {
    setDialog(null);
    router.refresh();
  };
  const lost = lead.stage === "LOST";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canWrite ? (
        <Button variant="outline" size="sm" onClick={() => setDialog("edit")}>
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
      ) : null}
      {canBook && !lost ? (
        <Button size="sm" onClick={() => setDialog("book")}>
          <CalendarPlus className="h-4 w-4" />
          Book consultation
        </Button>
      ) : null}
      {lead.patientId ? (
        <Button asChild variant="outline" size="sm">
          <Link href={`/dashboard/patients/${lead.patientId}`}>
            <UserCheck className="h-4 w-4" />
            Patient record
          </Link>
        </Button>
      ) : canWrite ? (
        <Button variant="outline" size="sm" onClick={() => setDialog("convert")}>
          <UserCheck className="h-4 w-4" />
          Convert to patient
        </Button>
      ) : null}
      {canWrite && !lost && lead.stage !== "WON" ? (
        <Button variant="ghost" size="sm" className="text-danger hover:bg-danger/5" onClick={() => setDialog("lost")}>
          <XCircle className="h-4 w-4" />
          Mark lost
        </Button>
      ) : null}
      {canWrite && lost ? (
        <Button variant="outline" size="sm" onClick={() => setDialog("reopen")}>
          <RotateCcw className="h-4 w-4" />
          Reopen
        </Button>
      ) : null}

      {dialog === "edit" ? <LeadFormDialog mode="edit" leadId={lead.id} initial={form} options={options} onOpenChange={close} onDone={done} /> : null}
      {dialog === "book" ? <LeadBookDialog lead={lead} doctors={doctors} timezone={timezone} defaultReason={defaultReason} onOpenChange={close} onDone={done} /> : null}
      {dialog === "convert" ? <LeadConvertDialog lead={lead} onOpenChange={close} onDone={done} /> : null}
      {dialog === "lost" ? <LostDialog lead={lead} onOpenChange={close} onDone={done} /> : null}
      {dialog === "reopen" ? <ReopenDialog lead={lead} onOpenChange={close} onDone={done} /> : null}
    </div>
  );
}

/**
 * The pipeline as steps: done ones ticked, the current one highlighted, and
 * every step the rules allow (forward any distance, one back) is a button.
 */
export function LeadStageStepper({ lead, lostAtStage, canWrite }: { lead: { id: string; fullName: string; stage: LeadStageKey }; lostAtStage: LeadStageKey | null; canWrite: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState<LeadStageKey | null>(null);
  const reached = lead.stage === "LOST" ? (lostAtStage ?? "NEW") : lead.stage;

  async function move(stage: LeadStageKey) {
    setBusy(stage);
    try {
      await apiFetch(`/api/leads/${lead.id}/stage`, { method: "POST", body: { stage } });
      toast({ title: `${lead.fullName} → ${STAGE_LABELS[stage]}`, tone: "success" });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not move the lead", description: crmErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <ol className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:grid-cols-7" aria-label="Pipeline stages">
      {PIPELINE_STAGES.map((stage, i) => {
        const index = stageIndex(stage);
        const state = index < stageIndex(reached) ? "done" : stage === reached ? "current" : "todo";
        const allowed = canWrite && lead.stage !== "LOST" && canMoveStage(lead.stage, stage).ok;
        const body = (
          <>
            <span
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px]",
                state === "done" && "bg-success/15 text-success",
                state === "current" && (lead.stage === "LOST" ? "bg-danger text-white" : "bg-accent text-accent-foreground"),
                state === "todo" && "bg-muted text-muted-foreground",
              )}
              aria-hidden="true"
            >
              {state === "done" ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className="min-w-0 truncate">{STAGE_LABELS[stage]}</span>
          </>
        );
        const cls = cn(
          "flex h-9 w-full items-center gap-2 rounded-md border px-2 text-left text-xs font-medium",
          state === "current" ? (lead.stage === "LOST" ? "border-danger/40 bg-danger/5" : "border-accent bg-accent-muted text-accent") : "border-border",
          state === "todo" && "text-muted-foreground",
        );
        return (
          <li key={stage} aria-current={state === "current" ? "step" : undefined}>
            {allowed ? (
              <button type="button" className={cn(cls, "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50")} onClick={() => void move(stage)} disabled={busy !== null} aria-label={`Move to ${STAGE_LABELS[stage]}`} title={`Move to ${STAGE_LABELS[stage]}`}>
                {body}
                {busy === stage ? <span className="sr-only">Moving…</span> : null}
              </button>
            ) : (
              <div className={cls} title={state === "current" && lead.stage === "LOST" ? `Lost at ${STAGE_LABELS[stage]}` : undefined}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
