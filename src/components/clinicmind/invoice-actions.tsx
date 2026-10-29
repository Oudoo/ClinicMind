"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Ban, FileCheck2, Percent, Printer, Send, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import {
  DISCOUNT_REASON_LABELS,
  DISCOUNT_REASONS,
  WRITE_OFF_REASON_LABELS,
  WRITE_OFF_REASONS,
  withinDiscountLimit,
  type DiscountReasonValue,
  type WriteOffReasonValue,
} from "@/modules/finance/constants";
import { financeErrorMessage } from "./finance-shared";

/** Print the page's document (the browser's "Save as PDF" makes the PDF). */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <Button type="button" variant="outline" size="sm" className="no-print" onClick={() => window.print()}>
      <Printer className="h-4 w-4" aria-hidden="true" />
      {label}
    </Button>
  );
}

interface InvoiceSummary {
  id: string;
  status: string;
  number: string | null;
  total: number;
  /** Left to pay on an issued invoice. */
  due?: number;
  /** A draft's lines, and which are discounts of which charge (so a line is discounted within its role's limit). */
  lines?: { chargeId: string; description: string; amount: number }[];
  discountOf?: Record<string, string>;
  language: "en" | "ar";
  patientId: string;
  patientName: string;
  sentAt: string | null;
}

/**
 * What can be done with an invoice from its page: a draft is issued (its
 * number is taken then), put in Arabic or English, or discarded; an issued
 * one is printed, sent to the patient on WhatsApp, or cancelled by the owner
 * with a credit note.
 */
export function InvoiceActions({ invoice, canCancel, discountLimit = 100 }: { invoice: InvoiceSummary; canCancel: boolean; discountLimit?: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "issue" | "discard">(null);

  async function run(action: () => Promise<unknown>, done: () => void) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      done();
    } catch (err) {
      toast({ tone: "danger", title: "That did not work", description: financeErrorMessage(err) });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  const language = (next: string) =>
    run(
      () => apiFetch(`/api/invoices/${invoice.id}`, { method: "PATCH", body: { language: next } }),
      () => router.refresh(),
    );

  if (invoice.status === "DRAFT") {
    return (
      <div className="no-print flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Language
          <Select value={invoice.language} onChange={(e) => void language(e.target.value)} disabled={busy} className="w-36">
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </Select>
        </label>
        <Button type="button" onClick={() => setConfirm("issue")} disabled={busy}>
          <FileCheck2 className="h-4 w-4" aria-hidden="true" />
          Issue invoice
        </Button>
        {invoice.lines?.length ? <DiscountLineButton invoiceId={invoice.id} lines={invoice.lines} discountOf={invoice.discountOf ?? {}} limit={discountLimit} /> : null}
        <Button type="button" variant="ghost" onClick={() => setConfirm("discard")} disabled={busy}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Discard draft
        </Button>
        <ConfirmDialog
          open={confirm === "issue"}
          onOpenChange={(o) => !o && setConfirm(null)}
          title="Issue this invoice?"
          description={`${formatNumber(invoice.total)} EGP to ${invoice.patientName}. It takes the branch's next number and can no longer change; what the patient has paid ahead goes towards it.`}
          confirmLabel={busy ? "Issuing…" : "Issue invoice"}
          busy={busy}
          onConfirm={() =>
            run(
              () => apiFetch(`/api/invoices/${invoice.id}/issue`, { method: "POST" }),
              () => {
                toast({ tone: "success", title: "Invoice issued" });
                router.refresh();
              },
            )
          }
        />
        <ConfirmDialog
          open={confirm === "discard"}
          onOpenChange={(o) => !o && setConfirm(null)}
          title="Discard this draft?"
          description="It has no number yet; its charges go back to unbilled."
          confirmLabel={busy ? "Discarding…" : "Discard draft"}
          busy={busy}
          onConfirm={() =>
            run(
              () => apiFetch(`/api/invoices/${invoice.id}`, { method: "DELETE" }),
              () => {
                toast({ tone: "success", title: "Draft discarded" });
                router.push(`/dashboard/patients/${invoice.patientId}`);
              },
            )
          }
        />
      </div>
    );
  }

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <PrintButton />
      {invoice.status !== "CANCELLED" ? (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() =>
            run(
              () => apiFetch<{ delivery: string }>(`/api/invoices/${invoice.id}/send`, { method: "POST" }),
              () => {
                toast({ tone: "success", title: `${invoice.number} sent`, description: `On ${invoice.patientName.split(" ")[0]}'s conversation, with a link to the invoice.` });
                router.refresh();
              },
            )
          }
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {invoice.sentAt ? "Send again on WhatsApp" : "Send on WhatsApp"}
        </Button>
      ) : null}
      {canCancel && (invoice.status === "ISSUED" || invoice.status === "PART_PAID") && (invoice.due ?? 0) > 0 ? (
        <WriteOffButton invoiceId={invoice.id} number={invoice.number ?? ""} due={invoice.due ?? 0} />
      ) : null}
      {invoice.status !== "CANCELLED" && canCancel ? <CancelInvoiceButton invoiceId={invoice.id} number={invoice.number ?? ""} total={invoice.total} /> : null}
    </div>
  );
}

