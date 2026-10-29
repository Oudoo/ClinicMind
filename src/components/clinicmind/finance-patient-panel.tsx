"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { formatDateInTz } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { RecordPaymentDialog } from "./payment-record-dialog";
import { RecordProcedureDialog } from "./procedure-record-dialog";
import { ProcedureCancelButton, ProcedureSignButton, ProcedureStageButton, ProcedureStartButton } from "./procedure-actions";
import { stageShare } from "@/modules/finance/charges";
import { PaymentVoidButton } from "./payment-void-button";
import { CreateInvoiceButton } from "./invoice-actions";
import { ProcedureCosts } from "./procedure-costs";
import {
  KIND_LABELS,
  KIND_TONE,
  METHOD_LABELS,
  PROCEDURE_STATUS_LABELS,
  STATUS_TONE,
  signedAmount,
  type DoctorOption,
  type InvoiceItem,
  type PaymentItem,
  type PriceOption,
  type ProcedureChoice,
  type ProcedureItem,
  type TreatmentOption,
} from "./finance-shared";

const SHOWN = 6;
const INVOICE_LABEL: Record<string, string> = { DRAFT: "Draft", ISSUED: "Issued", PART_PAID: "Part-paid", PAID: "Paid", CANCELLED: "Cancelled" };
const INVOICE_TONE: Record<string, "default" | "warning" | "accent" | "success" | "danger"> = { DRAFT: "default", ISSUED: "warning", PART_PAID: "accent", PAID: "success", CANCELLED: "danger" };

/**
 * The patient's procedures (treatment, date, doctor, price, status, balance)
 * and payments, with the actions each role may take: record a procedure,
 * start a course and cancel (patients:write), mark a session done or sign
 * (clinicians), record a payment (front desk, nurse, owner), void a payment
 * (owner).
 */
