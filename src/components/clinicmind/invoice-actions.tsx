"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Ban, FileCheck2, Printer, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
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
export function InvoiceActions({ invoice, canCancel }: { invoice: InvoiceSummary; canCancel: boolean }) {
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
      {invoice.status !== "CANCELLED" && canCancel ? <CancelInvoiceButton invoiceId={invoice.id} number={invoice.number ?? ""} total={invoice.total} /> : null}
    </div>
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
