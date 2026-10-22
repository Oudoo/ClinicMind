"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { PatientFormDialog } from "@/components/clinicmind/patient-form-dialog";
import { apiErrorMessage, type PatientFormValues } from "@/components/clinicmind/patient-shared";

/**
 * Edit / archive (or restore) controls in the patient page header. The page
 * only renders this for roles holding `patients:write`.
 */
export function PatientHeaderActions({
  patientId,
  fullName,
  archived,
  form,
}: {
  patientId: string;
  fullName: string;
  archived: boolean;
  form: PatientFormValues;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function archive() {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/patients/${patientId}`, { method: "DELETE" });
      toast({
        title: "Patient archived",
        description: `${fullName} is hidden from the registry and can be restored later.`,
        tone: "success",
      });
      setConfirming(false);
      router.refresh();
    } catch (err) {
      toast({ title: "Could not archive the patient", description: apiErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/patients/${patientId}/restore`, { method: "POST" });
      toast({ title: "Patient restored", description: `${fullName} is back in the registry.`, tone: "success" });
      router.refresh();
    } catch (err) {
      toast({ title: "Could not restore the patient", description: apiErrorMessage(err), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  if (archived) {
    return (
      <Button type="button" variant="outline" onClick={restore} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
        Restore patient
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
        <Pencil className="h-4 w-4" />
        Edit
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-danger hover:bg-danger/10"
        onClick={() => setConfirming(true)}
      >
        <Archive className="h-4 w-4" />
        Archive
      </Button>

      <PatientFormDialog
        open={editing}
        onOpenChange={setEditing}
        target={{ mode: "edit", patientId, initial: form }}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Archive this patient?"
        description={`${fullName} will be hidden from the registry and from new bookings. Nothing is deleted — the record can be restored at any time.`}
        confirmLabel="Archive patient"
        tone="danger"
        busy={busy}
        onConfirm={archive}
      />
    </div>
  );
}
