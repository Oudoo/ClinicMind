"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { PatientPicker, type PatientOption } from "@/components/clinicmind/appointment-patient-picker";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz, fromLocalInput } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { METHOD_LABELS, PAYMENT_METHODS, type PaymentMethodValue } from "@/modules/finance/constants";
import { financeErrorMessage, type DoctorOption, type TreatmentOption } from "./finance-shared";

/**
 * Record a procedure (planned until a clinician signs it): the treatment with
 * its catalogue price prefilled, the doctor, the date and time on the clinic
 * clock, price, discount, notes and, for roles that take money, a deposit in
 * the same step.
 */
export function RecordProcedureDialog({
  timezone,
  treatments,
  doctors,
  canDeposit,
  patient: presetPatient = null,
  defaultDoctorId = "",
  onOpenChange,
  onDone,
}: {
  timezone: string;
  treatments: TreatmentOption[];
  doctors: DoctorOption[];
  canDeposit: boolean;
  patient?: PatientOption | null;
  defaultDoctorId?: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const id = useId();
  const first = treatments[0];
  const [patient, setPatient] = useState<PatientOption | null>(presetPatient);
  const [treatmentId, setTreatmentId] = useState(first?.id ?? "");
  const [doctorId, setDoctorId] = useState(defaultDoctorId || (doctors.length === 1 ? (doctors[0]?.id ?? "") : ""));
  const [date, setDate] = useState(dateKeyInTz(new Date(), timezone));
  const [time, setTime] = useState("11:00");
  const [price, setPrice] = useState(first?.priceFrom ? String(first.priceFrom) : "");
  const [discount, setDiscount] = useState("0");
  const [notes, setNotes] = useState("");
  const [takeDeposit, setTakeDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState(first?.depositAmount ? String(first.depositAmount) : "");
  const [depositMethod, setDepositMethod] = useState<PaymentMethodValue>("CASH");
  const [depositReference, setDepositReference] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const treatment = treatments.find((t) => t.id === treatmentId) ?? null;
  const range =
    treatment && treatment.priceFrom !== null
      ? treatment.priceTo && treatment.priceTo !== treatment.priceFrom
        ? `Catalogue: ${formatNumber(treatment.priceFrom)}–${formatNumber(treatment.priceTo)} EGP`
        : `Catalogue: ${formatNumber(treatment.priceFrom)} EGP`
      : "Whole EGP";

  function pickTreatment(nextId: string) {
    setTreatmentId(nextId);
    const t = treatments.find((x) => x.id === nextId);
    if (t?.priceFrom) setPrice(String(t.priceFrom));
    setDepositAmount(t?.depositAmount ? String(t.depositAmount) : "");
  }

  const toInt = (s: string) => Number(s.replace(/[,\s]/g, ""));
  const net = Math.max(0, (Number.isFinite(toInt(price)) ? toInt(price) : 0) - (Number.isFinite(toInt(discount)) ? toInt(discount) : 0));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (!patient) next.patientId = "Choose a patient.";
    if (!treatmentId) next.treatmentId = "Choose a treatment.";
    const p = toInt(price);
    const d = toInt(discount || "0");
    if (!Number.isInteger(p) || p < 0) next.price = "Whole EGP.";
    if (!Number.isInteger(d) || d < 0) next.discount = "Whole EGP.";
    else if (Number.isInteger(p) && d > p) next.discount = "Discount cannot exceed the price.";
    const performedAt = fromLocalInput(`${date}T${time}`, timezone);
    if (!performedAt) next.performedAt = "Enter a valid date and time.";
    const dep = toInt(depositAmount);
    if (takeDeposit && (!Number.isInteger(dep) || dep <= 0)) next.deposit = "Whole EGP, more than zero.";
    setIssues(next);
    if (Object.keys(next).length || !patient || !performedAt) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/procedures", {
        method: "POST",
        body: {
          patientId: patient.id,
          treatmentId,
          doctorId: doctorId || undefined,
          performedAt: performedAt.toISOString(),
          price: p,
          discount: d,
          notes: notes.trim() || undefined,
          deposit: takeDeposit ? { amount: dep, method: depositMethod, reference: depositReference.trim() || undefined } : undefined,
        },
      });
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const issue = (key: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : undefined);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Record a procedure" description="Planned until a clinician signs it; signing makes it revenue and starts the aftercare protocol." className="max-w-xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {presetPatient ? (
            <p className="text-sm">
              <span className="data-label mr-2">Patient</span>
              <span className="font-medium">{presetPatient.fullName}</span>
            </p>
          ) : (
            <PatientPicker value={patient} onChange={setPatient} error={issues.patientId} />
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Treatment" htmlFor={`${id}-treatment`} hint={issue("treatmentId")}>
              <Select id={`${id}-treatment`} value={treatmentId} onChange={(e) => pickTreatment(e.target.value)}>
                {treatments.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Doctor" htmlFor={`${id}-doctor`} hint={issue("doctorId") ?? "The signer when left empty"}>
              <Select id={`${id}-doctor`} value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                <option value="">Not set</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" htmlFor={`${id}-date`} hint={issue("performedAt")}>
              <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={issues.performedAt ? true : undefined} />
            </Field>
            <Field label="Time" htmlFor={`${id}-time`}>
              <Input id={`${id}-time`} type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price (EGP)" htmlFor={`${id}-price`} hint={issue("price")}>
              <Input id={`${id}-price`} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={issues.price ? true : undefined} />
            </Field>
            <Field label="Discount (EGP)" htmlFor={`${id}-discount`} hint={issue("discount")}>
              <Input id={`${id}-discount`} inputMode="numeric" value={discount} onChange={(e) => setDiscount(e.target.value)} aria-invalid={issues.discount ? true : undefined} />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            {range} · to pay: <span className="font-mono tabular-nums text-foreground">{formatNumber(net)} EGP</span>
          </p>

          <Field label="Notes" htmlFor={`${id}-notes`} hint={issue("notes") ?? "Optional · e.g. graft count, areas, package"}>
            <DictationField onDictated={setNotes} disabled={busy} patientId={patient?.id ?? null}>
              <Textarea id={`${id}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} className="min-h-[4.5rem]" />
            </DictationField>
          </Field>

          {canDeposit ? (
            <fieldset className="space-y-3 rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={takeDeposit} onChange={(e) => setTakeDeposit(e.target.checked)} />
                Take a deposit now
              </label>
              {takeDeposit ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <Field label="Deposit (EGP)" htmlFor={`${id}-dep`} hint={issue("deposit") ?? issue("deposit.amount")}>
                    <Input id={`${id}-dep`} inputMode="numeric" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
                  </Field>
                  <Field label="Method" htmlFor={`${id}-dep-method`}>
                    <Select id={`${id}-dep-method`} value={depositMethod} onChange={(e) => setDepositMethod(e.target.value as PaymentMethodValue)}>
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {METHOD_LABELS[m]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Reference" htmlFor={`${id}-dep-ref`} hint="Optional">
                    <DictationField multiline={false} onDictated={setDepositReference} disabled={busy}>
                      <Input id={`${id}-dep-ref`} value={depositReference} onChange={(e) => setDepositReference(e.target.value)} maxLength={120} />
                    </DictationField>
                  </Field>
                </div>
              ) : null}
            </fieldset>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !treatments.length}>
              {busy ? "Saving…" : "Record procedure"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
