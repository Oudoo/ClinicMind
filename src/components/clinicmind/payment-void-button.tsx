"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch } from "@/lib/http";
import { financeErrorMessage } from "./finance-shared";

/**
 * Void a payment (owner only): it leaves every total but stays in the audit
 * trail and on the timeline, with the reason.
 */
export function PaymentVoidButton({ paymentId, label, onDone }: { paymentId: string; label: string; onDone?: () => void }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError("Say why the payment is voided.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/payments/${paymentId}/void`, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: "Payment voided", description: label });
      setOpen(false);
      setReason("");
      onDone?.();
      router.refresh();
    } catch (err) {
      setError(financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Void ${label}`} title="Void this payment">
        <Ban className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="sr-only sm:not-sr-only">Void</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Void this payment?" description={`${label}. It leaves every total and stays in the audit trail.`}>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Reason" htmlFor={`${id}-reason`}>
              <DictationField onDictated={setReason} disabled={busy}>
                <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-[4.5rem]" placeholder="e.g. Entered twice" />
              </DictationField>
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Keep it
                </Button>
              </DialogClose>
              <Button type="submit" variant="danger" disabled={busy}>
                {busy ? "Voiding…" : "Void payment"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
