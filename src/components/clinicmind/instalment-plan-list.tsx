"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Ban, BellRing, ChevronDown, ChevronUp, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import { INSTALMENT_STATE_LABELS } from "@/modules/finance/instalment-schedule";
import type { InstalmentPlanDTO } from "@/modules/finance/instalments";
import type { BadgeTone } from "./patient-shared";
import { financeErrorMessage } from "./finance-shared";
import { INSTALMENT_TONE, instalmentName } from "./instalment-shared";
import { RecordPaymentDialog } from "./payment-record-dialog";

const PLAN_TONE: Record<InstalmentPlanDTO["status"], BadgeTone> = { ACTIVE: "accent", COMPLETED: "success", CANCELLED: "default" };
const PLAN_LABEL: Record<InstalmentPlanDTO["status"], string> = { ACTIVE: "Active", COMPLETED: "Paid in full", CANCELLED: "Stopped" };

const day = (key: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`));

/**
 * A patient's instalment plans: what each pays for, how much is paid of it,
 * the next instalment and where it stands, its schedule, and for the desk a
 * payment towards it, a reminder now, or stopping it with a reason.
 */
export function InstalmentPlanList({ plans, patient, timezone, canPay, canRefund }: { plans: InstalmentPlanDTO[]; patient: { id: string; fullName: string }; timezone: string; canPay: boolean; canRefund: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [stopping, setStopping] = useState<InstalmentPlanDTO | null>(null);

  return (
    <>
      <ul className="space-y-3" data-testid="instalment-plans">
        {plans.map((plan) => {
          const share = plan.total ? Math.min(100, Math.round((plan.position.paid * 100) / plan.total)) : 0;
          const next = plan.position.next;
          return (
            <li key={plan.id} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-1.5 font-medium">
                    {plan.title}
                    <Badge tone={PLAN_TONE[plan.status]}>{PLAN_LABEL[plan.status]}</Badge>
                    {plan.position.overdue > 0 && plan.status === "ACTIVE" ? <Badge tone="danger">{plan.position.daysLate} days late</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {plan.downPayment ? `${formatNumber(plan.downPayment)} EGP down, then ` : ""}
                    {plan.count} instalment{plan.count === 1 ? "" : "s"}
                    {plan.everyMonths === 1 ? " a month" : ` every ${plan.everyMonths} months`}
                    {plan.quote?.number ? ` · treatment plan ${plan.quote.number}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right font-mono text-sm tabular-nums">
                  {formatNumber(plan.position.paid)} <span className="text-muted-foreground">/ {formatNumber(plan.total)} EGP</span>
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Paid" aria-valuenow={share} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
              </div>
              {plan.status === "ACTIVE" && next ? (
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone={INSTALMENT_TONE[next.state]}>{INSTALMENT_STATE_LABELS[next.state]}</Badge>
                  <span>
                    Next: {instalmentName(next.number).toLowerCase()} · {formatNumber(next.owed)} EGP · {next.state === "OVERDUE" ? `was due ${day(next.dueKey)}` : `due ${day(next.dueKey)}`}
                  </span>
                  {plan.position.overdue > next.owed ? <span className="text-danger">· {formatNumber(plan.position.overdue)} EGP overdue in all</span> : null}
                </p>
              ) : plan.status === "CANCELLED" && plan.cancelReason ? (
                <p className="text-xs text-muted-foreground">Stopped: {plan.cancelReason}</p>
              ) : null}
              <div className="flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant="ghost" onClick={() => setOpen((o) => ({ ...o, [plan.id]: !o[plan.id] }))} aria-expanded={Boolean(open[plan.id])}>
                  {open[plan.id] ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                  Schedule
                </Button>
                {canPay && plan.status === "ACTIVE" ? (
                  <>
                    <PayPlanButton planId={plan.id} patient={patient} owed={next?.owed} timezone={timezone} canRefund={canRefund} />
                    <RemindPlanButton planId={plan.id} patientName={plan.patient.fullName} consent={plan.patient.reminderConsent} />
                    <Button type="button" size="sm" variant="ghost" onClick={() => setStopping(plan)}>
                      <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                      Stop
                    </Button>
                  </>
                ) : null}
              </div>
              {open[plan.id] ? (
                <table className="w-full border-t border-border text-xs" aria-label={`Schedule of ${plan.title}`}>
                  <thead className="sr-only">
                    <tr>
                      <th scope="col">Instalment</th>
                      <th scope="col">Due</th>
                      <th scope="col">EGP</th>
                      <th scope="col">Where it stands</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.instalments.map((i) => (
                      <tr key={i.id}>
                        <td className="whitespace-nowrap py-1 pr-2">{i.number === 0 ? "Down" : `No. ${i.number}`}</td>
                        <td className="whitespace-nowrap py-1 pr-2 text-muted-foreground">{day(i.dueKey)}</td>
                        <td className="whitespace-nowrap py-1 pr-2 text-right font-mono tabular-nums" title={i.covered > 0 && i.owed > 0 ? `${formatNumber(i.covered)} of it paid` : undefined}>
                          {i.covered > 0 && i.owed > 0 ? `${formatNumber(i.covered)}/` : ""}
                          {formatNumber(i.amount)}
                        </td>
                        <td className="py-1 text-right">
                          <Badge tone={INSTALMENT_TONE[i.state]}>{i.state === "OVERDUE" ? `${i.daysLate} days late` : INSTALMENT_STATE_LABELS[i.state]}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </li>
          );
        })}
      </ul>
      {stopping ? <StopPlanDialog plan={stopping} onClose={() => setStopping(null)} /> : null}
    </>
  );
}

