"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Ban, Banknote, FileText, ImagePlus, Paperclip, Pencil, Plus, Trash2, X } from "lucide-react";
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
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  isOwnerOnlyCategory,
  MAX_EXPENSE_FILE_BYTES,
  MAX_EXPENSE_FILES,
  MAX_EXPENSE_PHOTO_SIDE,
  type ExpenseCategoryValue,
} from "@/modules/finance/expense-constants";
import type { ExpenseDTO, ExpenseFileDTO } from "@/modules/finance/expenses";
import { financeErrorMessage } from "./finance-shared";

export interface SupplierOption {
  id: string;
  name: string;
  category: ExpenseCategoryValue;
}

/** What the expense dialogs need from the page. */
export interface ExpenseFormContext {
  suppliers: SupplierOption[];
  clinics: { id: string; name: string }[];
  timezone: string;
  /** Salaries are the owner's to record. */
  canSalaries: boolean;
  /** The user has today's shift open: cash can come out of the drawer. */
  drawerOpen: boolean;
}

const LIMITS = { maxSide: MAX_EXPENSE_PHOTO_SIDE, maxBytes: MAX_EXPENSE_FILE_BYTES };
const money = (s: string) => Number(s.replace(/[,\s]/g, ""));

/** The supplier typed: one of the list (by its name), a new one, or none. */
function supplierChoice(text: string, suppliers: SupplierOption[]): { supplierId?: string; supplierName?: string; known: SupplierOption | null } {
  const name = text.trim().replace(/\s+/g, " ");
  if (!name) return { known: null };
  const known = suppliers.find((s) => s.name.toLowerCase() === name.toLowerCase()) ?? null;
  return known ? { supplierId: known.id, known } : { supplierName: name, known: null };
}

/** Send prepared files to an expense, one at a time; the names of those that did not go. */
async function uploadAll(expenseId: string, files: PreparedFile[]): Promise<string[]> {
  const failed: string[] = [];
  for (const f of files) {
    try {
      await apiFetch(`/api/expenses/${expenseId}/files`, { method: "POST", body: { files: [{ name: f.name, type: f.type, data: f.data }] } });
    } catch {
      failed.push(f.name);
    }
  }
  return failed;
}

