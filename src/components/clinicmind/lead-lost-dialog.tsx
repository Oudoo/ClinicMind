"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { LOST_REASONS, LOST_REASON_LABELS, OBJECTION_LABELS, OBJECTION_TAGS, STAGE_LABELS, type LeadStageKey, type LostReasonKey, type ObjectionTagKey } from "@/modules/crm/shared";
import { crmErrorMessage } from "./lead-shared";

export interface LostTarget {
  id: string;
  fullName: string;
  stage: LeadStageKey;
  /** Objections already on the lead (or suggested by its conversations): pre-ticked. */
  objections: ObjectionTagKey[];
}

/**
 * Mark a lead lost: why (required), a note, and the objections staff heard.
 * The stage it was lost at is recorded by the server; open follow-ups close.
 */
export function LostDialog({ lead, onOpenChange, onDone }: { lead: LostTarget; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const id = useId();
  const { toast } = useToast();
  const [reason, setReason] = useState<LostReasonKey | "">("");
  const [note, setNote] = useState("");
  const [objections, setObjections] = useState<ObjectionTagKey[]>(lead.objections);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!reason) {
      setIssues({ reason: "Choose why the lead was lost." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leads/${lead.id}/lost`, { method: "POST", body: { reason, note, objections } });
      toast({ title: `${lead.fullName} marked lost`, description: LOST_REASON_LABELS[reason], tone: "success" });
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={`Mark ${lead.fullName} lost`} description={`Lost at “${STAGE_LABELS[lead.stage]}”. Open follow-ups are closed.`}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Reason" htmlFor={`${id}-reason`} hint={issues.reason ? <span className="text-danger">{issues.reason}</span> : undefined}>
            <Select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as LostReasonKey)} aria-invalid={issues.reason ? true : undefined} autoFocus>
              <option value="">Choose a reason</option>
              {LOST_REASONS.map((r) => (
                <option key={r} value={r}>
                  {LOST_REASON_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="space-y-2">
            <legend className="data-label">Objections heard</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {OBJECTION_TAGS.map((tag) => (
                <label key={tag} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={objections.includes(tag)}
                    onChange={(e) => setObjections((xs) => (e.target.checked ? [...xs, tag] : xs.filter((x) => x !== tag)))}
                  />
                  {OBJECTION_LABELS[tag]}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Note" htmlFor={`${id}-note`} hint={issues.note ? <span className="text-danger">{issues.note}</span> : "Optional · what they said, in their words"}>
            <DictationField onDictated={setNote} disabled={busy}>
              <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="min-h-[4.5rem]" />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? "Saving…" : "Mark lost"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Reopen a lost lead: it returns to the stage it was lost at. */
export function ReopenDialog({ lead, onOpenChange, onDone }: { lead: { id: string; fullName: string }; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title={`Reopen ${lead.fullName}?`}
      description="The lead goes back to the stage it was lost at, and the lost reason is cleared."
      confirmLabel={busy ? "Reopening…" : "Reopen lead"}
      busy={busy}
      onConfirm={async () => {
        setBusy(true);
        try {
          await apiFetch(`/api/leads/${lead.id}/reopen`, { method: "POST", body: {} });
          toast({ title: `${lead.fullName} reopened`, tone: "success" });
          onDone();
        } catch (err) {
          toast({ title: "Could not reopen the lead", description: crmErrorMessage(err), tone: "danger" });
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
