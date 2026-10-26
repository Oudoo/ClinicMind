import type { Prisma } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { formatDateInTz } from "@/lib/time";
import { toCsv } from "@/modules/reporting/csv";
import { periodBuckets, type ResolvedPeriod } from "@/modules/reporting/period";
import { KIND_LABELS, METHOD_LABELS, PAYMENT_METHODS, PROCEDURE_STATUS_LABELS, procedureBalance, type PaymentMethodValue } from "./constants";
import { listPayments, type PaymentListQuery } from "./payments";

/**
 * The finance dashboard: revenue (signed procedures by performedAt), money in
 * and out (payments by paidAt), outstanding balances, and the breakdowns by
 * doctor, treatment, day and method. Every figure carries the same figure for
 * the comparison period.
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
  amount: number;
  procedures: number;
  oldestAt: Date;
  oldestTreatment: string;
}

export interface FinanceSummary {
  revenue: MoneyPair;
  procedures: MoneyPair;
  collected: MoneyPair;
  deposits: MoneyPair;
  refunds: MoneyPair;
  consultationFees: MoneyPair;
  outstanding: { amount: number; patients: number; procedures: number };
  byDoctor: NamedAmount[];
  byTreatment: NamedAmount[];
  collectedPerBucket: { label: string; value: number; compare: number | undefined }[];
  bucketStep: "day" | "week";
  methodMix: { method: PaymentMethodValue; label: string; amount: number; count: number }[];
  outstandingPatients: OutstandingPatient[];
}

const moneyIn = (kind: string) => kind === "PAYMENT" || kind === "CONSULTATION_FEE";

export async function getFinanceSummary(tenantId: string, period: ResolvedPeriod, timeZone: string): Promise<FinanceSummary> {
  const span = { gte: period.previous.from, lt: period.to };
  const [procedures, payments, signedAll] = await Promise.all([
    db.procedure.findMany({
      where: { tenantId, ...notDeleted, status: "SIGNED", performedAt: span },
      select: { id: true, doctorId: true, performedAt: true, price: true, discount: true, treatment: { select: { key: true, name: true } } },
      take: 20_000,
    }),
    db.payment.findMany({
      where: { tenantId, ...notDeleted, paidAt: span },
      select: { kind: true, method: true, amount: true, paidAt: true },
      take: 50_000,
    }),
    db.procedure.findMany({
      where: { tenantId, ...notDeleted, status: "SIGNED" },
      select: {
        id: true,
        patientId: true,
        performedAt: true,
        price: true,
        discount: true,
        patient: { select: { fullName: true } },
        treatment: { select: { name: true } },
        payments: { where: { deletedAt: null }, select: { kind: true, amount: true } },
      },
      orderBy: { performedAt: "asc" },
      take: 20_000,
    }),
  ]);

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
  const procRows = procedures.map((p) => ({ ...p, at: p.performedAt, net: p.price - p.discount }));
  const payRows = payments.map((p) => ({ ...p, at: p.paidAt }));

  const revenue = pair(procRows, (p) => p.net);
  const count = pair(procRows, () => 1);
  const collected = pair(payRows, (p) => (moneyIn(p.kind) ? p.amount : p.kind === "REFUND" ? -p.amount : 0));
  const deposits = pair(payRows, (p) => (p.kind === "DEPOSIT" ? p.amount : 0));
  const refunds = pair(payRows, (p) => (p.kind === "REFUND" ? p.amount : 0));
  const consultationFees = pair(payRows, (p) => (p.kind === "CONSULTATION_FEE" ? p.amount : 0));

  // Doctor names in one tenant-scoped lookup.
  const doctorIds = [...new Set(procRows.map((p) => p.doctorId).filter((id): id is string => Boolean(id)))];
  const users = doctorIds.length
    ? await db.user.findMany({ where: { tenantId, id: { in: doctorIds } }, select: { id: true, fullName: true, email: true } })
    : [];
  const doctorName = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));

  const byDoctorMap = new Map<string, NamedAmount>();
  const byTreatmentMap = new Map<string, NamedAmount>();
  for (const p of procRows) {
    if (!inCurrent(p.at)) continue;
    const dId = p.doctorId ?? "none";
    const d = byDoctorMap.get(dId) ?? { id: dId, label: p.doctorId ? (doctorName.get(p.doctorId) ?? "Unknown doctor") : "No doctor", amount: 0, count: 0 };
    d.amount += p.net;
    d.count += 1;
    byDoctorMap.set(dId, d);
    const t = byTreatmentMap.get(p.treatment.key) ?? { id: p.treatment.key, label: p.treatment.name, amount: 0, count: 0 };
    t.amount += p.net;
    t.count += 1;
    byTreatmentMap.set(p.treatment.key, t);
  }
  const byAmount = (a: NamedAmount, b: NamedAmount) => b.amount - a.amount;

  // Collected per day (or week) against the previous period, aligned by bucket index.
  const buckets = periodBuckets(period, timeZone);
  const prevBuckets = periodBuckets(period.previous, timeZone);
  const sumIn = (b: { start: Date; end: Date }) =>
    payRows.reduce((s, p) => (p.at >= b.start && p.at < b.end ? s + (moneyIn(p.kind) ? p.amount : p.kind === "REFUND" ? -p.amount : 0) : s), 0);
  const collectedPerBucket = buckets.map((b, i) => ({ label: b.label, value: sumIn(b), compare: prevBuckets[i] ? sumIn(prevBuckets[i]!) : undefined }));

  const methodMix = PAYMENT_METHODS.map((method) => {
    const rows = payRows.filter((p) => inCurrent(p.at) && p.method === method && (moneyIn(p.kind) || p.kind === "DEPOSIT"));
    return { method, label: METHOD_LABELS[method], amount: rows.reduce((s, p) => s + p.amount, 0), count: rows.length };
  }).filter((m) => m.count > 0);

  // Outstanding balances of signed procedures (all time), grouped by patient.
  const owing = new Map<string, OutstandingPatient>();
  let outstandingAmount = 0;
  let outstandingProcedures = 0;
  for (const p of signedAll) {
    const balance = procedureBalance(p.price, p.discount, p.payments);
    if (balance <= 0) continue;
    outstandingAmount += balance;
    outstandingProcedures += 1;
    const row = owing.get(p.patientId) ?? { patientId: p.patientId, fullName: p.patient.fullName, amount: 0, procedures: 0, oldestAt: p.performedAt, oldestTreatment: p.treatment.name };
    row.amount += balance;
    row.procedures += 1;
    if (p.performedAt < row.oldestAt) {
      row.oldestAt = p.performedAt;
      row.oldestTreatment = p.treatment.name;
    }
    owing.set(p.patientId, row);
  }

  return {
    revenue,
    procedures: count,
    collected,
    deposits,
    refunds,
    consultationFees,
    outstanding: { amount: outstandingAmount, patients: owing.size, procedures: outstandingProcedures },
    byDoctor: [...byDoctorMap.values()].sort(byAmount),
    byTreatment: [...byTreatmentMap.values()].sort(byAmount),
    collectedPerBucket,
    bucketStep: period.days <= 31 ? "day" : "week",
    methodMix,
    outstandingPatients: [...owing.values()].sort((a, b) => b.amount - a.amount).slice(0, 25),
  };
}

/** Patients owing on signed procedures, with the procedures themselves (for the drill-down). */
export async function getPatientOutstanding(tenantId: string, patientId: string) {
  const rows = await db.procedure.findMany({
    where: { tenantId, ...notDeleted, status: "SIGNED", patientId },
    select: { id: true, performedAt: true, price: true, discount: true, treatment: { select: { name: true } }, payments: { where: { deletedAt: null }, select: { kind: true, amount: true } } },
    orderBy: { performedAt: "asc" },
  });
  return rows
    .map((p) => ({ id: p.id, performedAt: p.performedAt, treatment: p.treatment.name, net: p.price - p.discount, balance: procedureBalance(p.price, p.discount, p.payments) }))
    .filter((p) => p.balance > 0);
}

