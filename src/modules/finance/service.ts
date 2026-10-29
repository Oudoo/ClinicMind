import { db, notDeleted } from "@/lib/db";
import { formatDateInTz } from "@/lib/time";
import { toCsv } from "@/modules/reporting/csv";
import { periodBuckets, type ResolvedPeriod } from "@/modules/reporting/period";
import { KIND_LABELS, METHOD_LABELS, PAYMENT_METHODS, type PaymentMethodValue } from "./constants";
import { accountPosition, patientBalances, type AccountPosition } from "./ledger";
import { listPayments, type PaymentListQuery } from "./payments";
import { balancesReport, financeReportCsv, previousOf, productionReport, providersReport, scopeForPeriod } from "./reports";
import { payerMoneyIn, payersOwed } from "@/modules/insurance/money";

/**
 * The finance dashboard: production (the work charged, after discounts and
 * cancellations, and consultation fees: the reports' net production), money
 * in and out (payments by paidAt; "collected" is everything received,
 * deposits and insurers' and companies' payments included, net of refunds),
 * what patients owe (their accounts' balances, as the ledger keeps them) and
 * what insurers and companies owe, and the breakdowns by doctor, treatment,
 * day and method. Every figure carries the same figure for the comparison
 * period.
 */

export interface MoneyPair {
  current: number;
  previous: number;
}

export interface NamedAmount {
  id: string;
  label: string;
  amount: number;
  count: number;
}

export interface OutstandingPatient {
  patientId: string;
  fullName: string;
  /** Owed now: due on invoices, and work not invoiced yet, less any credit. */
  amount: number;
  dueOnInvoices: number;
  notInvoiced: number;
  /** When the oldest invoice with something due was issued. */
  oldestDueAt: Date | null;
}

export interface FinanceSummary {
  /** Net production (see reports.ts). */
  revenue: MoneyPair;
  /** Procedures and sessions charged. */
  procedures: MoneyPair;
  collected: MoneyPair;
  deposits: MoneyPair;
  refunds: MoneyPair;
  consultationFees: MoneyPair;
  /** Paid by insurers and companies towards their claims (in `collected` too). */
  fromPayers: MoneyPair;
  /** Owed now on patients' accounts; `previousAmount` is what was owed when the comparison period ended. */
  outstanding: { amount: number; patients: number; previousAmount: number };
  /** Owed now by insurers and companies on their claims. */
  owedByPayers: number;
  byDoctor: NamedAmount[];
  byTreatment: NamedAmount[];
  collectedPerBucket: { label: string; value: number; compare: number | undefined }[];
  bucketStep: "day" | "week";
  methodMix: { method: PaymentMethodValue; label: string; amount: number; count: number }[];
  outstandingPatients: OutstandingPatient[];
}

/** Money received: payments, deposits and consultation fees. Refunds are money out. */
const moneyIn = (kind: string) => kind === "PAYMENT" || kind === "DEPOSIT" || kind === "CONSULTATION_FEE";
/** Net cash of one payment: + money in, − refunds. */
const netCash = (p: { kind: string; amount: number }) => (moneyIn(p.kind) ? p.amount : p.kind === "REFUND" ? -p.amount : 0);

