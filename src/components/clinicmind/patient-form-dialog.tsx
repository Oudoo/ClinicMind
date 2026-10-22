"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { ChipInput } from "@/components/clinicmind/patient-chip-input";
import {
  EMPTY_PATIENT_FORM,
  GENDER_LABELS,
  LANGUAGE_LABELS,
  apiErrorMessage,
  type PatientFormValues,
  type PatientGender,
  type PatientLanguage,
} from "@/components/clinicmind/patient-shared";

export type PatientFormTarget =
  | { mode: "create" }
  | { mode: "edit"; patientId: string; initial: PatientFormValues };

/** Labelled input with the server's field error rendered as its hint. */
export function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <Field label={label} htmlFor={id} hint={error ? <span className="text-danger">{error}</span> : hint}>
      {children}
    </Field>
  );
}

/** Create or edit a patient in a modal. The form is remounted on every opening. */
export function PatientFormDialog({
  open,
  onOpenChange,
  target,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PatientFormTarget;
  onSaved?: (patientId: string) => void;
}) {
  const creating = target.mode === "create";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={creating ? "Add patient" : "Edit patient"}
        description={
          creating
            ? "Register a new patient in this clinic."
            : "Update the patient's profile and contact details."
        }
        className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto"
      >
        <PatientForm
          target={target}
          onCancel={() => onOpenChange(false)}
          onSaved={(id) => {
            onOpenChange(false);
            onSaved?.(id);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PatientForm({
  target,
  onCancel,
  onSaved,
}: {
  target: PatientFormTarget;
  onCancel: () => void;
  onSaved: (patientId: string) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<PatientFormValues>(
    target.mode === "edit" ? target.initial : EMPTY_PATIENT_FORM,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = <K extends keyof PatientFormValues>(key: K, value: PatientFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      const { patient } =
        target.mode === "create"
          ? await apiFetch<{ patient: { id: string } }>("/api/patients", { method: "POST", body: values })
          : await apiFetch<{ patient: { id: string } }>(`/api/patients/${target.patientId}`, {
              method: "PATCH",
              body: values,
            });
      toast({
        title: target.mode === "create" ? "Patient added" : "Patient updated",
        description: values.fullName.trim(),
        tone: "success",
      });
      router.refresh();
      onSaved(patient.id);
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors(fields);
      setFormError(Object.keys(fields).length ? "Please check the highlighted fields." : apiErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {formError ? <Alert>{formError}</Alert> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <FormField id="patient-fullName" label="Full name" error={errors.fullName}>
            <Input
              id="patient-fullName"
              value={values.fullName}
              onChange={(e) => set("fullName", e.target.value)}
              maxLength={120}
              required
              autoComplete="off"
              aria-invalid={errors.fullName ? true : undefined}
            />
          </FormField>
        </div>

        <FormField id="patient-gender" label="Gender" error={errors.gender}>
          <Select
            id="patient-gender"
            value={values.gender}
            onChange={(e) => set("gender", e.target.value as PatientGender)}
          >
            {(Object.keys(GENDER_LABELS) as PatientGender[]).map((g) => (
              <option key={g} value={g}>
                {GENDER_LABELS[g]}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField id="patient-dob" label="Date of birth" error={errors.dateOfBirth}>
          <Input
            id="patient-dob"
            type="date"
            value={values.dateOfBirth}
            onChange={(e) => set("dateOfBirth", e.target.value)}
            max={today}
            aria-invalid={errors.dateOfBirth ? true : undefined}
          />
        </FormField>

        <FormField id="patient-phone" label="Phone" hint="Digits, optional leading +" error={errors.phone}>
          <Input
            id="patient-phone"
            type="tel"
            inputMode="tel"
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            maxLength={20}
            autoComplete="off"
            aria-invalid={errors.phone ? true : undefined}
          />
        </FormField>

        <FormField id="patient-whatsapp" label="WhatsApp" error={errors.whatsapp}>
          <Input
            id="patient-whatsapp"
            type="tel"
            inputMode="tel"
            value={values.whatsapp}
            onChange={(e) => set("whatsapp", e.target.value)}
            maxLength={20}
            autoComplete="off"
            aria-invalid={errors.whatsapp ? true : undefined}
          />
        </FormField>

        <FormField id="patient-email" label="E-mail" error={errors.email}>
          <Input
            id="patient-email"
            type="email"
            inputMode="email"
            value={values.email}
            onChange={(e) => set("email", e.target.value)}
            maxLength={254}
            autoComplete="off"
            aria-invalid={errors.email ? true : undefined}
          />
        </FormField>

        <FormField id="patient-language" label="Preferred language" error={errors.language}>
          <Select
            id="patient-language"
            value={values.language}
            onChange={(e) => set("language", e.target.value as PatientLanguage)}
          >
            {(Object.keys(LANGUAGE_LABELS) as PatientLanguage[]).map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_LABELS[l]}
              </option>
            ))}
          </Select>
        </FormField>

        <div className="sm:col-span-2">
          <FormField
            id="patient-emergency"
            label="Emergency contact"
            hint="Name and number of whom to call"
            error={errors.emergencyContact}
          >
            <Input
              id="patient-emergency"
              value={values.emergencyContact}
              onChange={(e) => set("emergencyContact", e.target.value)}
              maxLength={200}
              autoComplete="off"
              aria-invalid={errors.emergencyContact ? true : undefined}
            />
          </FormField>
        </div>

        <div className="sm:col-span-2">
          <FormField id="patient-address" label="Address" error={errors.address}>
            <Input
              id="patient-address"
              value={values.address}
              onChange={(e) => set("address", e.target.value)}
              maxLength={300}
              autoComplete="off"
              aria-invalid={errors.address ? true : undefined}
            />
          </FormField>
        </div>

        <div className="sm:col-span-2">
          <ChipInput
            id="patient-tags"
            label="Tags"
            values={values.tags}
            onChange={(tags) => set("tags", tags)}
            max={10}
            maxLength={30}
            placeholder="Add a tag and press Enter"
            error={errors.tags}
          />
        </div>

        <div className="sm:col-span-2">
          <FormField id="patient-notes" label="Notes" error={errors.notes}>
            <Textarea
              id="patient-notes"
              value={values.notes}
              onChange={(e) => set("notes", e.target.value)}
              maxLength={2000}
              rows={3}
              aria-invalid={errors.notes ? true : undefined}
            />
          </FormField>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {target.mode === "create" ? "Add patient" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** "Add patient" button with its dialog, for the registry header. */
export function AddPatientButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4" />
        Add patient
      </Button>
      <PatientFormDialog open={open} onOpenChange={setOpen} target={{ mode: "create" }} />
    </>
  );
}
