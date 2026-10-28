"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { financeErrorMessage } from "./finance-shared";

/** A visit that took place and is free on purpose: charge it nothing, with the reason. */
export function NoChargeButton({ appointmentId, label }: { appointmentId: string; label: string }) {
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
      setError("Say why the visit is free.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/appointments/${appointmentId}/no-charge`, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: "Charged nothing", description: "The reason stays on the patient's account." });
      setOpen(false);
      setReason("");
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
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Ban className="h-3.5 w-3.5" aria-hidden="true" />
        No charge
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="Charge this visit nothing?" description={`${label}. It leaves the not-billed list; the reason stays on the patient's account and in the audit log.`}>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Why is it free?" htmlFor={`${id}-reason`} hint="e.g. a review included in the treatment">
              <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Not now
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Charge nothing"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