/** A payment towards a plan: the patient fixed, the plan chosen, what is owed next filled in. */
export function PayPlanButton({ planId, patient, owed, timezone, canRefund }: { planId: string; patient: { id: string; fullName: string }; owed?: number; timezone: string; canRefund: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
        Record a payment
      </Button>
      {open ? (
        <RecordPaymentDialog
          timezone={timezone}
          patient={patient}
          canRefund={canRefund}
          defaults={{ kind: "PAYMENT", amount: owed, instalmentPlanId: planId }}
          onOpenChange={setOpen}
          onDone={() => {
            setOpen(false);
            toast({ tone: "success", title: "Payment recorded", description: "It covers the plan's instalments in order." });
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** The reminder for a plan's next instalment, sent now on WhatsApp: not to a patient who asked for none. */
export function RemindPlanButton({ planId, patientName, consent }: { planId: string; patientName: string; consent: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function remind() {
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/api/instalments/${planId}/remind`, { method: "POST" });
      toast({ tone: "success", title: "Reminder sent", description: `On ${patientName.split(" ")[0]}'s WhatsApp conversation.` });
      router.refresh();
    } catch (err) {
      toast({ tone: "danger", title: "Not sent", description: financeErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" size="sm" variant="ghost" disabled={busy || !consent} title={consent ? undefined : "The patient asked for no reminders: call instead"} onClick={() => void remind()}>
      <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
      {busy ? "Sending…" : consent ? "Remind now" : "No reminders"}
    </Button>
  );
}

function StopPlanDialog({ plan, onClose }: { plan: InstalmentPlanDTO; onClose: () => void }) {
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
      await apiFetch(`/api/instalments/${plan.id}/cancel`, { method: "POST", body: { reason: reason.trim() } });
      toast({ tone: "success", title: "Plan stopped" });
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
      <DialogContent title={`Stop ${plan.title}?`} description={`No more reminders. What was paid (${formatNumber(plan.position.paid)} EGP) stays paid; ${formatNumber(plan.position.left)} EGP was still to pay on it.`}>
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
              {busy ? "Stopping…" : "Stop the plan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