export type ExportKind = "payments" | "procedures";

/** CSV of the period's payments or procedures. */
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
  const where: Prisma.ProcedureWhereInput = { tenantId, ...notDeleted, performedAt: { gte: period.from, lt: period.to } };
  const rows = await db.procedure.findMany({
    where,
    orderBy: { performedAt: "asc" },
    take: 20_000,
    select: {
      id: true,
      doctorId: true,
      performedAt: true,
      price: true,
      discount: true,
      status: true,
      patient: { select: { fullName: true } },
      treatment: { select: { name: true } },
      payments: { where: { deletedAt: null }, select: { kind: true, amount: true } },
    },
  });
  const doctorIds = [...new Set(rows.map((r) => r.doctorId).filter((id): id is string => Boolean(id)))];
  const users = doctorIds.length ? await db.user.findMany({ where: { tenantId, id: { in: doctorIds } }, select: { id: true, fullName: true, email: true } }) : [];
  const doctorName = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
  return {
    filename: name,
    csv: toCsv(
      ["Date", "Patient", "Treatment", "Doctor", "Status", "Price (EGP)", "Discount (EGP)", "Net (EGP)", "Paid (EGP)", "Balance (EGP)"],
      rows.map((p) => {
        const paid = p.payments.reduce((s, x) => s + (x.kind === "REFUND" ? -x.amount : x.amount), 0);
        return [
          formatDateInTz(p.performedAt, timeZone),
          p.patient.fullName,
          p.treatment.name,
          p.doctorId ? (doctorName.get(p.doctorId) ?? "") : "",
          PROCEDURE_STATUS_LABELS[p.status],
          p.price,
          p.discount,
          p.price - p.discount,
          paid,
          p.status === "SIGNED" ? procedureBalance(p.price, p.discount, p.payments) : 0,
        ];
      }),
    ),
  };
}
