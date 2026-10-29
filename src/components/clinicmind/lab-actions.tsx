"use client";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Ban, FileText, FlaskConical, ImagePlus, Pencil, Plus, Receipt, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { prepareFile, type PreparedFile } from "@/lib/client-files";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { METHOD_LABELS, PAYMENT_METHODS, type PaymentMethodValue } from "@/modules/finance/constants";
import { DEFAULT_TURNAROUND_DAYS, MAX_LAB_FILE_BYTES, MAX_LAB_FILES, MAX_LAB_PHOTO_SIDE } from "@/modules/lab/constants";
import type { LabFileDTO, LabOrderDTO } from "@/modules/lab/orders";
import { PatientPicker, type PatientOption } from "./appointment-patient-picker";
import { financeErrorMessage } from "./finance-shared";

export interface LabOptions {
  labs: { id: string; name: string; turnaroundDays: number }[];
  procedures: { id: string; label: string; performedAt: string; doctorId: string | null }[];
  doctors: { id: string; fullName: string }[];
}

const LIMITS = { maxSide: MAX_LAB_PHOTO_SIDE, maxBytes: MAX_LAB_FILE_BYTES };
const addDays = (key: string, days: number) => new Date(new Date(`${key}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const NEW_LAB = "__new";

/** Send work to a lab, for a patient chosen here (the clinic's labs given) or the one whose page this is (their options given). */
export function NewLabOrderButton({
  patient,
  options,
  labs,
  timezone,
  label = "New lab order",
  variant = "primary",
}: {
  patient?: PatientOption;
  options?: LabOptions;
  labs?: LabOptions["labs"];
  timezone: string;
  label?: string;
  variant?: "primary" | "outline";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>
      {open ? <LabOrderDialog patient={patient} options={options} labs={labs} timezone={timezone} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function LabOrderDialog({ patient: fixed, options: given, labs: clinicLabs, timezone, onClose }: { patient?: PatientOption; options?: LabOptions; labs?: LabOptions["labs"]; timezone: string; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const today = dateKeyInTz(new Date(), timezone);
  const [patient, setPatient] = useState<PatientOption | null>(fixed ?? null);
  const [options, setOptions] = useState<LabOptions | null>(given ?? null);
  const [labId, setLabId] = useState((given?.labs ?? clinicLabs ?? [])[0]?.id ?? NEW_LAB);
  const [labName, setLabName] = useState("");
  const [procedureId, setProcedureId] = useState("");
  const [tests, setTests] = useState("");
  const [site, setSite] = useState("");
  const [reference, setReference] = useState("");
  const [sentOn, setSentOn] = useState(today);
  const [dueOn, setDueOn] = useState("");
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A patient chosen here: their procedures (and the labs) come with them.
  useEffect(() => {
    if (fixed || !patient) return;
    let live = true;
    apiFetch<LabOptions>(`/api/lab-orders/options?patientId=${encodeURIComponent(patient.id)}`)
      .then((o) => {
        if (!live) return;
        setOptions(o);
        // The lab chosen stays (another lab included); one no longer offered falls back to the first.
        setLabId((current) => (current === NEW_LAB || o.labs.some((l) => l.id === current) ? current : (o.labs[0]?.id ?? NEW_LAB)));
        setProcedureId("");
      })
      .catch(() => live && setError("The patient's procedures could not be loaded."));
    return () => {
      live = false;
    };
  }, [fixed, patient]);

  const labs = options?.labs ?? clinicLabs ?? [];
  const lab = labs.find((l) => l.id === labId);
  const expected = addDays(sentOn || today, lab?.turnaroundDays ?? DEFAULT_TURNAROUND_DAYS);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (!patient) next.patientId = "Choose the patient.";
    if (labId === NEW_LAB && labName.trim().length < 2) next.labName = "The lab's name.";
    if (tests.trim().length < 2) next.tests = "Say what the lab is asked for.";
    if (!sentOn || sentOn > today) next.sentOn = "Today or a day before.";
    if (dueOn && dueOn < sentOn) next.dueOn = "Not before the day it went.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/lab-orders", {
        method: "POST",
        body: {
          patientId: patient!.id,
          ...(labId === NEW_LAB ? { labName: labName.trim() } : { labId }),
          procedureId: procedureId || undefined,
          tests: tests.trim(),
          site: site.trim() || undefined,
          reference: reference.trim() || undefined,
          sentOn,
          dueOn: dueOn || undefined,
          note: note.trim() || undefined,
        },
      });
      toast({ tone: "success", title: "Lab order sent", description: `Due back ${dueOn || expected}.` });
      onClose();
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: ReactNode) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New lab order" description={fixed ? `For ${fixed.fullName}. Due back by the lab's usual days, unless you give another.` : "Due back by the lab's usual days, unless you give another."}>
        <form onSubmit={submit} className="space-y-3" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {!fixed ? <PatientPicker value={patient} onChange={setPatient} error={issues.patientId} /> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Lab" htmlFor={`${id}-lab`}>
              <Select id={`${id}-lab`} value={labId} onChange={(e) => setLabId(e.target.value)}>
                {labs.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
                <option value={NEW_LAB}>Another lab…</option>
              </Select>
            </Field>
            {labId === NEW_LAB ? (
              <Field label="Its name" htmlFor={`${id}-lab-name`} hint={hint("labName")}>
                <Input id={`${id}-lab-name`} value={labName} onChange={(e) => setLabName(e.target.value)} maxLength={120} />
              </Field>
            ) : (
              <Field label="From the procedure (optional)" htmlFor={`${id}-procedure`} hint={hint("procedureId")}>
                <Select id={`${id}-procedure`} value={procedureId} onChange={(e) => setProcedureId(e.target.value)} disabled={!options}>
                  <option value="">None</option>
                  {(options?.procedures ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}, {new Date(p.performedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone })}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          {labId === NEW_LAB ? (
            <Field label="From the procedure (optional)" htmlFor={`${id}-procedure-2`} hint={hint("procedureId")}>
              <Select id={`${id}-procedure-2`} value={procedureId} onChange={(e) => setProcedureId(e.target.value)} disabled={!options}>
                <option value="">None</option>
                {(options?.procedures ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}, {new Date(p.performedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone })}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="What is asked" htmlFor={`${id}-tests`} hint={hint("tests", "e.g. Histopathology of a punch biopsy; Lipid profile, ALT, AST")}>
            <Input id={`${id}-tests`} value={tests} onChange={(e) => setTests(e.target.value)} maxLength={300} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Where on the body (optional)" htmlFor={`${id}-site`}>
              <Input id={`${id}-site`} value={site} onChange={(e) => setSite(e.target.value)} maxLength={120} placeholder="e.g. Left cheek" />
            </Field>
            <Field label="The lab's no. (optional)" htmlFor={`${id}-reference`}>
              <Input id={`${id}-reference`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sent" htmlFor={`${id}-sent`} hint={hint("sentOn")}>
              <Input id={`${id}-sent`} type="date" max={today} value={sentOn} onChange={(e) => setSentOn(e.target.value)} />
            </Field>
            <Field label="Due back" htmlFor={`${id}-due`} hint={hint("dueOn", dueOn ? undefined : `${expected}, the lab's usual`)}>
              <Input id={`${id}-due`} type="date" min={sentOn} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </Field>
          </div>
          <Field label="Note (optional)" htmlFor={`${id}-note`}>
            <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-[3.5rem]" />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send it"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Correct an order still at the lab: what was asked, where from, the day it is due back (the lab said Thursday). */
export function EditLabOrderButton({ order, procedures, timezone }: { order: LabOrderDTO; procedures: LabOptions["procedures"]; timezone: string }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [tests, setTests] = useState(order.tests);
  const [site, setSite] = useState(order.site ?? "");
  const [reference, setReference] = useState(order.reference ?? "");
  const [procedureId, setProcedureId] = useState(order.procedure?.id ?? "");
  const [dueOn, setDueOn] = useState(order.dueOn);
  const [note, setNote] = useState(order.note ?? "");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (tests.trim().length < 2) next.tests = "Say what the lab is asked for.";
    if (!dueOn || dueOn < order.sentOn) next.dueOn = "Not before the day it went.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/lab-orders/${order.id}`, { method: "PATCH", body: { tests: tests.trim(), site: site.trim() || undefined, reference: reference.trim() || undefined, procedureId: procedureId || undefined, dueOn, note: note.trim() || undefined } });
      toast({ tone: "success", title: "Lab order saved" });
      setOpen(false);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const hint = (key: string, fallback?: ReactNode) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
        Edit
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Edit the lab order" description={`${order.patient.fullName} · ${order.lab.name}. A new day due back starts the late alert again.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="What is asked" htmlFor={`${id}-tests`} hint={hint("tests")}>
              <Input id={`${id}-tests`} value={tests} onChange={(e) => setTests(e.target.value)} maxLength={300} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Where on the body" htmlFor={`${id}-site`}>
                <Input id={`${id}-site`} value={site} onChange={(e) => setSite(e.target.value)} maxLength={120} />
              </Field>
              <Field label="Due back" htmlFor={`${id}-due`} hint={hint("dueOn")}>
                <Input id={`${id}-due`} type="date" min={order.sentOn} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From the procedure" htmlFor={`${id}-procedure`}>
                <Select id={`${id}-procedure`} value={procedureId} onChange={(e) => setProcedureId(e.target.value)}>
                  <option value="">None</option>
                  {procedures.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}, {new Date(p.performedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone })}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="The lab's no." htmlFor={`${id}-reference`}>
                <Input id={`${id}-reference`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
              </Field>
            </div>
            <Field label="Note" htmlFor={`${id}-note`}>
              <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-[3.5rem]" />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Record the result as the lab's report has it, with a photo or a PDF of the report (clinicians). Recorded again, it is corrected. */
export function RecordResultButton({ order, timezone, size = "sm", variant = "outline" }: { order: LabOrderDTO; timezone: string; size?: "sm" | "md"; variant?: "primary" | "outline" }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const today = dateKeyInTz(new Date(), timezone);
  const amending = order.status === "RECEIVED";
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(order.result ?? "");
  const [abnormal, setAbnormal] = useState(order.abnormal ?? false);
  const [receivedOn, setReceivedOn] = useState(today);
  const [files, setFiles] = useState<PreparedFile[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const room = MAX_LAB_FILES - order.files.length - files.length;

  async function add(list: FileList | null) {
    if (!list?.length) return;
    setProblem(null);
    setPreparing(true);
    try {
      const next: PreparedFile[] = [];
      for (const file of Array.from(list).slice(0, Math.max(0, room))) {
        const prepared = await prepareFile(file, LIMITS);
        if (prepared === "too_large") setProblem(`${file.name} is larger than 5 MB.`);
        else if (prepared === "unreadable") setProblem(`${file.name} is not a photo or a PDF.`);
        else next.push(prepared);
      }
      setFiles((f) => [...f, ...next]);
    } finally {
      setPreparing(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (result.trim().length < 2) next.result = "What the lab's report says.";
    if (!amending && (!receivedOn || receivedOn > today || receivedOn < order.sentOn)) next.receivedOn = "From the day it went to today.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      // The result with the first file; any more files one at a time (each request carries one).
      const [firstFile, ...rest] = files;
      await apiFetch(`/api/lab-orders/${order.id}/result`, {
        method: "POST",
        body: { result: result.trim(), abnormal, receivedOn: amending ? undefined : receivedOn, files: firstFile ? [{ name: firstFile.name, type: firstFile.type, data: firstFile.data }] : undefined },
      });
      const failed: string[] = [];
      for (const f of rest) {
        await apiFetch(`/api/lab-orders/${order.id}/files`, { method: "POST", body: { files: [{ name: f.name, type: f.type, data: f.data }] } }).catch(() => failed.push(f.name));
      }
      files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
      toast({ tone: failed.length ? "info" : "success", title: amending ? "Result corrected" : "Result recorded", description: failed.length ? `${failed.join(", ")} did not upload: add it again.` : abnormal && !amending ? "The doctor who asked is told to act on it." : undefined });
      setOpen(false);
      setFiles([]);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: ReactNode) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <>
      <Button type="button" size={size} variant={variant} onClick={() => setOpen(true)} aria-label={`${amending ? "Correct the result of" : "Record the result of"} ${order.tests} for ${order.patient.fullName}`}>
        <FlaskConical className="h-4 w-4" aria-hidden="true" />
        {amending ? "Correct the result" : "Result in"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={amending ? "Correct the result" : "The result is in"} description={`${order.patient.fullName} · ${order.tests} · ${order.lab.name}`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="The result" htmlFor={`${id}-result`} hint={hint("result", "As the lab's report has it")}>
              <Textarea id={`${id}-result`} value={result} onChange={(e) => setResult(e.target.value)} maxLength={4000} className="min-h-[6rem]" />
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={abnormal} onChange={(e) => setAbnormal(e.target.checked)} className="mt-0.5" />
              <span>
                A doctor must act on it
                <span className="block text-xs text-muted-foreground">Flagged on the lists; the doctor who asked is told so.</span>
              </span>
            </label>
            {!amending ? (
              <Field label="Came back on" htmlFor={`${id}-received`} hint={hint("receivedOn")}>
                <Input id={`${id}-received`} type="date" min={order.sentOn} max={today} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} className="w-44" />
              </Field>
            ) : null}
            {room > 0 ? (
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-accent hover:underline">
                <ImagePlus className="h-4 w-4" aria-hidden="true" />
                {preparing ? "Preparing…" : "Add the lab's report (photo or PDF)"}
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    void add(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
            ) : null}
            {problem ? <p className="text-xs text-danger">{problem}</p> : null}
            {files.length ? (
              <ul className="flex flex-wrap gap-2" aria-label="Files to attach">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
                    {f.previewUrl ? <img src={f.previewUrl} alt={f.name} className="h-full w-full object-cover" /> : <FileText className="h-6 w-6 text-muted-foreground" aria-label={f.name} />}
                    <button type="button" className="absolute right-0.5 top-0.5 rounded bg-card/90 p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${f.name}`} onClick={() => setFiles((all) => all.filter((_, k) => k !== i))}>
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy || preparing}>
                {busy ? "Saving…" : amending ? "Save the correction" : "Record the result"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The lab's bill for an order: an expense under Lab fees, and a cost on its procedure. */
export function BillLabOrderButton({ order, timezone, drawerOpen }: { order: LabOrderDTO; timezone: string; drawerOpen: boolean }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const today = dateKeyInTz(new Date(), timezone);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [billedOn, setBilledOn] = useState(today);
  const [dueOn, setDueOn] = useState("");
  const [paidNow, setPaidNow] = useState(false);
  const [method, setMethod] = useState<PaymentMethodValue>("BANK_TRANSFER");
  const [fromDrawer, setFromDrawer] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drawerPossible = drawerOpen && method === "CASH" && billedOn === today;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = Number(amount.replace(/[,\s]/g, ""));
    const next: Record<string, string> = {};
    if (!Number.isInteger(value) || value <= 0) next.amount = "Whole EGP, more than zero.";
    if (!billedOn || billedOn > today) next.billedOn = "Today or a day before.";
    if (!paidNow && dueOn && dueOn < billedOn) next.dueOn = "Not before the day of the bill.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/lab-orders/${order.id}/bill`, {
        method: "POST",
        body: { amount: value, reference: reference.trim() || undefined, billedOn, dueOn: !paidNow && dueOn ? dueOn : undefined, paid: paidNow ? { method, fromDrawer: drawerPossible && fromDrawer } : undefined },
      });
      toast({ tone: "success", title: "The lab's bill is in", description: order.procedure ? `${formatNumber(value)} EGP comes off the doctor's share of ${order.procedure.label}.` : `${formatNumber(value)} EGP under Lab fees.` });
      setOpen(false);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const hint = (key: string, fallback?: ReactNode) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} aria-label={`Add the lab's bill for ${order.tests}, ${order.patient.fullName}`}>
        <Receipt className="h-4 w-4" aria-hidden="true" />
        Add the bill
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="The lab's bill"
          description={`${order.lab.name}: ${order.tests} for ${order.patient.fullName}. An expense under Lab fees${order.procedure ? ", and a cost on the procedure, off the doctor's share" : ""}.`}
        >
          <form onSubmit={submit} className="space-y-3" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={hint("amount")}>
                <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label="The lab's bill no. (optional)" htmlFor={`${id}-reference`}>
                <Input id={`${id}-reference`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Day of the bill" htmlFor={`${id}-billed`} hint={hint("billedOn")}>
                <Input id={`${id}-billed`} type="date" max={today} value={billedOn} onChange={(e) => setBilledOn(e.target.value)} />
              </Field>
              {!paidNow ? (
                <Field label="Pay by (optional)" htmlFor={`${id}-due`} hint={hint("dueOn")}>
                  <Input id={`${id}-due`} type="date" min={billedOn} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
                </Field>
              ) : (
                <Field label="Paid by" htmlFor={`${id}-method`}>
                  <Select id={`${id}-method`} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodValue)}>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {METHOD_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={paidNow} onChange={(e) => setPaidNow(e.target.checked)} className="mt-0.5" />
              <span>Paid now</span>
            </label>
            {paidNow && method === "CASH" ? (
              <label className={cn("flex items-start gap-2 text-sm", drawerPossible ? "" : "text-muted-foreground")}>
                <Checkbox checked={drawerPossible && fromDrawer} disabled={!drawerPossible} onChange={(e) => setFromDrawer(e.target.checked)} className="mt-0.5" />
                <span>
                  Out of the cash drawer
                  <span className="block text-xs text-muted-foreground">{drawerPossible ? "Your drawer will expect this much less at the close." : "Open your shift (Cash drawer) to pay cash out of it today."}</span>
                </span>
              </label>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Add the bill"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Cancel an order still at the lab, with the reason. */
export function CancelLabOrderButton({ order }: { order: LabOrderDTO }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (reason.trim().length < 3) {
      setError("Say why, in a few words.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/api/lab-orders/${order.id}/cancel`, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: "Lab order cancelled" });
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setOpen(true)}>
        <Ban className="h-4 w-4" aria-hidden="true" />
        Cancel the order
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Cancel this lab order?" description={`${order.tests} for ${order.patient.fullName}. It stays on record, cancelled.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            <Field label="Why" htmlFor={`${id}-reason`}>
              <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[4rem]" />
            </Field>
            {error ? <Alert>{error}</Alert> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Keep it
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? "Cancelling…" : "Cancel the order"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The pages of a lab's report: photos as thumbnails, PDFs by name. */
export function LabFileList({ files }: { files: LabFileDTO[] }) {
  if (!files.length) return <p className="text-sm text-muted-foreground">No report attached.</p>;
  return (
    <ul className="flex flex-wrap gap-3" data-testid="lab-files">
      {files.map((f) => (
        <li key={f.id}>
          <a href={f.url} target="_blank" rel="noopener" className="flex h-24 w-24 flex-col items-center justify-center overflow-hidden rounded-lg border border-border bg-muted text-xs text-muted-foreground hover:border-accent" title={f.name ?? undefined}>
            {f.mimeType.startsWith("image/") && f.mimeType !== "image/heic" && f.mimeType !== "image/heif" ? (
              <img src={f.url} alt={f.name ?? "Lab report"} className="h-full w-full object-cover" loading="lazy" />
            ) : (
              <>
                <FileText className="mb-1 h-6 w-6" aria-hidden="true" />
                <span className="line-clamp-2 px-1 text-center">{f.name ?? "Report"}</span>
              </>
            )}
          </a>
        </li>
      ))}
    </ul>
  );
}
