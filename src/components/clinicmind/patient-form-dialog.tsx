"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { ChipInput } from "@/components/clinicmind/patient-chip-input";
import {
  EMPTY_PATIENT_FORM,
  GENDER_LABELS,
  LANGUAGE_LABELS,
  MAX_AGE_YEARS,
  apiErrorMessage,
  duplicateInfo,
  oldestDateOfBirth,
  type DuplicateField,
  type DuplicateInfo,
  type DuplicateMatchView,
  type PatientFormValues,
  type PatientGender,
  type PatientLanguage,
} from "@/components/clinicmind/patient-shared";

export type PatientFormTarget =
  | { mode: "create" }
  | { mode: "edit"; patientId: string; initial: PatientFormValues };

/** Labelled input with the server's field error (or a warning) rendered as its hint. */
export function FormField({
  id,
  label,
  hint,
  error,
  warning,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  /** Shown instead of the hint, e.g. "This number belongs to …". */
  warning?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={error ? <span className="text-danger">{error}</span> : warning ? <span className="text-warning">{warning}</span> : hint}
    >
      {children}
    </Field>
  );
}

/** "This number belongs to Sara Ibrahim (open)": each existing record links to its page in a new tab. */
function DuplicateNote({ matches, field }: { matches: DuplicateMatchView[]; field: DuplicateField }) {
  const mine = matches.filter((m) => m.field === field);
  if (!mine.length) return null;
  return (
    <span data-testid={`duplicate-${field}`}>
      {field === "nationalId" ? "This national ID belongs to " : "This number belongs to "}
      {mine.map((m, i) => (
        <span key={m.id}>
          {i ? (i === mine.length - 1 ? " and " : ", ") : null}
          {m.fullName} (
          <Link href={`/dashboard/patients/${m.id}`} target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-foreground">
            open
          </Link>
          )
        </span>
      ))}
    </span>
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
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);
  const [pending, setPending] = useState(false);
  // The warning (with "Save anyway") sits at the top of a long form: bring it into view when it arrives.
  const warningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!duplicate) return;
    const box = warningRef.current?.closest<HTMLElement>("[role=dialog]");
    if (box) box.scrollTop = 0;
    else warningRef.current?.scrollIntoView({ block: "start" });
  }, [duplicate]);

  const set = <K extends keyof PatientFormValues>(key: K, value: PatientFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    // A changed number or id is checked afresh on the next save.
    if (key === "phone" || key === "whatsapp" || key === "nationalId") setDuplicate(null);
  };

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void save(false);
  }

  /** Save; `confirmDuplicate` is the deliberate "Save anyway" after a duplicate warning. */
  async function save(confirmDuplicate: boolean) {
    if (pending) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    const body = confirmDuplicate ? { ...values, confirmDuplicate: true } : values;
    try {
      const { patient } =
        target.mode === "create"
          ? await apiFetch<{ patient: { id: string } }>("/api/patients", { method: "POST", body })
          : await apiFetch<{ patient: { id: string } }>(`/api/patients/${target.patientId}`, {
              method: "PATCH",
              body,
            });
      toast({
        title: target.mode === "create" ? "Patient added" : "Patient updated",
        description: values.fullName.trim(),
        tone: "success",
      });
      router.refresh();
      onSaved(patient.id);
    } catch (err) {
      const dup = duplicateInfo(err);
      if (dup) {
        setDuplicate(dup);
        return;
      }
      const fields = fieldErrors(err);
      setErrors(fields);
      setFormError(Object.keys(fields).length ? "Please check the highlighted fields." : apiErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const oldest = oldestDateOfBirth();

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {formError ? <Alert>{formError}</Alert> : null}
      {duplicate ? (
        <div
          ref={warningRef}
          role="alert"
          className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-sm"
          data-testid="duplicate-warning"
        >
          <p className="font-medium text-warning">
            {duplicate.code === "duplicate_national_id" ? "This national ID is already on the registry." : "This number is already on the registry."}
          </p>
          <ul className="space-y-0.5 text-xs text-foreground">
            {(["nationalId", "phone", "whatsapp"] as const).map((field) =>
              duplicate.matches.some((m) => m.field === field) ? (
                <li key={field}>
                  <DuplicateNote matches={duplicate.matches} field={field} />
                </li>
              ) : null,
            )}
          </ul>
          <p className="text-xs text-muted-foreground">
            Open the existing record to check it is not the same person. Save anyway when it is someone else (a parent&apos;s
            number given for a child, a shared family phone).
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void save(true)} disabled={pending}>
            Save anyway
          </Button>
        </div>
      ) : null}

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

        <FormField id="patient-dob" label="Date of birth" hint={`Not in the future, at most ${MAX_AGE_YEARS} years ago`} error={errors.dateOfBirth}>
          <Input
            id="patient-dob"
            type="date"
            value={values.dateOfBirth}
            onChange={(e) => set("dateOfBirth", e.target.value)}
            min={oldest}
            max={today}
            aria-invalid={errors.dateOfBirth ? true : undefined}
          />
        </FormField>

        <FormField
          id="patient-phone"
          label="Phone"
          hint="Digits, optional leading +"
          error={errors.phone}
          warning={duplicate?.matches.some((m) => m.field === "phone") ? <DuplicateNote matches={duplicate.matches} field="phone" /> : undefined}
        >
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

        <FormField
          id="patient-whatsapp"
          label="WhatsApp"
          error={errors.whatsapp}
          warning={duplicate?.matches.some((m) => m.field === "whatsapp") ? <DuplicateNote matches={duplicate.matches} field="whatsapp" /> : undefined}
        >
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

        <FormField
          id="patient-nationalId"
          label="National ID"
          hint="ID or passport number · Arabic digits accepted"
          error={errors.nationalId}
          warning={duplicate?.matches.some((m) => m.field === "nationalId") ? <DuplicateNote matches={duplicate.matches} field="nationalId" /> : undefined}
        >
          <Input
            id="patient-nationalId"
            inputMode="numeric"
            value={values.nationalId}
            onChange={(e) => set("nationalId", e.target.value)}
            maxLength={40}
            autoComplete="off"
            aria-invalid={errors.nationalId ? true : undefined}
          />
        </FormField>

        <FormField id="patient-city" label="City" error={errors.city}>
          <Input
            id="patient-city"
            value={values.city}
            onChange={(e) => set("city", e.target.value)}
            maxLength={80}
            autoComplete="off"
            placeholder="e.g. Cairo"
            aria-invalid={errors.city ? true : undefined}
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
            <DictationField multiline={false} onDictated={(v) => set("address", v)} disabled={pending}>
              <Input
                id="patient-address"
                value={values.address}
                onChange={(e) => set("address", e.target.value)}
                maxLength={300}
                autoComplete="off"
                aria-invalid={errors.address ? true : undefined}
              />
            </DictationField>
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
            <DictationField onDictated={(v) => set("notes", v)} disabled={pending}>
              <Textarea
                id="patient-notes"
                value={values.notes}
                onChange={(e) => set("notes", e.target.value)}
                maxLength={2000}
                rows={3}
                aria-invalid={errors.notes ? true : undefined}
              />
            </DictationField>
          </FormField>
        </div>

        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="data-label">WhatsApp messages the patient agreed to</legend>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={values.reminderConsent} onChange={(e) => set("reminderConsent", e.target.checked)} className="mt-0.5" />
            <span>
              Treatment reminders
              <span className="block text-xs text-muted-foreground">Appointment reminders and recalls (reviews, the next session). On unless the patient says no.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={values.marketingConsent} onChange={(e) => set("marketingConsent", e.target.checked)} className="mt-0.5" />
            <span>
              Offers and news
              <span className="block text-xs text-muted-foreground">Including a message after a year without a visit. Only when the patient says yes.</span>
            </span>
          </label>
        </fieldset>
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