export function FinancePatientPanel({
  patient,
  timezone,
  procedures,
  payments,
  invoices = null,
  billable = null,
  credit = null,
  account = null,
  discountLimit = 100,
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
  /** The patient's invoices (null when the role may not see them). */
  invoices?: InvoiceItem[] | null;
  /** Charges on no invoice yet (for the roles that invoice). */
  billable?: { count: number; total: number } | null;
  /** Paid ahead, not yet put towards an invoice. */
  credit?: number | null;
  /** The account as the ledger has it (for the roles that see payments): what was billed, received, and the balance. */
  account?: { billed: number; received: number; balance: number } | null;
  /** The largest discount the user's role may give (a percentage of the price). */
  discountLimit?: number;
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
  const started = procedures.filter((p) => p.status === "STARTED");
  // From the ledger when the role sees payments; otherwise from the procedures: signed work, and the
  // sessions of courses under way charged so far.
  const billed = account ? account.billed : signed.reduce((s, p) => s + p.price - p.discount, 0) + started.reduce((s, p) => s + p.charged, 0);
  const owing = account ? account.balance : [...signed, ...started].reduce((s, p) => s + Math.max(0, p.balance), 0);
  const paid = account ? account.received : payments ? payments.reduce((s, p) => s + signedAmount(p), 0) : null;
  const date = (iso: string) => formatDateInTz(new Date(iso), timezone);
  const choices: ProcedureChoice[] = procedures
    .filter((p) => p.status !== "CANCELLED")
    .map((p) => ({
      id: p.id,
      balance: p.balance,
      label: `${p.treatmentName} · ${date(p.performedAt)}${p.status === "PLANNED" ? " · planned" : p.balance > 0 ? ` · owes ${formatNumber(p.balance)} EGP` : p.status === "STARTED" ? " · paid ahead" : " · paid"}`,
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
        action={
          owing > 0 ? (
            <Badge tone="warning">owes {formatNumber(owing)} EGP</Badge>
          ) : owing < 0 ? (
            <Badge tone="accent">in credit {formatNumber(-owing)} EGP</Badge>
          ) : signed.length ? (
            <Badge tone="success">settled</Badge>
          ) : null
        }
      />
      <dl className="grid grid-cols-3 gap-2 rounded-lg bg-muted/60 p-3 text-center">
        <div>
          <dt className="data-label">Billed</dt>
          <dd className="font-mono text-sm tabular-nums">{formatNumber(billed)}</dd>
        </div>
        <div>
          <dt className="data-label" title="Everything received for this patient, consultation fees and deposits included, net of refunds (and what family paid for them)">Received</dt>
          <dd className="font-mono text-sm tabular-nums">{paid === null ? "—" : formatNumber(paid)}</dd>
        </div>
        <div>
          <dt className="data-label">Balance</dt>
          <dd className={owing > 0 ? "font-mono text-sm tabular-nums text-warning" : owing < 0 ? "font-mono text-sm tabular-nums text-accent" : "font-mono text-sm tabular-nums"}>{formatNumber(owing)}</dd>
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
          {canPay && billable && billable.count > 0 ? <CreateInvoiceButton patientId={patient.id} count={billable.count} total={billable.total} /> : null}
        </div>
      ) : null}
      {credit && credit > 0 ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{formatNumber(credit)} EGP paid ahead</span>: held as credit, it goes towards the next invoice.
        </p>
      ) : null}

      <section aria-label="Procedures" className="space-y-2">
        <h3 className="data-label">Procedures</h3>
        {procedures.length ? (
          <ul className="space-y-2">
            {shownProcedures.map((p) => {
              const label = p.undated ? `${p.treatmentName} (accepted ${date(p.performedAt)})` : `${p.treatmentName} on ${date(p.performedAt)}`;
              const net = p.price - p.discount;
              return (
                <li key={p.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{p.treatmentName}</span>
                        <Badge tone={STATUS_TONE[p.status]}>{PROCEDURE_STATUS_LABELS[p.status]}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {p.undated ? (
                          <span>
                            Accepted <span className="font-mono">{date(p.performedAt)}</span>
                            {p.quoteNumber ? <span className="font-mono"> · {p.quoteNumber}</span> : null} · no day yet
                          </span>
                        ) : (
                          <span className="font-mono">{date(p.performedAt)}</span>
                        )}
                        {p.doctorName ? ` · ${p.doctorName}` : ""}
                      </p>
                      {p.stages > 1 && (p.status === "PLANNED" || p.status === "STARTED") ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {p.status === "PLANNED"
                            ? `${p.stages} sessions, each charged as it is done`
                            : p.stagesDone
                              ? `${p.stagesDone} of ${p.stages} sessions done · ${formatNumber(p.charged)} of ${formatNumber(net)} EGP charged`
                              : `Started ${p.startedAt ? date(p.startedAt) : ""} · no session done yet`}
                        </p>
                      ) : null}
                      {p.zeroChargeReason ? <p className="mt-0.5 text-xs text-muted-foreground">No charge: {p.zeroChargeReason}</p> : null}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm tabular-nums">{formatNumber(net)} EGP</div>
                      {p.discount ? <div className="font-mono text-[11px] text-muted-foreground">−{formatNumber(p.discount)} discount</div> : null}
                    </div>
                  </div>
                  {p.status !== "CANCELLED" ? (
                    <p className="mt-1 text-xs">
                      {p.status === "STARTED" ? (
                        p.balance > 0 ? (
                          <span className="text-warning">Due {formatNumber(p.balance)} EGP for the sessions done</span>
                        ) : p.balance < 0 ? (
                          <span className="text-muted-foreground">Paid ahead by {formatNumber(-p.balance)} EGP</span>
                        ) : (
                          <span className="text-success">Paid up to date</span>
                        )
                      ) : p.balance > 0 ? (
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
                  {p.costs ? (
                    <ProcedureCosts procedureId={p.id} label={label} materials={p.materials ?? 0} costs={p.costs} timezone={timezone} canAdd={canPay && p.status !== "CANCELLED"} canVoid={canVoid} />
                  ) : null}
                  {p.status !== "CANCELLED" && (canSign || canRecordProcedure || canPay) ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {p.status === "PLANNED" && p.stages > 1 && canRecordProcedure ? <ProcedureStartButton procedureId={p.id} label={label} stages={p.stages} timezone={timezone} /> : null}
                      {p.status === "PLANNED" && p.stages === 1 && canSign ? <ProcedureSignButton procedureId={p.id} label={label} /> : null}
                      {p.status === "STARTED" && canSign ? (
                        <>
                          <ProcedureStageButton
                            procedureId={p.id}
                            label={label}
                            nextStage={p.stagesDone + 1}
                            stages={p.stages}
                            share={stageShare(net, p.stages, p.stagesDone + 1)}
                            timezone={timezone}
                          />
                          {p.stages - p.stagesDone > 1 ? <ProcedureSignButton procedureId={p.id} label={label} left={{ sessions: p.stages - p.stagesDone, amount: net - p.charged }} /> : null}
                        </>
                      ) : null}
                      {canPay && p.balance > 0 ? (
                        <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "payment", procedureId: p.id, amount: p.balance })}>
                          Pay balance
                        </Button>
                      ) : null}
                      {(p.status === "PLANNED" || p.status === "STARTED") && canRecordProcedure ? <ProcedureCancelButton procedureId={p.id} label={label} /> : null}
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

      {invoices && invoices.length ? (
        <section aria-label="Invoices" className="space-y-2">
          <h3 className="data-label">Invoices</h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <Link href={`/dashboard/finance/invoices/${inv.id}`} className="font-mono text-xs font-medium underline-offset-2 hover:underline">
                    {inv.number ?? "Draft"}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {date(inv.date)}
                    {inv.status === "PART_PAID" ? ` · ${formatNumber(inv.paid)} of ${formatNumber(inv.total)} paid` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-sm tabular-nums">{formatNumber(inv.total)}</span>
                  <Badge tone={inv.status === "PAID" && inv.writtenOff ? "default" : (INVOICE_TONE[inv.status] ?? "default")}>
                    {inv.status === "PAID" && inv.writtenOff ? "Written off" : (INVOICE_LABEL[inv.status] ?? inv.status)}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
                        {p.receiptNumber ? <span className="whitespace-nowrap font-mono">· {p.receiptNumber}</span> : null}
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
          discountLimit={discountLimit}
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
          canRefund={canVoid}
          onOpenChange={(v) => (!v ? setDialog(null) : undefined)}
          onDone={() => done("Payment recorded")}
        />
      ) : null}
    </Card>
  );
}