export async function getFinanceSummary(tenantId: string, period: ResolvedPeriod, timeZone: string): Promise<FinanceSummary> {
  const scope = await scopeForPeriod(tenantId, period, timeZone);
  const previousScope = { ...scope, period: previousOf(period, timeZone) };
  const [production, previousProduction, providers, balances, payments, payerMoney, owedByPayers] = await Promise.all([
    productionReport(scope),
    productionReport(previousScope),
    providersReport(scope),
    balancesReport(scope),
    db.payment.findMany({
      where: { tenantId, ...notDeleted, paidAt: { gte: period.previous.from, lt: period.to } },
      select: { kind: true, method: true, amount: true, paidAt: true },
      take: 50_000,
    }),
    payerMoneyIn(db, tenantId, { gte: period.previous.from, lt: period.to }),
    payersOwed(db, tenantId),
  ]);
  const owing = balances.rows.filter((r) => r.balance > 0);
  // What was owed when the comparison period ended: every account as it stood then.
  const then = await patientBalances(db, tenantId, await patientsWithAccounts(tenantId), period.from);
  const previousAmount = [...then.values()].reduce((s, b) => s + Math.max(0, b), 0);

  const inCurrent = (d: Date) => d >= period.from && d < period.to;
  const pair = <T extends { at: Date }>(rows: T[], value: (r: T) => number): MoneyPair => {
    let current = 0;
    let previous = 0;
    for (const r of rows) {
      if (inCurrent(r.at)) current += value(r);
      else previous += value(r);
    }
    return { current, previous };
  };
  // The insurers' and companies' money as payments too: it is money in.
  const payRows = [...payments.map((p) => ({ ...p, at: p.paidAt })), ...payerMoney.map((m) => ({ kind: "PAYMENT" as const, method: m.method, amount: m.amount, paidAt: m.at, at: m.at, payer: true }))];
  // Collected: everything received in the period (deposits included) net of refunds.
  const collected = pair(payRows, netCash);
  const deposits = pair(payRows, (p) => (p.kind === "DEPOSIT" ? p.amount : 0));
  const refunds = pair(payRows, (p) => (p.kind === "REFUND" ? p.amount : 0));
  const consultationFees = pair(payRows, (p) => (p.kind === "CONSULTATION_FEE" ? p.amount : 0));
  const fromPayers = pair(payRows, (p) => ("payer" in p ? p.amount : 0));

  // Collected per day (or week) against the previous period, aligned by bucket index.
  const buckets = periodBuckets(period, timeZone);
  const prevBuckets = periodBuckets(period.previous, timeZone);
  const sumIn = (b: { start: Date; end: Date }) => payRows.reduce((s, p) => (p.at >= b.start && p.at < b.end ? s + netCash(p) : s), 0);
  const collectedPerBucket = buckets.map((b, i) => ({ label: b.label, value: sumIn(b), compare: prevBuckets[i] ? sumIn(prevBuckets[i]!) : undefined }));

  const methodMix = PAYMENT_METHODS.map((method) => {
    const rows = payRows.filter((p) => inCurrent(p.at) && p.method === method && moneyIn(p.kind));
    return { method, label: METHOD_LABELS[method], amount: rows.reduce((s, p) => s + p.amount, 0), count: rows.length };
  }).filter((m) => m.count > 0);

  const byAmount = (a: NamedAmount, b: NamedAmount) => b.amount - a.amount;
  return {
    revenue: { current: production.totals.net, previous: previousProduction.totals.net },
    procedures: { current: production.totals.procedures, previous: previousProduction.totals.procedures },
    collected,
    deposits,
    refunds,
    consultationFees,
    fromPayers,
    outstanding: { amount: balances.totals.owed, patients: balances.totals.owing, previousAmount },
    owedByPayers,
    byDoctor: providers.rows.filter((r) => r.net !== 0 || r.procedures).map((r) => ({ id: r.doctorId ?? "none", label: r.name, amount: r.net, count: r.procedures })).sort(byAmount),
    byTreatment: production.byTreatment.map((t) => ({ id: t.name, label: t.name, amount: t.net, count: t.procedures })).sort(byAmount),
    collectedPerBucket,
    bucketStep: period.days <= 31 ? "day" : "week",
    methodMix,
    outstandingPatients: owing.slice(0, 25).map((r) => ({
      patientId: r.patientId,
      fullName: r.patientName,
      amount: r.balance,
      dueOnInvoices: r.dueOnInvoices,
      notInvoiced: r.notInvoiced,
      oldestDueAt: r.oldestDueAt ? new Date(r.oldestDueAt) : null,
    })),
  };
}

/** Every patient with anything on their account (a charge or money), owing or not. */
async function patientsWithAccounts(tenantId: string): Promise<string[]> {
  const [charged, paid] = await Promise.all([
    db.charge.groupBy({ by: ["patientId"], where: { tenantId } }),
    db.payment.groupBy({ by: ["patientId"], where: { tenantId, deletedAt: null } }),
  ]);
  return [...new Set([...charged.map((r) => r.patientId), ...paid.map((r) => r.patientId)])];
}

/** Where one patient's account stands (the drill-down): due on invoices, not invoiced, credit, the open invoices. */
export async function getPatientOwing(tenantId: string, patient: { id: string; fullName: string }): Promise<AccountPosition> {
  return db.$transaction((tx) => accountPosition(tx, tenantId, [patient]));
}

export type ExportKind = "payments" | "procedures";

/** CSV of the period's payments, or its procedures (as the procedures tracking report has them). */
export async function exportFinanceCsv(tenantId: string, kind: ExportKind, period: ResolvedPeriod, timeZone: string): Promise<{ filename: string; csv: string }> {
  const name = `${kind}-${period.fromKey}-to-${period.toKey}.csv`;
  if (kind === "payments") {
    const query = (page: number): PaymentListQuery => ({ from: period.from, to: period.to, includeVoided: false, page, pageSize: 100 });
    const { payments } = await listPayments(tenantId, query(1));
    // listPayments is paged; the export walks every page.
    const all = [...payments];
    let page = 2;
    while (all.length < 20_000) {
      const next = await listPayments(tenantId, query(page));
      if (!next.payments.length) break;
      all.push(...next.payments);
      page += 1;
    }
    return {
      filename: name,
      csv: toCsv(
        ["Date", "Time", "Patient", "Kind", "Method", "Amount (EGP)", "Reference", "Procedure", "Note", "Import batch"],
        all.map((p) => [
          formatDateInTz(p.paidAt, timeZone),
          formatDateInTz(p.paidAt, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
          p.patient.fullName,
          KIND_LABELS[p.kind],
          METHOD_LABELS[p.method],
          p.kind === "REFUND" ? -p.amount : p.amount,
          p.reference,
          p.procedure?.treatment.name ?? null,
          p.note,
          p.importBatchId,
        ]),
      ),
    };
  }
  // Procedures: the procedures tracking report (charged, invoiced and not invoiced for each).
  const { csv } = await financeReportCsv(await scopeForPeriod(tenantId, period, timeZone), "procedures");
  return { filename: name, csv };
}
