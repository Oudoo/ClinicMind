"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { LeadSourceKey } from "@/modules/crm/shared";
import { PatientPicker, type PatientOption } from "./appointment-patient-picker";
import { crmErrorMessage } from "./lead-shared";

/**
 * Convert a lead into a patient: create the record from the lead's details,
 * or link the patient the lead already is (patients with the same number are
 * offered first, so the desk does not create a duplicate).
 */
export function LeadConvertDialog({
  lead,
  onOpenChange,
  onDone,
}: {
  lead: { id: string; fullName: string; phone: string | null; source: LeadSourceKey; language?: "ar" | "en" };
  onOpenChange: (open: boolean) => void;
  onDone: (patient: { id: string; fullName: string }, created: boolean) => void;
}) {
  const id = useId();
  const { toast } = useToast();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [language, setLanguage] = useState<"ar" | "en">(lead.language ?? "ar");
  const [referredBy, setReferredBy] = useState("");
  const [patient, setPatient] = useState<PatientOption | null>(null);
  const [matches, setMatches] = useState<PatientOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Same number already on file? Offer it before a second record is made.
  useEffect(() => {
    const digits = lead.phone?.replace(/\D/g, "").slice(-9);
    if (!digits || digits.length < 7) return;
    const controller = new AbortController();
    apiFetch<{ patients: PatientOption[] }>(`/api/patients?q=${encodeURIComponent(digits)}&pageSize=5`, { signal: controller.signal })
      .then((res) => {
        setMatches(res.patients.slice(0, 3));
        if (res.patients.length) setMode("existing");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [lead.phone]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (mode === "existing" && !patient) {
      setError("Choose the patient to link.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ patient: { id: string; fullName: string }; created: boolean }>(`/api/leads/${lead.id}/convert`, {
        method: "POST",
        body: mode === "existing" ? { patientId: patient!.id, referredBy } : { language, referredBy },
      });
      toast({ title: res.created ? `Patient record created for ${res.patient.fullName}` : `Linked to ${res.patient.fullName}`, tone: "success" });
      onDone(res.patient, res.created);
    } catch (err) {
      setError(crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const option = (value: "new" | "existing", title: string, text: string) => (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors",
        mode === value ? "border-accent bg-accent-muted/60" : "border-border hover:bg-muted",
      )}
    >
      <input type="radio" name={`${id}-mode`} value={value} checked={mode === value} onChange={() => setMode(value)} className="mt-1 h-4 w-4 accent-[hsl(var(--accent))]" />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{text}</span>
      </span>
    </label>
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={`Convert ${lead.fullName} to a patient`} description="The patient keeps the lead's source, and the timeline notes how they came in.">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How to convert">
            {option("new", "Create a new record", "From the lead's name, phone and e-mail.")}
            {option("existing", "Link an existing patient", "The lead is someone already on file.")}
          </div>
          {mode === "new" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Language" htmlFor={`${id}-lang`}>
                <Select id={`${id}-lang`} value={language} onChange={(e) => setLanguage(e.target.value as "ar" | "en")}>
                  <option value="ar">Arabic</option>
                  <option value="en">English</option>
                </Select>
              </Field>
              <Field label="Referred by" htmlFor={`${id}-ref`} hint={lead.source === "REFERRAL" ? "Who sent them" : "Optional"}>
                <Input id={`${id}-ref`} value={referredBy} onChange={(e) => setReferredBy(e.target.value)} maxLength={120} />
              </Field>
            </div>
          ) : (
            <div className="space-y-3">
              {matches.length ? (
                <div className="space-y-1.5">
                  <p className="data-label">Same number on file</p>
                  <div className="flex flex-wrap gap-1.5">
                    {matches.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setPatient(m)}
                        aria-pressed={patient?.id === m.id}
                        className={cn("inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs", patient?.id === m.id ? "border-accent bg-accent-muted text-accent" : "border-border hover:bg-muted")}
                      >
                        {m.fullName}
                        {m.phone ? <span className="font-mono text-muted-foreground">{m.phone}</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <PatientPicker value={patient} onChange={setPatient} />
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Converting…" : mode === "existing" ? "Link patient" : "Create patient"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
