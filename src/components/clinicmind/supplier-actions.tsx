"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Repeat, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { monthLabel, monthOfKey, shiftMonth } from "@/modules/finance/doctor-pay-calc";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, isOwnerOnlyCategory, RECURRING_EVERY, RECURRING_EVERY_LABELS, type ExpenseCategoryValue } from "@/modules/finance/expense-constants";
import type { RecurringDTO, SupplierDTO } from "@/modules/finance/expenses";
import type { SupplierOption } from "./expense-actions";
import { financeErrorMessage } from "./finance-shared";

const money = (s: string) => Number(s.replace(/[,\s]/g, ""));

/** Add a supplier: a lab, a supplier of materials, the landlord, a utility, an agency. */
export function NewSupplierButton({ canSalaries }: { canSalaries: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        New supplier
      </Button>
      {open ? <SupplierDialog canSalaries={canSalaries} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function EditSupplierButton({ supplier, canSalaries }: { supplier: SupplierDTO; canSalaries: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
        Edit
      </Button>
      {open ? <SupplierDialog supplier={supplier} canSalaries={canSalaries} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SupplierDialog({ supplier, canSalaries, onClose }: { supplier?: SupplierDTO; canSalaries: boolean; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(supplier?.name ?? "");
  const [category, setCategory] = useState<ExpenseCategoryValue>(supplier?.category ?? "SUPPLIES");
  const [contactName, setContactName] = useState(supplier?.contactName ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [email, setEmail] = useState(supplier?.email ?? "");
  const [notes, setNotes] = useState(supplier?.notes ?? "");
  const [archived, setArchived] = useState(supplier?.archived ?? false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = EXPENSE_CATEGORIES.filter((c) => canSalaries || !isOwnerOnlyCategory(c) || c === supplier?.category);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (name.trim().length < 2) {
      setIssues({ name: "The supplier's name." });
      return;
    }
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), category, contactName: contactName.trim(), phone: phone.trim(), email: email.trim(), notes: notes.trim(), ...(supplier ? { archived } : {}) };
    try {
      if (supplier) await apiFetch(`/api/suppliers/${supplier.id}`, { method: "PATCH", body });
      else await apiFetch("/api/suppliers", { method: "POST", body });
      toast({ tone: "success", title: supplier ? "Supplier saved" : "Supplier added" });
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
      <DialogContent title={supplier ? `Edit ${supplier.name}` : "New supplier"} description="Who the clinic buys from or pays. Its bills go under its category unless said otherwise.">
        <form onSubmit={submit} className="space-y-3" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="Name" htmlFor={`${id}-name`} hint={hint("name")}>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Its bills go under" htmlFor={`${id}-category`}>
            <Select id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategoryValue)}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {EXPENSE_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contact (optional)" htmlFor={`${id}-contact`}>
              <Input id={`${id}-contact`} value={contactName} onChange={(e) => setContactName(e.target.value)} maxLength={120} />
            </Field>
            <Field label="Phone (optional)" htmlFor={`${id}-phone`} hint={hint("phone")}>
              <Input id={`${id}-phone`} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
            </Field>
          </div>
          <Field label="E-mail (optional)" htmlFor={`${id}-email`} hint={hint("email")}>
            <Input id={`${id}-email`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={160} />
          </Field>
          <Field label="Notes (optional)" htmlFor={`${id}-notes`} hint="Payment terms, the account number for transfers">
            <Textarea id={`${id}-notes`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} className="min-h-[3.5rem]" />
          </Field>
          {supplier ? (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={archived} onChange={(e) => setArchived(e.target.checked)} className="mt-0.5" />
              <span>
                No longer used
                <span className="block text-xs text-muted-foreground">Kept with its bills, no longer offered for new ones.</span>
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
              {busy ? "Saving…" : supplier ? "Save" : "Add the supplier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The owner sets up an expense that comes back (the rent, the internet, a service contract). */
export function NewRecurringButton({ suppliers, clinics, timezone, canSalaries }: { suppliers: SupplierOption[]; clinics: { id: string; name: string }[]; timezone: string; canSalaries: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Repeat className="h-4 w-4" aria-hidden="true" />
        New recurring
      </Button>
      {open ? <RecurringDialog suppliers={suppliers} clinics={clinics} timezone={timezone} canSalaries={canSalaries} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function EditRecurringButton({ recurring, suppliers, timezone, canSalaries }: { recurring: RecurringDTO; suppliers: SupplierOption[]; timezone: string; canSalaries: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Edit ${recurring.description}`}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
        Edit
      </Button>
      {open ? <RecurringDialog recurring={recurring} suppliers={suppliers} clinics={[]} timezone={timezone} canSalaries={canSalaries} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RecurringDialog({
  recurring,
  suppliers,
  clinics,
  timezone,
  canSalaries,
  onClose,
}: {
  recurring?: RecurringDTO;
  suppliers: SupplierOption[];
  clinics: { id: string; name: string }[];
  timezone: string;
  canSalaries: boolean;
  onClose: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const thisMonth = monthOfKey(dateKeyInTz(new Date(), timezone));
  const [supplierText, setSupplierText] = useState(recurring?.supplier?.name ?? "");
  const [category, setCategory] = useState<ExpenseCategoryValue>(recurring?.category ?? "RENT");
  const [description, setDescription] = useState(recurring?.description ?? "");
  const [amount, setAmount] = useState(recurring ? String(recurring.amount) : "");
  const [everyMonths, setEveryMonths] = useState<number>(recurring?.everyMonths ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(String(recurring?.dayOfMonth ?? 1));
  const [dueDays, setDueDays] = useState(String(recurring?.dueDays ?? 5));
  const [startMonth, setStartMonth] = useState(recurring?.startMonth ?? thisMonth);
  const [clinicId, setClinicId] = useState(clinics[0]?.id ?? "");
  const [note, setNote] = useState(recurring?.note ?? "");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = EXPENSE_CATEGORIES.filter((c) => canSalaries || !isOwnerOnlyCategory(c));
  const months = Array.from({ length: 25 }, (_, i) => shiftMonth(thisMonth, i - 12));

  function onSupplier(text: string) {
    setSupplierText(text);
    const known = suppliers.find((s) => s.name.toLowerCase() === text.trim().toLowerCase());
    if (known && !recurring && (canSalaries || !isOwnerOnlyCategory(known.category))) setCategory(known.category);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = money(amount);
    const day = Number(dayOfMonth);
    const due = Number(dueDays);
    const next: Record<string, string> = {};
    if (description.trim().length < 2) next.description = "Say what it is for.";
    if (!Number.isInteger(value) || value <= 0) next.amount = "Whole EGP, more than zero.";
    if (!Number.isInteger(day) || day < 1 || day > 28) next.dayOfMonth = "1 to 28: every month has them.";
    if (!Number.isInteger(due) || due < 0 || due > 90) next.dueDays = "0 to 90 days.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    const name = supplierText.trim().replace(/\s+/g, " ");
    const known = name ? suppliers.find((s) => s.name.toLowerCase() === name.toLowerCase()) : undefined;
    const supplier = known ? { supplierId: known.id } : name ? { supplierName: name } : {};
    try {
      if (recurring) {
        await apiFetch(`/api/recurring-expenses/${recurring.id}`, { method: "PATCH", body: { ...supplier, category, description: description.trim(), amount: value, dueDays: due, note: note.trim() || undefined } });
        toast({ tone: "success", title: "Recurring expense saved", description: "Its next bills take the new terms; those made stay as they are." });
      } else {
        const res = await apiFetch<{ recurring: RecurringDTO }>("/api/recurring-expenses", {
          method: "POST",
          body: { ...supplier, clinicId: clinics.length > 1 ? clinicId : undefined, category, description: description.trim(), amount: value, everyMonths, dayOfMonth: day, dueDays: due, startMonth, note: note.trim() || undefined },
        });
        toast({ tone: "success", title: "Recurring expense set up", description: res.recurring.made ? `${res.recurring.made} bill${res.recurring.made === 1 ? "" : "s"} made for the months gone.` : `Its first bill comes on ${res.recurring.nextOn}.` });
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
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={recurring ? `Edit ${recurring.description}` : "New recurring expense"}
        description={recurring ? "From its next bill on; the bills made stay as they are." : "Its bill is made on its day, every month or every few months, to be paid by the days you give."}
      >
        <form onSubmit={submit} className="space-y-3" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="What for" htmlFor={`${id}-description`} hint={hint("description", "e.g. Clinic rent, the internet line")}>
            <Input id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Supplier (optional)" htmlFor={`${id}-supplier`}>
            <Input id={`${id}-supplier`} list={`${id}-suppliers`} value={supplierText} onChange={(e) => onSupplier(e.target.value)} maxLength={120} autoComplete="off" />
            <datalist id={`${id}-suppliers`}>
              {suppliers.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" htmlFor={`${id}-category`}>
              <Select id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategoryValue)}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {EXPENSE_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={hint("amount")}>
              <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          {!recurring ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="How often" htmlFor={`${id}-every`}>
                <Select id={`${id}-every`} value={everyMonths} onChange={(e) => setEveryMonths(Number(e.target.value))}>
                  {RECURRING_EVERY.map((n) => (
                    <option key={n} value={n}>
                      {RECURRING_EVERY_LABELS[n]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="From" htmlFor={`${id}-start`}>
                <Select id={`${id}-start`} value={startMonth} onChange={(e) => setStartMonth(e.target.value)}>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            {!recurring ? (
              <Field label="On the day" htmlFor={`${id}-day`} hint={hint("dayOfMonth", "Of the month, 1 to 28")}>
                <Input id={`${id}-day`} inputMode="numeric" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} />
              </Field>
            ) : null}
            <Field label="Paid within (days)" htmlFor={`${id}-due`} hint={hint("dueDays", "0: on the day")}>
              <Input id={`${id}-due`} inputMode="numeric" value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
            </Field>
          </div>
          {!recurring && clinics.length > 1 ? (
            <Field label="Branch" htmlFor={`${id}-clinic`}>
              <Select id={`${id}-clinic`} value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
                {clinics.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
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
              {busy ? "Saving…" : recurring ? "Save" : "Set it up"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The owner stops a recurring expense, with the reason: no more bills from it. */
export function StopRecurringButton({ recurring }: { recurring: RecurringDTO }) {
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
      await apiFetch(`/api/recurring-expenses/${recurring.id}/stop`, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: "Recurring expense stopped" });
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
      <Button type="button" size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setOpen(true)} aria-label={`Stop ${recurring.description}`}>
        <Square className="h-4 w-4" aria-hidden="true" />
        Stop
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Stop ${recurring.description}?`} description={`No more bills of ${formatNumber(recurring.amount)} EGP from it. The bills made stay, to be paid.`}>
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
                {busy ? "Stopping…" : "Stop it"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
