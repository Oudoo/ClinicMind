"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { ChipInput } from "@/components/clinicmind/patient-chip-input";
import { apiErrorMessage, type HistoryFormValues } from "@/components/clinicmind/patient-shared";

const SECTIONS: { key: keyof HistoryFormValues; label: string; placeholder: string }[] = [
  { key: "chronicConditions", label: "Chronic conditions", placeholder: "e.g. Hypertension" },
  { key: "allergies", label: "Allergies", placeholder: "e.g. Penicillin" },
  { key: "diagnoses", label: "Diagnoses", placeholder: "e.g. Type 2 diabetes mellitus" },
  { key: "surgeries", label: "Surgeries", placeholder: "e.g. Appendectomy (2019)" },
];

/** "Edit history" button and the dialog editing all four medical history lists. */
export function MedicalHistoryEditor({ patientId, history }: { patientId: string; history: HistoryFormValues }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" />
        Edit history
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Edit medical history"
          description="Press Enter after each entry. Lists are kept free of duplicates."
          className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto"
        >
          {/* Mounted only while open, so every opening starts from the saved lists. */}
          <HistoryForm patientId={patientId} initial={history} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoryForm({
  patientId,
  initial,
  onDone,
}: {
  patientId: string;
  initial: HistoryFormValues;
  onDone: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<HistoryFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      await apiFetch(`/api/patients/${patientId}/history`, { method: "PATCH", body: values });
      toast({ title: "Medical history updated", tone: "success" });
      router.refresh();
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors(fields);
      setFormError(Object.keys(fields).length ? "Please check the highlighted lists." : apiErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {formError ? <Alert>{formError}</Alert> : null}
      {SECTIONS.map((section) => (
        <ChipInput
          key={section.key}
          id={`history-${section.key}`}
          label={section.label}
          values={values[section.key]}
          onChange={(list) => setValues((v) => ({ ...v, [section.key]: list }))}
          max={50}
          maxLength={120}
          placeholder={section.placeholder}
          error={errors[section.key]}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        A diagnosis added here is also recorded on the patient's timeline.
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save history
        </Button>
      </DialogFooter>
    </form>
  );
}
