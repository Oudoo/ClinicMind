"use client";

import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, CalendarPlus, CopyPlus, FileCheck2, PenLine, Pencil, Send, ThumbsDown, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import type { QuoteDTO } from "@/modules/quotes/dto";
import { PrintButton } from "./invoice-actions";
import { financeErrorMessage } from "./finance-shared";
import { QuoteAnswerForm } from "./quote-answer-form";

/**
 * What can be done with a treatment plan from its page. A draft is edited,
 * given to the patient (numbered, to print), sent on WhatsApp, signed on the
 * clinic's screen or discarded; an open one is printed, sent again, signed in
 * the clinic, declined, given more days, withdrawn or revised; an answered
 * one is printed or revised into a new plan.
 */
export function QuoteActions({ quote, todayKey }: { quote: QuoteDTO; todayKey: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<null | "give" | "discard" | "sign" | "decline" | "extend" | "withdraw">(null);
  const first = quote.patient.fullName.split(/\s+/)[0] ?? quote.patient.fullName;
  const live = quote.state === "DRAFT" || quote.state === "SENT";

  async function run(action: () => Promise<unknown>, done: (result: unknown) => void) {
    if (busy) return;
    setBusy(true);
    try {
      done(await action());
    } catch (err) {
      toast({ tone: "danger", title: "That did not work", description: financeErrorMessage(err) });
    } finally {
      setBusy(false);
      setOpen(null);
    }
  }

  const send = () =>
    run(
      () => apiFetch<{ delivery: string; quote: { number: string } }>(`/api/quotes/${quote.id}/send`, { method: "POST" }),
      (res) => {
        toast({ tone: "success", title: `${(res as { quote: { number: string } }).quote.number} sent`, description: `On ${first}'s conversation, with the link to read and sign it.` });
        router.refresh();
      },
    );
  const revise = () =>
    run(
      () => apiFetch<{ quote: { id: string } }>(`/api/quotes/${quote.id}/revise`, { method: "POST" }),
      (res) => {
        toast({ tone: "success", title: "A new draft of the plan", description: "Change it, then give it: it replaces this one if this one is still open." });
        router.push(`/dashboard/quotes/${(res as { quote: { id: string } }).quote.id}/edit`);
      },
    );

  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      {quote.status === "DRAFT" ? (
        <>
          <Button asChild variant="outline" size="sm">
            <Link href={`/dashboard/quotes/${quote.id}/edit`}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Edit
            </Link>
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setOpen("give")}>
            <FileCheck2 className="h-4 w-4" aria-hidden="true" />
            Give to print
          </Button>
        </>
      ) : (
        <PrintButton />
      )}
      {quote.state === "DRAFT" || quote.state === "SENT" ? (
        <Button type="button" size="sm" disabled={busy} onClick={() => void send()}>
          <Send className="h-4 w-4" aria-hidden="true" />
          {quote.linkSentAt ? "Send again on WhatsApp" : "Send on WhatsApp"}
        </Button>
      ) : null}
      {live ? (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setOpen("sign")}>
          <PenLine className="h-4 w-4" aria-hidden="true" />
          Sign in the clinic
        </Button>
      ) : null}
      {quote.status === "SENT" ? (
        <>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setOpen("extend")}>
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            {quote.state === "EXPIRED" ? "Give it more days" : "Change the last day"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen("decline")}>
            <ThumbsDown className="h-4 w-4" aria-hidden="true" />
            Patient declined
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen("withdraw")}>
            <Ban className="h-4 w-4" aria-hidden="true" />
            Withdraw
          </Button>
        </>
      ) : null}
      {quote.status !== "DRAFT" ? (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void revise()}>
          <CopyPlus className="h-4 w-4" aria-hidden="true" />
          Revise
        </Button>
      ) : (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen("discard")}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Discard
        </Button>
      )}

      <ConfirmDialog
        open={open === "give"}
        onOpenChange={(o) => !o && setOpen(null)}
        title="Give this plan to the patient?"
        description={`${formatNumber(quote.total)} EGP for ${quote.patient.fullName}. It takes the branch's next quote number and can no longer change; its prices hold until its last valid day. Print it next.`}
        confirmLabel={busy ? "Giving…" : "Give it"}
        busy={busy}
        onConfirm={() =>
          run(
            () => apiFetch(`/api/quotes/${quote.id}/give`, { method: "POST" }),
            () => {
              toast({ tone: "success", title: "Numbered and ready to print" });
              router.refresh();
            },
          )
        }
      />
      <ConfirmDialog
        open={open === "discard"}
        onOpenChange={(o) => !o && setOpen(null)}
        title="Discard this draft?"
        description="It was never given to the patient, so nothing of it is kept."
        confirmLabel={busy ? "Discarding…" : "Discard the draft"}
        tone="danger"
        busy={busy}
        onConfirm={() =>
          run(
            () => apiFetch(`/api/quotes/${quote.id}`, { method: "DELETE" }),
            () => {
              toast({ tone: "success", title: "Draft discarded" });
              router.push(`/dashboard/patients/${quote.patient.id}`);
            },
          )
        }
      />

      <Dialog open={open === "sign"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent
          title="Sign on this screen"
          description={quote.status === "DRAFT" ? "Hand the screen to the patient. Signing gives the plan its number in the same step." : "Hand the screen to the patient: they choose, type their name and sign."}
          className="max-w-2xl"
        >
          <QuoteAnswerForm
            quote={quote}
            mode={{ kind: "clinic", quoteId: quote.id }}
            onDone={() => {
              setOpen(null);
              toast({ tone: "success", title: "Signed", description: "The accepted treatments are planned procedures now: book the first one." });
            }}
          />
        </DialogContent>
      </Dialog>

      <ReasonDialog
        open={open === "decline"}
        onOpenChange={(o) => !o && setOpen(null)}
        title="The patient declined"
        description="Record their answer, and why if they said."
        label="Why (optional)"
        required={false}
        confirmLabel="Record the decline"
        onSubmit={(reason) => apiFetch(`/api/quotes/${quote.id}/decline`, { method: "POST", body: reason ? { reason } : {} })}
        onDone={() => {
          toast({ tone: "success", title: "Declined" });
          setOpen(null);
          router.refresh();
        }}
      />
      <ReasonDialog
        open={open === "withdraw"}
        onOpenChange={(o) => !o && setOpen(null)}
        title="Withdraw this quote?"
        description="The patient can no longer accept it. To change the plan, revise it instead: the revision replaces it once given."
        label="Why"
        required
        confirmLabel="Withdraw"
        onSubmit={(reason) => apiFetch(`/api/quotes/${quote.id}/withdraw`, { method: "POST", body: { reason } })}
        onDone={() => {
          toast({ tone: "success", title: "Withdrawn" });
          setOpen(null);
          router.refresh();
        }}
      />
      <ExtendDialog
        open={open === "extend"}
        onOpenChange={(o) => !o && setOpen(null)}
        quoteId={quote.id}
        current={quote.validUntilKey}
        todayKey={todayKey}
        onDone={() => {
          toast({ tone: "success", title: "New last day saved" });
          setOpen(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  required,
  confirmLabel,
  onSubmit,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  required: boolean;
  confirmLabel: string;
  onSubmit: (reason: string) => Promise<unknown>;
  onDone: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (required && reason.trim().length < 3) {
      setError("Say why, in a few words.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setReason("");
      onDone();
    } catch (err) {
      setError(fieldErrors(err).reason ?? financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label={label} htmlFor={`${id}-reason`}>
            <Textarea id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="min-h-[5rem]" />
          </Field>
          {error ? <Alert>{error}</Alert> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ExtendDialog({ open, onOpenChange, quoteId, current, todayKey, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; quoteId: string; current: string; todayKey: string; onDone: () => void }) {
  const id = useId();
  const [day, setDay] = useState(current < todayKey ? todayKey : current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < todayKey) {
      setError("Today or later.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/quotes/${quoteId}/extend`, { method: "POST", body: { validUntil: day } });
      onDone();
    } catch (err) {
      setError(fieldErrors(err).validUntil ?? financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="The last day it can be accepted" description="Its prices hold until then; an expired quote opens again.">
        <form onSubmit={submit} className="space-y-3" noValidate>
          <Field label="Valid until" htmlFor={`${id}-day`}>
            <Input id={`${id}-day`} type="date" min={todayKey} value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          {error ? <Alert>{error}</Alert> : null}
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
  );
}