/** Photos and PDFs chosen in a form, shrunk and ready to go, with their previews. */
function useChosenFiles() {
  const [files, setFiles] = useState<PreparedFile[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  async function add(list: FileList | null, room: number) {
    if (!list?.length) return;
    setProblem(null);
    setPreparing(true);
    try {
      const next: PreparedFile[] = [];
      for (const file of Array.from(list).slice(0, Math.max(0, room))) {
        const prepared = await prepareFile(file, LIMITS);
        if (prepared === "too_large") setProblem(`${file.name} is larger than 5 MB.`);
        else if (prepared === "unreadable") setProblem(`${file.name} is not a photo or a PDF.`);
        else {
          if (prepared.previewUrl) urls.current.push(prepared.previewUrl);
          next.push(prepared);
        }
      }
      if (list.length > room) setProblem(`At most ${MAX_EXPENSE_FILES} files on one expense.`);
      setFiles((f) => [...f, ...next]);
    } finally {
      setPreparing(false);
    }
  }
  const remove = (i: number) => setFiles((f) => f.filter((_, k) => k !== i));
  return { files, add, remove, problem, preparing, reset: () => setFiles([]) };
}

function ChosenFiles({ files, onRemove }: { files: PreparedFile[]; onRemove: (i: number) => void }) {
  if (!files.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Files to attach">
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`} className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
          {f.previewUrl ? (
            <img src={f.previewUrl} alt={f.name} className="h-full w-full object-cover" />
          ) : (
            <FileText className="h-6 w-6 text-muted-foreground" aria-label={f.name} />
          )}
          <button type="button" className="absolute right-0.5 top-0.5 rounded bg-card/90 p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)}>
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A new expense: money spent now (paid in full) or a bill to pay by a day; with its supplier and its receipt. */
export function NewExpenseButton({ context, supplier, label = "New expense", variant = "primary" }: { context: ExpenseFormContext; supplier?: SupplierOption; label?: string; variant?: "primary" | "outline" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>
      {open ? <ExpenseDialog context={context} supplier={supplier} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Correct an expense's details. */
export function EditExpenseButton({ context, expense }: { context: ExpenseFormContext; expense: ExpenseDTO }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
        Edit
      </Button>
      {open ? <ExpenseDialog context={context} expense={expense} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ExpenseDialog({ context, expense, supplier, onClose }: { context: ExpenseFormContext; expense?: ExpenseDTO; supplier?: SupplierOption; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const today = dateKeyInTz(new Date(), context.timezone);
  const editing = !!expense;
  const [mode, setMode] = useState<"paid" | "bill">(expense ? "bill" : supplier ? "bill" : "paid");
  const [supplierText, setSupplierText] = useState(expense?.supplier?.name ?? supplier?.name ?? "");
  const [category, setCategory] = useState<ExpenseCategoryValue>(expense?.category ?? supplier?.category ?? "OTHER");
  const [categoryTouched, setCategoryTouched] = useState(!!expense || !!supplier);
  const [description, setDescription] = useState(expense?.description ?? "");
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [billedOn, setBilledOn] = useState(expense?.billedOn ?? today);
  const [dueOn, setDueOn] = useState(expense?.dueOn ?? "");
  const [reference, setReference] = useState(expense?.reference ?? "");
  const [note, setNote] = useState(expense?.note ?? "");
  const [clinicId, setClinicId] = useState(context.clinics[0]?.id ?? "");
  const [method, setMethod] = useState<PaymentMethodValue>("CASH");
  const [fromDrawer, setFromDrawer] = useState(context.drawerOpen);
  const chosen = useChosenFiles();
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choice = supplierChoice(supplierText, context.suppliers);
  const drawerPossible = context.drawerOpen && method === "CASH" && billedOn === today;
  const categories = EXPENSE_CATEGORIES.filter((c) => context.canSalaries || !isOwnerOnlyCategory(c) || c === expense?.category);

  function onSupplier(text: string) {
    setSupplierText(text);
    const known = supplierChoice(text, context.suppliers).known;
    if (known && !categoryTouched && (context.canSalaries || !isOwnerOnlyCategory(known.category))) setCategory(known.category);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = money(amount);
    const next: Record<string, string> = {};
    if (description.trim().length < 2) next.description = "Say what it is for.";
    if (!Number.isInteger(value) || value <= 0) next.amount = "Whole EGP, more than zero.";
    if (!billedOn || billedOn > today) next.billedOn = "Today or a day before.";
    if (mode === "bill" && dueOn && dueOn < billedOn) next.dueOn = "Not before the day of the bill.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    const common = {
      supplierId: choice.supplierId,
      supplierName: choice.supplierName,
      category,
      description: description.trim(),
      amount: value,
      billedOn,
      dueOn: mode === "bill" && dueOn ? dueOn : undefined,
      reference: reference.trim() || undefined,
      note: note.trim() || undefined,
    };
    try {
      if (expense) {
        await apiFetch(`/api/expenses/${expense.id}`, { method: "PATCH", body: common });
        toast({ tone: "success", title: "Expense saved" });
      } else {
        const res = await apiFetch<{ expense: ExpenseDTO }>("/api/expenses", {
          method: "POST",
          body: { ...common, clinicId: context.clinics.length > 1 ? clinicId : undefined, paid: mode === "paid" ? { method, fromDrawer: drawerPossible && fromDrawer } : undefined },
        });
        const failed = await uploadAll(res.expense.id, chosen.files);
        if (failed.length) toast({ tone: "info", title: "Expense saved, a file did not go", description: `${failed.join(", ")}: add it again from the expense.` });
        else toast({ tone: "success", title: mode === "paid" ? "Expense recorded" : "Bill added", description: mode === "paid" && drawerPossible && fromDrawer ? `${formatNumber(value)} EGP out of the cash drawer.` : undefined });
      }
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
  const supplierHint = choice.supplierName ? `A new supplier: ${choice.supplierName} is added to the list.` : "Leave it empty for money spent with no supplier.";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={editing ? "Edit the expense" : "New expense"} description={editing ? "What it is, its amount (never below what is paid) and its days." : "Money spent now, or a bill to pay by a day."}>
        <form onSubmit={submit} className="space-y-3" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {!editing ? (
            <fieldset className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" aria-label="Paid now or later">
              {(["paid", "bill"] as const).map((m) => (
                <label key={m} className={cn("flex cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-sm font-medium", mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}>
                  <input type="radio" name={`${id}-mode`} value={m} checked={mode === m} onChange={() => setMode(m)} className="sr-only" />
                  {m === "paid" ? "Paid now" : "A bill to pay"}
                </label>
              ))}
            </fieldset>
          ) : null}
          <Field label="Supplier" htmlFor={`${id}-supplier`} hint={hint("supplierName", supplierHint)}>
            <Input id={`${id}-supplier`} list={`${id}-suppliers`} value={supplierText} onChange={(e) => onSupplier(e.target.value)} maxLength={120} autoComplete="off" placeholder="Choose or type a name" />
            <datalist id={`${id}-suppliers`}>
              {context.suppliers.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" htmlFor={`${id}-category`} hint={hint("category")}>
              <Select
                id={`${id}-category`}
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value as ExpenseCategoryValue);
                  setCategoryTouched(true);
                }}
              >
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {EXPENSE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={hint("amount", expense && expense.paid ? `${formatNumber(expense.paid)} EGP paid so far` : undefined)}>
              <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <Field label="What for" htmlFor={`${id}-description`} hint={hint("description", "e.g. Gloves and gauze, the internet for October")}>
            <Input id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={mode === "paid" && !editing ? "Day" : "Day of the bill"} htmlFor={`${id}-billed`} hint={hint("billedOn")}>
              <Input id={`${id}-billed`} type="date" max={today} value={billedOn} onChange={(e) => setBilledOn(e.target.value)} />
            </Field>
            {mode === "bill" ? (
              <Field label="Pay by (optional)" htmlFor={`${id}-due`} hint={hint("dueOn")}>
                <Input id={`${id}-due`} type="date" min={billedOn} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
              </Field>
            ) : !editing ? (
              <Field label="Paid by" htmlFor={`${id}-method`}>
                <Select id={`${id}-method`} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodValue)}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          {mode === "paid" && !editing && method === "CASH" ? (
            <label className={cn("flex items-start gap-2 text-sm", drawerPossible ? "" : "text-muted-foreground")}>
              <Checkbox checked={drawerPossible && fromDrawer} disabled={!drawerPossible} onChange={(e) => setFromDrawer(e.target.checked)} className="mt-0.5" />
              <span>
                Out of the cash drawer
                <span className="block text-xs text-muted-foreground">
                  {drawerPossible ? "Your drawer will expect this much less at the close." : context.drawerOpen ? "Only today's cash comes out of the drawer." : "Open your shift (Cash drawer) to pay cash out of it."}
                </span>
              </span>
            </label>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bill or receipt no. (optional)" htmlFor={`${id}-reference`}>
              <Input id={`${id}-reference`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
            </Field>
            {!editing && context.clinics.length > 1 ? (
              <Field label="Branch" htmlFor={`${id}-clinic`}>
                <Select id={`${id}-clinic`} value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
                  {context.clinics.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          <Field label="Note (optional)" htmlFor={`${id}-note`}>
            <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-[3.5rem]" />
          </Field>
          {!editing ? (
            <div className="space-y-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-accent hover:underline">
                <ImagePlus className="h-4 w-4" aria-hidden="true" />
                {chosen.preparing ? "Preparing…" : "Add the receipt (photo or PDF)"}
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    void chosen.add(e.target.files, MAX_EXPENSE_FILES - chosen.files.length);
                    e.target.value = "";
                  }}
                />
              </label>
              {chosen.problem ? <p className="text-xs text-danger">{chosen.problem}</p> : null}
              <ChosenFiles files={chosen.files} onRemove={chosen.remove} />
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || chosen.preparing}>
              {busy ? "Saving…" : editing ? "Save" : mode === "paid" ? "Record the expense" : "Add the bill"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pay towards an expense: what is owed, or part of it; cash today out of the drawer. */
export function PayExpenseButton({ expenseId, description, owed, billedOn, timezone, drawerOpen, size = "sm" }: { expenseId: string; description: string; owed: number; billedOn: string; timezone: string; drawerOpen: boolean; size?: "sm" | "md" }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const today = dateKeyInTz(new Date(), timezone);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(owed));
  const [method, setMethod] = useState<PaymentMethodValue>(drawerOpen ? "CASH" : "BANK_TRANSFER");
  const [day, setDay] = useState(today);
  const [fromDrawer, setFromDrawer] = useState(drawerOpen);
  const [reference, setReference] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const drawerPossible = drawerOpen && method === "CASH" && day === today;

  function show() {
    setAmount(String(owed));
    setIssues({});
    setError(null);
    setOpen(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = money(amount);
    const next: Record<string, string> = {};
    if (!Number.isInteger(value) || value <= 0) next.amount = "Whole EGP, more than zero.";
    else if (value > owed) next.amount = `At most what is owed (${formatNumber(owed)} EGP).`;
    if (!day || day > today || day < billedOn) next.paidOn = "From the day of the bill to today.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/expenses/${expenseId}/payments`, { method: "POST", body: { amount: value, method, paidOn: day, fromDrawer: drawerPossible && fromDrawer, reference: reference.trim() || undefined } });
      toast({ tone: "success", title: value === owed ? "Paid in full" : "Payment recorded", description: drawerPossible && fromDrawer ? `${formatNumber(value)} EGP out of the cash drawer.` : undefined });
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

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <>
      <Button type="button" size={size} variant="outline" onClick={show} aria-label={`Pay ${description}`}>
        <Banknote className="h-4 w-4" aria-hidden="true" />
        Pay
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Pay: ${description}`} description={`${formatNumber(owed)} EGP owed.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={hint("amount")}>
                <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </Field>
              <Field label="Day" htmlFor={`${id}-day`} hint={hint("paidOn")}>
                <Input id={`${id}-day`} type="date" min={billedOn} max={today} value={day} onChange={(e) => setDay(e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Paid by" htmlFor={`${id}-method`}>
                <Select id={`${id}-method`} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodValue)}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reference (optional)" htmlFor={`${id}-reference`}>
                <Input id={`${id}-reference`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
              </Field>
            </div>
            {method === "CASH" ? (
              <label className={cn("flex items-start gap-2 text-sm", drawerPossible ? "" : "text-muted-foreground")}>
                <Checkbox checked={drawerPossible && fromDrawer} disabled={!drawerPossible} onChange={(e) => setFromDrawer(e.target.checked)} className="mt-0.5" />
                <span>
                  Out of the cash drawer
                  <span className="block text-xs text-muted-foreground">
                    {drawerPossible ? "Your drawer will expect this much less at the close." : drawerOpen ? "Only today's cash comes out of the drawer." : "Open your shift (Cash drawer) to pay cash out of it."}
                  </span>
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
                {busy ? "Saving…" : "Record the payment"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A reason asked before something is voided. */
function VoidDialog({ title, description, action, url, done, onClose }: { title: string; description: string; action: string; url: string; done: string; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
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
      await apiFetch(url, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: done });
      onClose();
      router.refresh();
    } catch (err) {
      setError(financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} description={description}>
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
              {busy ? "Voiding…" : action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The owner voids an expense entered by mistake (its payments with it). */
export function VoidExpenseButton({ expense }: { expense: Pick<ExpenseDTO, "id" | "description" | "amount" | "paid"> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setOpen(true)}>
        <Ban className="h-4 w-4" aria-hidden="true" />
        Void
      </Button>
      {open ? (
        <VoidDialog
          title={`Void ${expense.description}?`}
          description={`${formatNumber(expense.amount)} EGP no longer counts${expense.paid ? `, and the ${formatNumber(expense.paid)} EGP paid towards it is voided with it` : ""}. It stays on record, voided.`}
          action="Void the expense"
          url={`/api/expenses/${expense.id}/void`}
          done="Expense voided"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The owner voids a payment entered by mistake: what it paid is owed again. */
export function VoidExpensePaymentButton({ paymentId, amount }: { paymentId: string; amount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Void the payment of ${formatNumber(amount)} EGP`} onClick={() => setOpen(true)}>
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open ? (
        <VoidDialog
          title={`Void the payment of ${formatNumber(amount)} EGP?`}
          description="What it paid is owed again. It stays on record, voided."
          action="Void the payment"
          url={`/api/expense-payments/${paymentId}/void`}
          done="Payment voided"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Add photos or PDFs of the bill or the receipt to an expense. */
export function AddReceiptButton({ expenseId, room }: { expenseId: string; room: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  async function onFiles(list: FileList | null) {
    if (!list?.length || busy) return;
    setBusy(true);
    try {
      const ready: PreparedFile[] = [];
      const problems: string[] = [];
      for (const file of Array.from(list).slice(0, room)) {
        const prepared = await prepareFile(file, LIMITS);
        if (prepared === "too_large") problems.push(`${file.name} is larger than 5 MB`);
        else if (prepared === "unreadable") problems.push(`${file.name} is not a photo or a PDF`);
        else ready.push(prepared);
      }
      const failed = ready.length ? await uploadAll(expenseId, ready) : [];
      ready.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
      const sent = ready.length - failed.length;
      if (sent) toast({ tone: "success", title: sent === 1 ? "Receipt added" : `${sent} files added` });
      if (problems.length || failed.length) toast({ tone: "info", title: "Not added", description: [...problems, ...failed.map((n) => `${n} did not upload`)].join("; ") });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  if (room <= 0) return null;
  return (
    <label className={cn("inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-input px-3 text-sm font-medium hover:bg-muted", busy && "pointer-events-none opacity-60")}>
      <Paperclip className="h-4 w-4" aria-hidden="true" />
      {busy ? "Adding…" : "Add a photo or PDF"}
      <input
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="sr-only"
        onChange={(e) => {
          void onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </label>
  );
}

/** An expense's receipts: photos as thumbnails, PDFs by name; the owner removes one put by mistake. */
export function ReceiptList({ files, canRemove }: { files: ExpenseFileDTO[]; canRemove: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<ExpenseFileDTO | null>(null);
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (!removing || busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/expense-files/${removing.id}`, { method: "DELETE" });
      toast({ tone: "success", title: "File removed" });
      setRemoving(null);
      router.refresh();
    } catch (err) {
      toast({ tone: "danger", title: "Not removed", description: financeErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  if (!files.length) return <p className="text-sm text-muted-foreground">No receipt yet.</p>;
  return (
    <>
      <ul className="flex flex-wrap gap-3" data-testid="expense-files">
        {files.map((f) => (
          <li key={f.id} className="group relative">
            <a href={f.url} target="_blank" rel="noopener" className="flex h-24 w-24 flex-col items-center justify-center overflow-hidden rounded-lg border border-border bg-muted text-xs text-muted-foreground hover:border-accent" title={f.name ?? undefined}>
              {f.mimeType.startsWith("image/") && f.mimeType !== "image/heic" && f.mimeType !== "image/heif" ? (
                <img src={f.url} alt={f.name ?? "Receipt"} className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <>
                  <FileText className="mb-1 h-6 w-6" aria-hidden="true" />
                  <span className="line-clamp-2 px-1 text-center">{f.name ?? (f.mimeType === "application/pdf" ? "PDF" : "Photo")}</span>
                </>
              )}
            </a>
            {canRemove ? (
              <button type="button" className="absolute right-1 top-1 rounded bg-card/90 p-1 text-muted-foreground shadow-sm hover:text-danger" aria-label={`Remove ${f.name ?? "the file"}`} onClick={() => setRemoving(f)}>
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {removing ? (
        <Dialog open onOpenChange={(o) => !o && setRemoving(null)}>
          <DialogContent title="Remove this file?" description="For a file attached by mistake: it is deleted. The audit log keeps that it was.">
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Keep it
                </Button>
              </DialogClose>
              <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()}>
                {busy ? "Removing…" : "Remove the file"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