/**
 * Discount a line of a draft: how much off, why (the fixed list), within the
 * role's limit for the line (all its discounts together); above it, the
 * clinic owner's. The discount is its own line on the invoice.
 */
function DiscountLineButton({ invoiceId, lines, discountOf, limit }: { invoiceId: string; lines: { chargeId: string; description: string; amount: number }[]; discountOf: Record<string, string>; limit: number }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  // The work on the draft, and what its discounts already take off.
  const work = lines.filter((l) => l.amount > 0 && !discountOf[l.chargeId]);
  const off = (chargeId: string) => -lines.filter((l) => discountOf[l.chargeId] === chargeId).reduce((s, l) => s + l.amount, 0);
  const [open, setOpen] = useState(false);
  // The first line that still has room under the role's limit.
  const [chargeId, setChargeId] = useState((work.find((l) => off(l.chargeId) < Math.floor((l.amount * limit) / 100)) ?? work[0])?.chargeId ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<DiscountReasonValue | "">("");
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const line = work.find((l) => l.chargeId === chargeId) ?? null;
  const already = line ? off(line.chargeId) : 0;
  const most = line ? Math.min(line.amount - already, Math.max(0, Math.floor((line.amount * limit) / 100) - already)) : 0;
  if (!work.length) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !line) return;
    const value = Number(amount.replace(/[,\s]/g, ""));
    const next: Record<string, string> = {};
    if (!Number.isInteger(value) || value <= 0) next.amount = "Whole EGP, more than zero.";
    else if (value + already > line.amount) next.amount = "A discount cannot be more than the line.";
    else if (!withinDiscountLimit(line.amount, value + already, limit)) next.amount = limit > 0 ? `Your role can give up to ${limit}% off a line: more needs the clinic owner.` : "Discounts are given by the clinic owner.";
    if (!reason) next.reason = "Choose why the discount is given.";
    else if (reason === "OTHER" && !note.trim()) next.note = "Say why the discount is given.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/discount`, { method: "POST", body: { chargeId: line.chargeId, amount: value, reason, note: note.trim() || undefined } });
      toast({ tone: "success", title: `${formatNumber(value)} EGP off`, description: line.description });
      setOpen(false);
      setAmount("");
      setNote("");
      router.refresh();
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
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Percent className="h-4 w-4" aria-hidden="true" />
        Discount a line
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Discount a line" description={limit < 100 ? `Your role can give up to ${limit}% off a line; more needs the clinic owner.` : "The discount is its own line on the invoice, with its reason."} className="max-w-lg">
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Line" htmlFor={`${id}-line`} hint={line ? `${formatNumber(line.amount)} EGP${already ? `, ${formatNumber(already)} off already` : ""} · up to ${formatNumber(most)} EGP more at your role` : undefined}>
              <Select id={`${id}-line`} value={chargeId} onChange={(e) => setChargeId(e.target.value)}>
                {work.map((l) => (
                  <option key={l.chargeId} value={l.chargeId}>
                    {l.description} · {formatNumber(l.amount)} EGP
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Amount off (EGP)" htmlFor={`${id}-amount`} hint={issue("amount")}>
                <div className="flex gap-2">
                  <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={issues.amount ? true : undefined} placeholder="e.g. 200" />
                  {line && most > 0 ? (
                    <Button type="button" variant="outline" size="sm" className="h-10 shrink-0" onClick={() => setAmount(String(most))}>
                      Most
                    </Button>
                  ) : null}
                </div>
              </Field>
              <Field label="Why the discount?" htmlFor={`${id}-reason`} hint={issue("reason")}>
                <Select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as DiscountReasonValue)} aria-invalid={issues.reason ? true : undefined}>
                  <option value="" disabled>
                    Choose a reason…
                  </option>
                  {DISCOUNT_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {DISCOUNT_REASON_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="In a word" htmlFor={`${id}-note`} hint={issue("note") ?? (reason === "OTHER" ? "Required for another reason" : "Optional")}>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-invalid={issues.note ? true : undefined} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Close
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Take it off"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The owner writes off what is left on an issued invoice (or part of it), with the reason. */
function WriteOffButton({ invoiceId, number, due }: { invoiceId: string; number: string; due: number }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(due));
  const [reason, setReason] = useState<WriteOffReasonValue | "">("");
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const value = Number(amount.replace(/[,\s]/g, ""));
    const next: Record<string, string> = {};
    if (!Number.isInteger(value) || value <= 0) next.amount = "Whole EGP, more than zero.";
    else if (value > due) next.amount = `At most ${formatNumber(due)} EGP is left to pay.`;
    if (!reason) next.reason = "Choose why it is written off.";
    else if (reason === "OTHER" && !note.trim()) next.note = "Say why it is written off.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/write-off`, { method: "POST", body: { amount: value, reason, note: note.trim() || undefined } });
      toast({ tone: "success", title: `${formatNumber(value)} EGP written off`, description: `On ${number}.` });
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

  const issue = (key: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : undefined);
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Undo2 className="h-4 w-4" aria-hidden="true" />
        Write off
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Write off on ${number}?`} description={`${formatNumber(due)} EGP is left to pay. What is written off no longer counts as owed; it stays on the invoice and in the reports, and goes only if the invoice is cancelled.`} className="max-w-lg">
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Amount (EGP)" htmlFor={`${id}-amount`} hint={issue("amount")}>
                <Input id={`${id}-amount`} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={issues.amount ? true : undefined} />
              </Field>
              <Field label="Why?" htmlFor={`${id}-reason`} hint={issue("reason")}>
                <Select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value as WriteOffReasonValue)} aria-invalid={issues.reason ? true : undefined}>
                  <option value="" disabled>
                    Choose a reason…
                  </option>
                  {WRITE_OFF_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {WRITE_OFF_REASON_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="In a word" htmlFor={`${id}-note`} hint={issue("note") ?? (reason === "OTHER" ? "Required for another reason" : "Optional")}>
              <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-invalid={issues.note ? true : undefined} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Keep it owed
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? "Writing off…" : "Write off"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The owner cancels an issued invoice with a reason; a numbered credit note records it. */
function CancelInvoiceButton({ invoiceId, number, total }: { invoiceId: string; number: string; total: number }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 3) {
      setError("Say why the invoice is cancelled.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/invoices/${invoiceId}/cancel`, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: `${number} cancelled`, description: "A credit note records it; what was paid on it is the patient's credit." });
      setOpen(false);
      router.refresh();
    } catch (err) {
      const found = fieldErrors(err);
      setError(found.reason ?? financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Ban className="h-4 w-4" aria-hidden="true" />
        Cancel with a credit note
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Cancel ${number}?`} description={`A credit note for ${formatNumber(total)} EGP cancels it; the invoice stays on file. What was paid on it becomes the patient's credit, and its charges can be invoiced again.`}>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Reason" htmlFor={`${id}-reason`} hint="Printed on the credit note">
              <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Keep it
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? "Cancelling…" : "Cancel with a credit note"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Make a draft invoice from the patient's unbilled charges, then open it. */
export function CreateInvoiceButton({ patientId, count, total }: { patientId: string; count: number; total: number }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={busy}
      title={`${count} unbilled charge${count === 1 ? "" : "s"}, ${formatNumber(total)} EGP`}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await apiFetch<{ invoice: { id: string } }>("/api/invoices", { method: "POST", body: { patientId } });
          router.push(`/dashboard/finance/invoices/${res.invoice.id}`);
        } catch (err) {
          toast({ tone: "danger", title: "Could not make the invoice", description: financeErrorMessage(err) });
          setBusy(false);
        }
      }}
    >
      <FileCheck2 className="h-4 w-4" aria-hidden="true" />
      {busy ? "Preparing…" : `Invoice ${count} unbilled (${formatNumber(total)} EGP)`}
    </Button>
  );
}
