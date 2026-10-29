"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Banknote, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { METHOD_LABELS, PAYMENT_METHODS, type PaymentMethodValue } from "@/modules/finance/constants";
import { OTHER_WORK, PAY_BASIS_LABELS, PAY_BASES, PAY_CATEGORIES, payCategoryLabel, type PayBasisValue } from "@/modules/finance/doctor-pay-calc";
import type { PayDoctorDTO, PayRuleDTO } from "@/modules/finance/doctor-pay";
import { financeErrorMessage } from "./finance-shared";
import type { BadgeTone } from "./patient-shared";

const ROLE_LABELS: Record<string, string> = { CLINIC_OWNER: "Owner", DOCTOR: "Doctor", NURSE: "Nurse" };
const monthName = (month: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));

/**
 * The owner's pay rules: for each person paid for their work, a rule for
 * everything they do and, where it differs, one per category (consultation
 * fees, hair, laser…): a share of what is billed or collected, the costs
 * taken off first or not, or a fixed fee per session.
 */
export function PayRulesEditor({ doctors }: { doctors: PayDoctorDTO[] }) {
  const [editing, setEditing] = useState<{ doctor: PayDoctorDTO; rule: PayRuleDTO | null } | null>(null);
  const [removing, setRemoving] = useState<{ doctor: PayDoctorDTO; rule: PayRuleDTO } | null>(null);
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="pay-rules">
      {doctors.map((d) => (
        <section key={d.id} className="bento space-y-3" aria-label={`Pay of ${d.fullName}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-base font-semibold">{d.fullName}</h2>
              <p className="text-xs text-muted-foreground">
                {ROLE_LABELS[d.role] ?? d.role} · {d.payFrom ? `paid for work from ${monthName(d.payFrom)}` : "no pay set"}
              </p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing({ doctor: d, rule: null })}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add a rule
            </Button>
          </div>
          {d.rules.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {d.rules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{r.categoryLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.terms}
                      {r.note ? ` · ${r.note}` : ""}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button type="button" size="sm" variant="ghost" aria-label={`Change the rule for ${r.categoryLabel}`} onClick={() => setEditing({ doctor: d, rule: r })}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <Button type="button" size="sm" variant="ghost" aria-label={`Remove the rule for ${r.categoryLabel}`} onClick={() => setRemoving({ doctor: d, rule: r })}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No rules: their work earns nothing on a statement until one is set.</p>
          )}
          {d.rules.length && !d.rules.some((r) => r.category === OTHER_WORK) ? (
            <p className="text-xs text-warning">No rule for everything else: work outside these categories earns nothing.</p>
          ) : null}
        </section>
      ))}
      {editing ? <RuleDialog doctor={editing.doctor} rule={editing.rule} onClose={() => setEditing(null)} /> : null}
      {removing ? <RemoveRuleDialog doctor={removing.doctor} rule={removing.rule} onClose={() => setRemoving(null)} /> : null}
    </div>
  );
}

function RuleDialog({ doctor, rule, onClose }: { doctor: PayDoctorDTO; rule: PayRuleDTO | null; onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const taken = new Set(doctor.rules.map((r) => r.category));
  const free = PAY_CATEGORIES.filter((c) => !taken.has(c) || c === rule?.category);
  const [category, setCategory] = useState<string>(rule?.category ?? free[0] ?? OTHER_WORK);
  const [basis, setBasis] = useState<PayBasisValue>(rule?.basis ?? "COLLECTED");
  const [percent, setPercent] = useState(rule?.rate !== null && rule?.rate !== undefined ? String(rule.rate / 100) : "");
  const [amount, setAmount] = useState(rule?.amount !== null && rule?.amount !== undefined ? String(rule.amount) : "");
  const [deductCosts, setDeductCosts] = useState(rule?.deductCosts ?? true);
  const [note, setNote] = useState(rule?.note ?? "");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const share = Number(percent.replace(",", "."));
    const fee = Number(amount.replace(/[,\s]/g, ""));
    const next: Record<string, string> = {};
    if (basis === "FIXED" && (!Number.isInteger(fee) || fee < 0 || !amount.trim())) next.amount = "Whole EGP.";
    if (basis !== "FIXED" && (!percent.trim() || !Number.isFinite(share) || share < 0 || share > 100)) next.percent = "0 to 100.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/doctor-pay/rules", {
        method: "POST",
        body: { doctorId: doctor.id, category, basis, ...(basis === "FIXED" ? { amount: fee } : { percent: share, deductCosts }), note: note.trim() || undefined },
      });
      toast({ tone: "success", title: rule ? "Rule changed" : "Rule added", description: `${doctor.fullName} · ${payCategoryLabel(category)}` });
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

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={rule ? `${doctor.fullName}: ${rule.categoryLabel}` : `A rule for ${doctor.fullName}`} description="It applies to every month not closed yet, from the work's first day in it.">
        <form onSubmit={submit} className="space-y-3" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <Field label="For" htmlFor={`${id}-category`} hint={hint("category", category === OTHER_WORK ? "Whatever their other rules do not cover" : undefined)}>
            <Select id={`${id}-category`} value={category} onChange={(e) => setCategory(e.target.value)} disabled={Boolean(rule)}>
              {free.map((c) => (
                <option key={c} value={c}>
                  {payCategoryLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Paid as" htmlFor={`${id}-basis`}>
            <Select id={`${id}-basis`} value={basis} onChange={(e) => setBasis(e.target.value as PayBasisValue)}>
              {PAY_BASES.map((b) => (
                <option key={b} value={b}>
                  {PAY_BASIS_LABELS[b]}
                </option>
              ))}
            </Select>
          </Field>
          {basis === "FIXED" ? (
            <Field label="EGP a session" htmlFor={`${id}-amount`} hint={hint("amount", "For each session done (a procedure done at once is one)")}>
              <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-40" />
            </Field>
          ) : (
            <>
              <Field label="Share (%)" htmlFor={`${id}-percent`} hint={hint("percent", basis === "BILLED" ? "Of what is billed for their work, after discounts" : "Of what is collected for their work, as it comes in")}>
                <Input id={`${id}-percent`} inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} className="w-32" />
              </Field>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={deductCosts} onChange={(e) => setDeductCosts(e.target.checked)} className="mt-0.5" />
                <span>
                  Take the lab and material costs off first
                  <span className="block text-xs text-muted-foreground">The share is never below zero.</span>
                </span>
              </label>
            </>
          )}
          <Field label="Note (optional)" htmlFor={`${id}-note`}>
            <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save the rule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveRuleDialog({ doctor, rule, onClose }: { doctor: PayDoctorDTO; rule: PayRuleDTO; onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/doctor-pay/rules/${rule.id}`, { method: "DELETE" });
      toast({ tone: "success", title: "Rule removed", description: `${doctor.fullName} · ${rule.categoryLabel}` });
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
      <DialogContent
        title={`Remove ${doctor.fullName}'s rule for ${rule.categoryLabel}?`}
        description={rule.category === OTHER_WORK ? "Work their other rules do not cover will earn nothing in the months not closed yet." : "Their rule for everything else covers it from now on, in the months not closed yet."}
      >
        {error ? <Alert>{error}</Alert> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              Keep it
            </Button>
          </DialogClose>
          <Button type="button" variant="danger" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove the rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Close a month that is over: the statement is kept as it is and never changes, but to be marked paid. */
export function CloseStatementButton({ doctorId, doctorName, month, payable, carriedForward }: { doctorId: string; doctorName: string; month: string; payable: number; carriedForward: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function close() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/doctor-pay/statements/${doctorId}/close`, { method: "POST", body: { month } });
      toast({ tone: "success", title: `${monthName(month)} closed`, description: payable ? `${formatNumber(payable)} EGP to pay ${doctorName}.` : "Nothing to pay this month." });
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
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Lock className="h-4 w-4" aria-hidden="true" />
        Close {monthName(month)}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Close ${doctorName}'s ${monthName(month)}?`}
          description={`The statement is kept as it is now: ${formatNumber(payable)} EGP to pay${carriedForward ? `, ${formatNumber(-carriedForward)} EGP owed back to the next month` : ""}. Work, money and costs that come in later count in the next month.`}
        >
          {error ? <Alert>{error}</Alert> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Not yet
              </Button>
            </DialogClose>
            <Button type="button" disabled={busy} onClick={() => void close()}>
              {busy ? "Closing…" : "Close the month"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The clinic paid a closed statement: the day, how, and the reference. */
export function MarkPaidButton({ doctorId, doctorName, month, payable, timezone }: { doctorId: string; doctorName: string; month: string; payable: number; timezone: string }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const today = dateKeyInTz(new Date(), timezone);
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<PaymentMethodValue>("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [day, setDay] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/doctor-pay/statements/${doctorId}/paid`, { method: "POST", body: { month, method, reference: reference.trim() || undefined, paidOn: day } });
      toast({ tone: "success", title: "Marked as paid", description: `${formatNumber(payable)} EGP to ${doctorName} for ${monthName(month)}.` });
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
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Banknote className="h-4 w-4" aria-hidden="true" />
        Mark as paid
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Pay ${doctorName} for ${monthName(month)}`} description={`${formatNumber(payable)} EGP.`}>
          <form onSubmit={submit} className="space-y-3" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label="How" htmlFor={`${id}-method`}>
                <Select id={`${id}-method`} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethodValue)}>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Day" htmlFor={`${id}-day`}>
                <Input id={`${id}-day`} type="date" max={today} value={day} onChange={(e) => setDay(e.target.value)} />
              </Field>
            </div>
            <Field label="Reference (optional)" htmlFor={`${id}-reference`} hint="Transfer or cheque number">
              <Input id={`${id}-reference`} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Mark as paid"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Where a month's statement stands. */
export function StatementStatusBadge({ status, payable }: { status: "OPEN" | "CLOSED" | "PAID" | "COVERED"; payable: number }) {
  const map: Record<typeof status, [string, BadgeTone]> = {
    OPEN: ["Open", "warning"],
    CLOSED: payable > 0 ? ["Closed · to pay", "accent"] : ["Closed · nothing to pay", "default"],
    PAID: ["Paid", "success"],
    COVERED: ["In a later statement", "default"],
  };
  const [label, tone] = map[status];
  return <Badge tone={tone}>{label}</Badge>;
}
