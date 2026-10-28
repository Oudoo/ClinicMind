"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { PatientPicker, type PatientOption } from "@/components/clinicmind/appointment-patient-picker";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz, formatDateInTz, formatTimeInTz, fromLocalInput } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { KIND_LABELS, METHOD_LABELS, PAYMENT_KINDS, PAYMENT_METHODS, type PaymentKindValue, type PaymentMethodValue } from "@/modules/finance/constants";
import { financeErrorMessage, type ProcedureChoice } from "./finance-shared";

interface ProcedureListResponse {
  procedures: { id: string; status: string; performedAt: string; balance: number; treatment: { name: string } }[];
}

/**
 * Record a payment: kind (payment, deposit, refund, consultation fee),
 * method, amount, date and time on the clinic clock, the procedure it goes
 * towards (optional), a reference and a dictated note. From the patient card
 * the patient is fixed; from the finance dashboard it is searched.
 */
export function RecordPaymentDialog({
  timezone,
  patient: presetPatient = null,
  procedures: presetProcedures,
  defaults = {},
  canRefund = false,
  onOpenChange,
  onDone,
}: {
  timezone: string;
  /** Money going back out is the owner's to give: refunds are offered to them only. */
  canRefund?: boolean;
  patient?: PatientOption | null;
  /** The patient's procedures, when the caller already has them; otherwise fetched once a patient is chosen. */
  procedures?: ProcedureChoice[];
  defaults?: { kind?: PaymentKindValue; amount?: number; procedureId?: string };
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const id = useId();
  const now = new Date();
  const [patient, setPatient] = useState<PatientOption | null>(presetPatient);
  const [kind, setKind] = useState<PaymentKindValue>(defaults.kind ?? "PAYMENT");
  const [method, setMethod] = useState<PaymentMethodValue>("CASH");
  const [amount, setAmount] = useState(defaults.amount ? String(defaults.amount) : "");
  const [date, setDate] = useState(dateKeyInTz(now, timezone));
  const [time, setTime] = useState(formatTimeInTz(now, timezone));
  const [procedureId, setProcedureId] = useState(defaults.procedureId ?? "");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [choices, setChoices] = useState<ProcedureChoice[] | null>(presetProcedures ?? null);
  // The patient's invoices still to be paid: a payment can be matched to one by hand.
  const [openInvoices, setOpenInvoices] = useState<{ id: string; number: string | null; due: number; patientId: string; patientName: string }[]>([]);
  const [invoiceId, setInvoiceId] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // From the finance dashboard: load the chosen patient's open procedures.
  useEffect(() => {
    if (presetProcedures || !patient) return;
    let cancelled = false;
    apiFetch<ProcedureListResponse>(`/api/procedures?patientId=${encodeURIComponent(patient.id)}&pageSize=50`)
      .then((res) => {
        if (cancelled) return;
        setChoices(
          res.procedures
            .filter((p) => p.status !== "CANCELLED")
            .map((p) => ({
              id: p.id,
              balance: p.balance,
              label: `${p.treatment.name} · ${formatDateInTz(new Date(p.performedAt), timezone)}${p.status === "PLANNED" ? " · planned" : p.balance > 0 ? ` · owes ${formatNumber(p.balance)} EGP` : " · paid"}`,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setChoices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [patient, presetProcedures, timezone]);

  useEffect(() => {
    if (!patient) return;
    let cancelled = false;
    // The head of a family can pay the members' invoices too.
    apiFetch<{ invoices: { id: string; number: string | null; total: number; paid: number; patientId: string; patientName: string }[] }>(
      `/api/invoices?patientId=${encodeURIComponent(patient.id)}&payable=1&status=OPEN&pageSize=50`,
    )
      .then((res) => {
        if (!cancelled) setOpenInvoices(res.invoices.map((i) => ({ id: i.id, number: i.number, due: i.total - i.paid, patientId: i.patientId, patientName: i.patientName })).filter((i) => i.due > 0));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [patient]);

  const chosen = choices?.find((c) => c.id === procedureId) ?? null;
  const chosenInvoice = openInvoices.find((i) => i.id === invoiceId) ?? null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (!patient) next.patientId = "Choose a patient.";
    const value = Number(amount.replace(/[,\s]/g, ""));
    if (!Number.isInteger(value) || value <= 0) next.amount = "Whole EGP, more than zero.";
    const paidAt = fromLocalInput(`${date}T${time}`, timezone);
    if (!paidAt) next.paidAt = "Enter a valid date and time.";
    else if (paidAt.getTime() > Date.now() + 5 * 60_000) next.paidAt = "A payment cannot be in the future.";
    if (kind === "REFUND" && !note.trim()) next.note = "Say why the money goes back.";
    setIssues(next);
    if (Object.keys(next).length || !patient || !paidAt) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/payments", {
        method: "POST",
        body: {
          patientId: patient.id,
          kind,
          method,
          amount: value,
          paidAt: paidAt.toISOString(),
          procedureId: procedureId || undefined,
          invoiceId: kind === "PAYMENT" && invoiceId ? invoiceId : undefined,
          reference: reference.trim() || undefined,
          note: note.trim() || undefined,
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
      <DialogContent title="Record a payment" description={`Whole EGP · times on the clinic clock (${timezone}).`} className="max-w-xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {presetPatient ? (
            <p className="text-sm">
              <span className="data-label mr-2">Patient</span>
              <span className="font-medium">{presetPatient.fullName}</span>
            </p>
          ) : (
            <PatientPicker
              value={patient}
              onChange={(p) => {
                setPatient(p);
                setProcedureId("");
                setChoices(null);
                setInvoiceId("");
                setOpenInvoices([]);
              }}
              error={issues.patientId}
            />
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Kind" htmlFor={`${id}-kind`} hint={issue("kind")}>
              <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as PaymentKindValue)}>
                {PAYMENT_KINDS.filter((k) => k !== "REFUND" || canRefund).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Method" htmlFor={`${id}-method`} hint={issue("method")}>
              <Select id={`${id}-method`} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodValue)}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={issue("amount")}>
              <Input
                id={`${id}-amount`}
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={issues.amount ? true : undefined}
                placeholder="e.g. 2500"
                required
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" htmlFor={`${id}-date`} hint={issue("paidAt")}>
              <Input id={`${id}-date`} type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={issues.paidAt ? true : undefined} />
            </Field>
            <Field label="Time" htmlFor={`${id}-time`}>
              <Input id={`${id}-time`} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </div>

          {patient && kind === "PAYMENT" && openInvoices.length ? (
            <Field label="Towards an invoice" htmlFor={`${id}-invoice`} hint={issue("invoiceId") ?? (chosenInvoice ? `To pay on it: ${formatNumber(chosenInvoice.due)} EGP` : "Otherwise the oldest open invoice is paid first")}>
              <div className="flex gap-2">
                <Select id={`${id}-invoice`} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
                  <option value="">Oldest open invoice first</option>
                  {openInvoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.number} · {formatNumber(i.due)} EGP to pay{i.patientId !== patient.id ? ` · ${i.patientName}` : ""}
                    </option>
                  ))}
                </Select>
                {chosenInvoice ? (
                  <Button type="button" variant="outline" size="sm" className="h-10 shrink-0" onClick={() => setAmount(String(chosenInvoice.due))}>
                    What is due
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : null}
          {patient ? (
            <Field
              label="Towards a procedure"
              htmlFor={`${id}-procedure`}
              hint={issue("procedureId") ?? (chosen && chosen.balance > 0 ? `Balance on it: ${formatNumber(chosen.balance)} EGP` : "Optional")}
            >
              <div className="flex gap-2">
                <Select id={`${id}-procedure`} value={procedureId} onChange={(e) => setProcedureId(e.target.value)} disabled={choices === null}>
                  <option value="">{choices === null ? "Loading…" : "None"}</option>
                  {(choices ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
                {chosen && chosen.balance > 0 && kind !== "REFUND" ? (
                  <Button type="button" variant="outline" size="sm" className="h-10 shrink-0" onClick={() => setAmount(String(chosen.balance))}>
                    Full balance
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : null}

          <Field label="Reference" htmlFor={`${id}-reference`} hint={issue("reference") ?? "Optional · receipt, POS or transfer number"}>
            <DictationField multiline={false} onDictated={setReference} disabled={busy}>
              <Input id={`${id}-reference`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
            </DictationField>
          </Field>
          <Field label={kind === "REFUND" ? "Reason" : "Note"} htmlFor={`${id}-note`} hint={issue("note") ?? (kind === "REFUND" ? "Required: why the money goes back" : "Optional")}>
            <DictationField onDictated={setNote} disabled={busy} patientId={patient?.id ?? null}>
              <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="min-h-[4.5rem]" />
            </DictationField>
          </Field>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Close
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Record payment"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
