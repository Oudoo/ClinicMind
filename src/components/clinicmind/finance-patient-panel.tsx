"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { RecordPaymentDialog } from "./payment-record-dialog";
import { RecordProcedureDialog } from "./procedure-record-dialog";
import { ProcedureCancelButton, ProcedureSignButton } from "./procedure-actions";
import { PaymentVoidButton } from "./payment-void-button";
import {
  KIND_LABELS,
  KIND_TONE,
  METHOD_LABELS,
  PROCEDURE_STATUS_LABELS,
  STATUS_TONE,
  signedAmount,
  type DoctorOption,
  type PaymentItem,
  type PriceOption,
  type ProcedureChoice,
  type ProcedureItem,
  type TreatmentOption,
} from "./finance-shared";

const SHOWN = 6;

/**
 * The patient's procedures (treatment, date, doctor, price, status, balance)
 * and payments, with the actions each role may take: record a procedure,
 * sign it (clinicians), record a payment (front desk, nurse, owner), void a
 * payment (owner).
 */
export function FinancePatientPanel({
  patient,
  timezone,
  procedures,
  payments,
  treatments,
  priceItems = [],
  doctors,
  canRecordProcedure,
  canSign,
  canPay,
  canVoid,
}: {
  patient: { id: string; fullName: string };
  timezone: string;
  procedures: ProcedureItem[];
  /** null when the role may not see the payment list. */
  payments: PaymentItem[] | null;
  treatments: TreatmentOption[];
  /** The price list as of today (the dialog reprices for another day). */
  priceItems?: PriceOption[];
  doctors: DoctorOption[];
  canRecordProcedure: boolean;
  canSign: boolean;
  canPay: boolean;
  canVoid: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<null | { kind: "procedure" } | { kind: "payment"; procedureId?: string; amount?: number }>(null);
  const [allProcedures, setAllProcedures] = useState(false);
  const [allPayments, setAllPayments] = useState(false);

  const signed = procedures.filter((p) => p.status === "SIGNED");
  const billed = signed.reduce((s, p) => s + p.price - p.discount, 0);
  const owing = signed.reduce((s, p) => s + Math.max(0, p.balance), 0);
  const paid = payments ? payments.reduce((s, p) => s + signedAmount(p), 0) : null;
  const date = (iso: string) => formatDateInTz(new Date(iso), timezone);
  const choices: ProcedureChoice[] = procedures
    .filter((p) => p.status !== "CANCELLED")
    .map((p) => ({
      id: p.id,
      balance: p.balance,
      label: `${p.treatmentName} · ${date(p.performedAt)}${p.status === "PLANNED" ? " · planned" : p.balance > 0 ? ` · owes ${formatNumber(p.balance)} EGP` : " · paid"}`,
    }));
  const done = (title: string) => {
    setDialog(null);
    toast({ tone: "success", title });
    router.refresh();
  };

  const shownProcedures = allProcedures ? procedures : procedures.slice(0, SHOWN);
  const shownPayments = payments ? (allPayments ? payments : payments.slice(0, SHOWN)) : [];

  return (
    <Card className="space-y-4">
      <SectionTitle
        title="Procedures & payments"
        description="What was done, what it cost and what is still owed."
        action={owing > 0 ? <Badge tone="warning">owes {formatNumber(owing)} EGP</Badge> : signed.length ? <Badge tone="success">settled</Badge> : null}
      />
      <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/60 p-3 text-center">
        <div>
          <dt className="data-label">Billed</dt>
          <dd className="font-mono text-sm tabular-nums">{formatNumber(billed)}</dd>
        </div>
        <div>
          <dt className="data-label" title="Everything received, consultation fees and deposits included, net of refunds">Received</dt>
          <dd className="font-mono text-sm tabular-nums">{paid === null ? "—" : formatNumber(paid)}</dd>
        </div>
        <div>
          <dt className="data-label">Balance</dt>
          <dd className={owing > 0 ? "font-mono text-sm tabular-nums text-warning" : "font-mono text-sm tabular-nums"}>{formatNumber(owing)}</dd>
        </div>
      </dl>

      {canRecordProcedure || canPay ? (
        <div className="flex flex-wrap gap-2">
          {canRecordProcedure ? (
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "procedure" })}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Record a procedure
            </Button>
          ) : null}
          {canPay ? (
            <Button size="sm" onClick={() => setDialog({ kind: "payment" })}>
              <Receipt className="h-4 w-4" aria-hidden="true" />
              Record a payment
            </Button>
          ) : null}
        </div>
      ) : null}

      <section aria-label="Procedures" className="space-y-2">
        <h3 className="data-label">Procedures</h3>
        {procedures.length ? (
          <ul className="space-y-2">
            {shownProcedures.map((p) => {
              const label = `${p.treatmentName} on ${date(p.performedAt)}`;
              return (
                <li key={p.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{p.treatmentName}</span>
                        <Badge tone={STATUS_TONE[p.status]}>{PROCEDURE_STATUS_LABELS[p.status]}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-mono">{date(p.performedAt)}</span>
                        {p.doctorName ? ` · ${p.doctorName}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm tabular-nums">{formatNumber(p.price - p.discount)} EGP</div>
                      {p.discount ? <div className="font-mono text-[11px] text-muted-foreground">−{formatNumber(p.discount)} discount</div> : null}
                    </div>
                  </div>
                  {p.status !== "CANCELLED" ? (
                    <p className="mt-1 text-xs">
                      {p.balance > 0 ? (
                        <span className="text-warning">Balance {formatNumber(p.balance)} EGP</span>
                      ) : p.balance < 0 ? (
                        <span className="text-muted-foreground">Overpaid by {formatNumber(-p.balance)} EGP</span>
                      ) : (
                        <span className="text-success">Paid in full</span>
                      )}
                      {p.paid ? <span className="text-muted-foreground"> · {formatNumber(p.paid)} EGP received</span> : null}
                    </p>
                  ) : p.cancelReason ? (
                    <p className="mt-1 text-xs text-muted-foreground">Cancelled: {p.cancelReason}</p>
                  ) : null}
                  {p.notes ? <p className="mt-1 text-xs text-muted-foreground">{p.notes}</p> : null}
                  {p.status !== "CANCELLED" && (canSign || canRecordProcedure || canPay) ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {p.status === "PLANNED" && canSign ? <ProcedureSignButton procedureId={p.id} label={label} /> : null}
                      {canPay && p.balance > 0 ? (
                        <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "payment", procedureId: p.id, amount: p.balance })}>
                          Pay balance
                        </Button>
                      ) : null}
                      {p.status === "PLANNED" && canRecordProcedure ? <ProcedureCancelButton procedureId={p.id} label={label} /> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="No procedures yet" hint={canRecordProcedure ? "Record one from the consultation's plan." : "Procedures appear once recorded."} />
        )}
        {procedures.length > SHOWN ? (
          <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={() => setAllProcedures((v) => !v)}>
            {allProcedures ? "Show fewer" : `Show all ${procedures.length}`}
          </button>
        ) : null}
      </section>

      {payments ? (
        <section aria-label="Payments" className="space-y-2">
          <h3 className="data-label">Payments</h3>
          {payments.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {shownPayments.map((p) => {
                const amount = signedAmount(p);
                return (
                  <li key={p.id} className="flex items-start justify-between gap-2 p-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={KIND_TONE[p.kind]}>{KIND_LABELS[p.kind]}</Badge>
                        <span className="text-xs text-muted-foreground">{METHOD_LABELS[p.method]}</span>
                        {p.imported ? <Badge>POS import</Badge> : null}
                      </div>
                      <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
                        <span className="whitespace-nowrap font-mono">{date(p.paidAt)}</span>
                        {p.procedureLabel ? <span className="whitespace-nowrap">· {p.procedureLabel}</span> : null}
                        {p.reference ? <span className="whitespace-nowrap font-mono">· {p.reference}</span> : null}
                      </p>
                      {p.note ? <p className="mt-0.5 text-xs">{p.note}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className={amount < 0 ? "font-mono text-sm tabular-nums text-danger" : "font-mono text-sm tabular-nums"}>
                        {amount < 0 ? "−" : ""}
                        {formatNumber(Math.abs(amount))}
                      </span>
                      {canVoid ? <PaymentVoidButton paymentId={p.id} label={`${KIND_LABELS[p.kind]} of ${formatNumber(p.amount)} EGP on ${date(p.paidAt)}`} /> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title="No payments yet" hint={canPay ? "Record a deposit, a payment or the consultation fee." : "Payments appear once recorded."} />
          )}
          {payments.length > SHOWN ? (
            <button type="button" className="text-xs text-accent underline-offset-2 hover:underline" onClick={() => setAllPayments((v) => !v)}>
              {allPayments ? "Show fewer" : `Show all ${payments.length}`}
            </button>
          ) : null}
        </section>
      ) : null}

      {dialog?.kind === "procedure" ? (
        <RecordProcedureDialog
          timezone={timezone}
          treatments={treatments}
          priceItems={priceItems}
          doctors={doctors}
          canDeposit={canPay}
          patient={patient}
          onOpenChange={(v) => (!v ? setDialog(null) : undefined)}
          onDone={() => done("Procedure recorded")}
        />
      ) : null}
      {dialog?.kind === "payment" ? (
        <RecordPaymentDialog
          timezone={timezone}
          patient={patient}
          procedures={choices}
          defaults={{ procedureId: dialog.procedureId, amount: dialog.amount }}
          onOpenChange={(v) => (!v ? setDialog(null) : undefined)}
          onDone={() => done("Payment recorded")}
        />
      ) : null}
    </Card>
  );
}
