import { db } from "@/lib/db";
import { dateKeyInTz, formatDateInTz, fromDateKey, startOfDayInTz } from "@/lib/time";
import { AGE_BUCKETS } from "@/modules/insurance/constants";
import { owedByPayer } from "@/modules/insurance/payers";
import { emptyAcceptance, tallyQuote } from "@/modules/quotes/acceptance";
import type { AcceptanceRow } from "@/modules/quotes/dto";
import { prorateCost } from "@/modules/reporting/metrics";
import { LEAD_SOURCES, SOURCE_LABELS, type LeadSourceValue } from "@/modules/reporting/query";
import { claimedOn, claimsSettling, OPEN_INVOICE_STATUSES } from "./allocations";
import { payDoctors, statementFor } from "./doctor-pay";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, type ExpenseCategoryValue } from "./expense-constants";
import { coverInstalments, type InstalmentState } from "./instalment-schedule";
import { toCsv, type CsvCell } from "@/modules/reporting/csv";
import { balancesReport, incomeReport, productionReport, type MonthlyReportKey, type ReportScope } from "./reports";

/**
 * The owner's month-by-month reports, beside Dentalore's daily set: profit
 * and loss, what the clinic is owed by age, how much of what it invoices it
 * collects, case acceptance, the instalments falling due, and the work and
 * the money each marketing source brings. Months are on the clinic clock;
 * the window is the last 3, 6 or 12 months, this one to today (see
 * `reportScope`). The figures are counted as the daily reports count them:
 *
 *   production = the work done (charges) and consultation fees, net of
 *                discounts and cancelled work, on the day it was done
 *   revenue    = production − what was written off as never to be paid
 *   profit     = revenue − expenses (by the day they were billed)
 *                − the doctors' pay (as their statements have it)
 *   money in   = patients' payments, deposits and fees − refunds
 *                + what insurers and companies paid
 *   money out  = expenses paid + doctors' statements paid
 */

const DAY = 86_400_000;

export interface ReportMonth {
  /** YYYY-MM on the clinic clock. */
  month: string;
  label: string;
  /** The month's first instant (or the window's), and the next month's (or the window's end). */
  from: Date;
  to: Date;
}

export function shiftMonth(key: string, by: number): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const n = y * 12 + (m - 1) + by;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, "0")}`;
}

export const monthName = (key: string) => formatDateInTz(new Date(`${key}-15T12:00:00Z`), "UTC", { month: "short", year: "numeric" });

/** The months a window covers, oldest first. */
export function monthsOf(scope: ReportScope): ReportMonth[] {
  const out: ReportMonth[] = [];
  const last = scope.period.toKey.slice(0, 7);
  for (let key = scope.period.fromKey.slice(0, 7); key <= last; key = shiftMonth(key, 1)) {
    const start = fromDateKey(`${key}-01`, scope.timezone)!;
    const next = fromDateKey(`${shiftMonth(key, 1)}-01`, scope.timezone)!;
    out.push({ month: key, label: monthName(key), from: start < scope.period.from ? scope.period.from : start, to: next > scope.period.to ? scope.period.to : next });
  }
  return out;
}

const monthOf = (scope: ReportScope, at: Date) => dateKeyInTz(at, scope.timezone).slice(0, 7);
const branchOf = (scope: ReportScope, clinicId: string | null) => clinicId ?? scope.defaultClinicId;
const inBranch = (scope: ReportScope, clinicId: string | null) => !scope.clinicId || branchOf(scope, clinicId) === scope.clinicId;
const span = (scope: ReportScope) => ({ gte: scope.period.from, lt: scope.period.to });
const dateOnly = (key: string) => new Date(`${key}T00:00:00.000Z`);
const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// ── Profit and loss ──────────────────────────────────────────────────────────

export interface PnlFigures {
  /** The work done: charges and consultation fees, net of discounts and cancelled work. */
  production: number;
  /** Written off as never to be paid (by patients, or refused by a payer). */
  writtenOff: number;
  revenue: number;
  /** The clinic's expenses, by the day each was billed. */
  expenses: number;
  byCategory: Partial<Record<ExpenseCategoryValue, number>>;
  /** What the doctors earned on their statements. */
  doctorPay: number;
  profit: number;
  /** Profit as a share of revenue (%), null without revenue. */
  margin: number | null;
  /** The cash side: what came in (patients and payers, less refunds) and went out (expenses and doctors paid). */
  moneyIn: number;
  moneyOut: number;
}

export interface PnlMonth extends PnlFigures {
  month: string;
  label: string;
  /** A doctor's statement for the month is not closed yet: their pay is worked out as it stands. */
  doctorPayOpen: boolean;
}

export interface ProfitAndLossReport {
  months: PnlMonth[];
  totals: PnlFigures;
  /** The expense categories with money in the window, in the usual order. */
  categories: { key: ExpenseCategoryValue; label: string }[];
}

const zeroPnl = (): PnlFigures => ({ production: 0, writtenOff: 0, revenue: 0, expenses: 0, byCategory: {}, doctorPay: 0, profit: 0, margin: null, moneyIn: 0, moneyOut: 0 });

/**
 * The doctors' pay of each month, as their statements have it (worked out as
 * it stands while a month is open; a month a later statement paid for is in
 * that later month), and what was paid to them when. At one branch: the
 * share of each statement's work done there.
 */
async function doctorPayByMonth(scope: ReportScope, months: ReportMonth[], now: Date): Promise<{ earned: Map<string, { amount: number; open: boolean }>; paid: Map<string, number> }> {
  const t = scope.tenantId;
  const keys = months.map((m) => m.month);
  const stored = await db.doctorStatement.findMany({
    where: { tenantId: t, OR: [{ month: { in: keys } }, { paidAt: span(scope) }] },
    select: { doctorId: true, month: true, earned: true, payable: true, paidAt: true, lines: { select: { procedureId: true, feeId: true, due: true } } },
  });
  type Lines = { procedureId: string | null; feeId: string | null; due: number }[];
  const statements: { month: string; earned: number; payable: number; paidAt: Date | null; open: boolean; lines: Lines }[] = stored.map((s) => ({ ...s, open: false }));
  // Months not closed yet: worked out as they stand (a month a later statement covers comes to nothing).
  const closed = new Set(stored.map((s) => `${s.doctorId}|${s.month}`));
  const nowMonth = monthOf(scope, now);
  for (const d of (await payDoctors(t)).filter((x) => x.payFrom)) {
    for (const month of keys) {
      if (month < d.payFrom! || month > nowMonth || closed.has(`${d.id}|${month}`)) continue;
      const s = await statementFor(t, d.id, month, now);
      if (s.status !== "OPEN") continue;
      statements.push({ month, earned: s.earned, payable: s.payable, paidAt: null, open: true, lines: s.lines });
    }
  }
  // Each line's branch: its procedure's charges, or its consultation fee's payment.
  let shareOf = (_lines: Lines, whole: number) => whole;
  if (scope.clinicId) {
    const procedureIds = [...new Set(statements.flatMap((s) => s.lines.map((l) => l.procedureId)).filter((id): id is string => Boolean(id)))];
    const feeIds = [...new Set(statements.flatMap((s) => s.lines.map((l) => l.feeId)).filter((id): id is string => Boolean(id)))];
    const [charges, fees] = await Promise.all([
      procedureIds.length ? db.charge.findMany({ where: { tenantId: t, procedureId: { in: procedureIds } }, distinct: ["procedureId"], select: { procedureId: true, clinicId: true } }) : [],
      feeIds.length ? db.payment.findMany({ where: { tenantId: t, id: { in: feeIds } }, select: { id: true, clinicId: true } }) : [],
    ]);
    const clinicOf = new Map<string, string | null>([...charges.map((c) => [`p:${c.procedureId}`, c.clinicId] as const), ...fees.map((f) => [`f:${f.id}`, f.clinicId] as const)]);
    const here = (l: Lines[number]) => inBranch(scope, clinicOf.get(l.procedureId ? `p:${l.procedureId}` : `f:${l.feeId}`) ?? null);
    shareOf = (lines, whole) => {
      const due = lines.reduce((s, l) => s + l.due, 0);
      if (!due) return scope.clinicId === scope.defaultClinicId ? whole : 0;
      return Math.round((whole * lines.filter(here).reduce((s, l) => s + l.due, 0)) / due);
    };
  }
  const earned = new Map<string, { amount: number; open: boolean }>();
  const paid = new Map<string, number>();
  for (const s of statements) {
    if (keys.includes(s.month)) {
      const e = earned.get(s.month) ?? { amount: 0, open: false };
      e.amount += shareOf(s.lines, s.earned);
      e.open ||= s.open;
      earned.set(s.month, e);
    }
    if (s.paidAt && s.paidAt >= scope.period.from && s.paidAt < scope.period.to) {
      const m = monthOf(scope, s.paidAt);
      paid.set(m, (paid.get(m) ?? 0) + shareOf(s.lines, s.payable));
    }
  }
  return { earned, paid };
}

export async function profitAndLossReport(scope: ReportScope, now: Date = new Date()): Promise<ProfitAndLossReport> {
  const t = scope.tenantId;
  const months = monthsOf(scope);
  const rows = new Map(months.map((m) => [m.month, { month: m.month, label: m.label, doctorPayOpen: false, ...zeroPnl() }]));
  const atBranch = scope.clinicId ? { clinicId: scope.clinicId } : {};
  const [production, income, writeOffs, expenses, expensePayments, pay] = await Promise.all([
    productionReport(scope),
    incomeReport(scope),
    db.writeOff.findMany({ where: { tenantId: t, voidedAt: null, writtenOffAt: span(scope) }, select: { amount: true, writtenOffAt: true, invoice: { select: { clinicId: true } } } }),
    db.expense.findMany({
      where: { tenantId: t, voidedAt: null, billedOn: { gte: dateOnly(scope.period.fromKey), lte: dateOnly(scope.period.toKey) }, ...atBranch },
      select: { category: true, amount: true, billedOn: true },
    }),
    db.expensePayment.findMany({ where: { tenantId: t, voidedAt: null, paidAt: span(scope), ...atBranch }, select: { amount: true, paidAt: true } }),
    doctorPayByMonth(scope, months, now),
  ]);
  for (const d of production.days) {
    const r = rows.get(d.date.slice(0, 7));
    if (r) r.production += d.net;
  }
  for (const d of income.days) {
    const r = rows.get(d.date.slice(0, 7));
    if (r) r.moneyIn += d.net;
  }
  for (const w of writeOffs) {
    const r = inBranch(scope, w.invoice.clinicId) ? rows.get(monthOf(scope, w.writtenOffAt)) : undefined;
    if (r) r.writtenOff += w.amount;
  }
  for (const e of expenses) {
    const r = rows.get(e.billedOn.toISOString().slice(0, 7));
    if (!r) continue;
    r.expenses += e.amount;
    r.byCategory[e.category] = (r.byCategory[e.category] ?? 0) + e.amount;
  }
  for (const p of expensePayments) {
    const r = rows.get(monthOf(scope, p.paidAt));
    if (r) r.moneyOut += p.amount;
  }
  for (const [month, e] of pay.earned) {
    const r = rows.get(month);
    if (!r) continue;
    r.doctorPay += e.amount;
    r.doctorPayOpen ||= e.open;
  }
  for (const [month, amount] of pay.paid) {
    const r = rows.get(month);
    if (r) r.moneyOut += amount;
  }
  const totals = zeroPnl();
  for (const r of rows.values()) {
    r.revenue = r.production - r.writtenOff;
    r.profit = r.revenue - r.expenses - r.doctorPay;
    r.margin = r.revenue > 0 ? rate(r.profit, r.revenue) : null;
    for (const k of ["production", "writtenOff", "revenue", "expenses", "doctorPay", "profit", "moneyIn", "moneyOut"] as const) totals[k] += r[k];
    for (const [c, v] of Object.entries(r.byCategory) as [ExpenseCategoryValue, number][]) totals.byCategory[c] = (totals.byCategory[c] ?? 0) + v;
  }
  totals.margin = totals.revenue > 0 ? rate(totals.profit, totals.revenue) : null;
  return { months: [...rows.values()], totals, categories: EXPENSE_CATEGORIES.filter((c) => totals.byCategory[c] !== undefined).map((key) => ({ key, label: EXPENSE_CATEGORY_LABELS[key] })) };
}

// ── Owed by age ──────────────────────────────────────────────────────────────

export type Buckets = [number, number, number, number];
export const OWED_AGES = AGE_BUCKETS.map((b) => b.label);

export interface OwedRow {
  /** "patients", or the payer's id. */
  key: string;
  name: string;
  kind: "PATIENTS" | "INSURER" | "COMPANY";
  /** By age: patients' invoices from the day they were issued, payers' claims from the day they were made. */
  buckets: Buckets;
  total: number;
  /** Payers: on claims not sent yet, and past the payer's days to pay. */
  notSent: number;
  late: number;
  /** Invoices or claims with something owed. */
  count: number;
}

export interface OwedPatient {
  patientId: string;
  name: string;
  phone: string | null;
  total: number;
  buckets: Buckets;
  invoices: number;
  oldestIssuedAt: string;
}

export interface OwedByAgeReport {
  asOf: string;
  rows: OwedRow[];
  totals: { buckets: Buckets; total: number; late: number; notSent: number };
  /** Work done but not invoiced yet. */
  notInvoiced: number;
  /** Money patients paid ahead, held for them (the clinic's, whatever the branch). */
  credit: number;
  inCredit: number;
  /** Who owes on their invoices, the most first. */
  patients: OwedPatient[];
}

const zeroBuckets = (): Buckets => [0, 0, 0, 0];
const bucketOfDays = (days: number) => (days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3);
const BILLED = ["ISSUED", "PART_PAID", "PAID"] as const;

export async function owedByAgeReport(scope: ReportScope, now: Date = new Date()): Promise<OwedByAgeReport> {
  const t = scope.tenantId;
  const [open, payers, unbilled, balances] = await Promise.all([
    db.invoice.findMany({
      where: { tenantId: t, status: { in: [...OPEN_INVOICE_STATUSES] }, ...(scope.clinicId ? { clinicId: scope.clinicId } : {}) },
      select: {
        patientId: true,
        issuedAt: true,
        total: true,
        patient: { select: { fullName: true, phone: true, whatsapp: true } },
        allocations: { select: { amount: true } },
        writeOffs: { where: { voidedAt: null }, select: { amount: true } },
        claims: claimsSettling,
      },
    }),
    owedByPayer(t, now, { clinicId: scope.clinicId }),
    db.charge.findMany({ where: { tenantId: t, invoiceLines: { none: { invoice: { status: { in: [...BILLED] } } } } }, select: { amount: true, clinicId: true } }),
    balancesReport(scope, now),
  ]);
  const patientsRow: OwedRow = { key: "patients", name: "Patients, on their invoices", kind: "PATIENTS", buckets: zeroBuckets(), total: 0, notSent: 0, late: 0, count: 0 };
  const byPatient = new Map<string, OwedPatient>();
  for (const i of open) {
    const owed = Math.max(0, i.total - i.allocations.reduce((s, a) => s + a.amount, 0) - i.writeOffs.reduce((s, w) => s + w.amount, 0) - claimedOn(i.claims));
    if (!owed || !i.issuedAt) continue;
    const bucket = bucketOfDays(Math.floor((now.getTime() - i.issuedAt.getTime()) / DAY));
    patientsRow.buckets[bucket] += owed;
    patientsRow.total += owed;
    patientsRow.count += 1;
    const p = byPatient.get(i.patientId) ?? { patientId: i.patientId, name: i.patient.fullName, phone: i.patient.whatsapp ?? i.patient.phone, total: 0, buckets: zeroBuckets(), invoices: 0, oldestIssuedAt: i.issuedAt.toISOString() };
    p.total += owed;
    p.buckets[bucket] += owed;
    p.invoices += 1;
    if (i.issuedAt.toISOString() < p.oldestIssuedAt) p.oldestIssuedAt = i.issuedAt.toISOString();
    byPatient.set(i.patientId, p);
  }
  const rows: OwedRow[] = [patientsRow];
  for (const r of payers.rows) {
    rows.push({ key: r.payerId, name: r.payerName, kind: r.kind, buckets: [r.buckets.d30, r.buckets.d60, r.buckets.d90, r.buckets.over], total: r.total, notSent: r.notSent, late: r.overdue, count: r.claims });
  }
  const totals = { buckets: zeroBuckets(), total: 0, late: 0, notSent: 0 };
  for (const r of rows) {
    for (let k = 0; k < 4; k++) totals.buckets[k as 0 | 1 | 2 | 3] += r.buckets[k as 0 | 1 | 2 | 3];
    totals.total += r.total;
    totals.late += r.late;
    totals.notSent += r.notSent;
  }
  return {
    asOf: now.toISOString(),
    rows,
    totals,
    notInvoiced: unbilled.filter((c) => inBranch(scope, c.clinicId)).reduce((s, c) => s + c.amount, 0),
    credit: balances.totals.credit,
    inCredit: balances.totals.inCredit,
    patients: [...byPatient.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  };
}

// ── Collection rate ──────────────────────────────────────────────────────────

export interface CollectionFigures {
  invoices: number;
  /** What the invoices issued in the month came to. */
  billed: number;
  /** Paid since: by the patients (their money put towards these invoices), by insurers and companies on their claims. */
  fromPatients: number;
  fromPayers: number;
  collected: number;
  writtenOff: number;
  /** Still owed on them: by payers on their claims, by the patients. */
  payersOwe: number;
  patientsOwe: number;
  /** Collected as a share of what was billed (%), null without invoices. */
  rate: number | null;
}

export interface CollectionMonth extends CollectionFigures {
  month: string;
  label: string;
}

export interface CollectionReport {
  months: CollectionMonth[];
  totals: CollectionFigures;
}

const zeroCollection = (): CollectionFigures => ({ invoices: 0, billed: 0, fromPatients: 0, fromPayers: 0, collected: 0, writtenOff: 0, payersOwe: 0, patientsOwe: 0, rate: null });

/** Of the invoices issued each month (cancelled ones aside), how much has been collected since, written off, and is still owed. */
export async function collectionReport(scope: ReportScope): Promise<CollectionReport> {
  const months = monthsOf(scope);
  const rows = new Map(months.map((m) => [m.month, { month: m.month, label: m.label, ...zeroCollection() }]));
  const invoices = await db.invoice.findMany({
    where: { tenantId: scope.tenantId, status: { in: [...BILLED] }, issuedAt: span(scope), ...(scope.clinicId ? { clinicId: scope.clinicId } : {}) },
    select: {
      issuedAt: true,
      total: true,
      allocations: { select: { amount: true } },
      writeOffs: { where: { voidedAt: null }, select: { amount: true } },
      claims: { where: { status: { not: "CANCELLED" } }, select: { lines: { select: { payerShare: true, answers: { where: { voidedAt: null }, select: { paid: true, refused: true } } } } } },
    },
  });
  const totals = zeroCollection();
  for (const i of invoices) {
    const r = rows.get(monthOf(scope, i.issuedAt!));
    if (!r) continue;
    const fromPatients = i.allocations.reduce((s, a) => s + a.amount, 0);
    const writtenOff = i.writeOffs.reduce((s, w) => s + w.amount, 0);
    const lines = i.claims.flatMap((c) => c.lines);
    const fromPayers = lines.reduce((s, l) => s + l.answers.reduce((t, a) => t + a.paid, 0), 0);
    const payersOwe = lines.reduce((s, l) => s + Math.max(0, l.payerShare - l.answers.reduce((t, a) => t + a.paid + a.refused, 0)), 0);
    const claimed = lines.reduce((s, l) => s + l.payerShare - l.answers.reduce((t, a) => t + a.refused, 0), 0);
    const patientsOwe = Math.max(0, i.total - fromPatients - writtenOff - claimed);
    for (const x of [r, totals]) {
      x.invoices += 1;
      x.billed += i.total;
      x.fromPatients += fromPatients;
      x.fromPayers += fromPayers;
      x.collected += fromPatients + fromPayers;
      x.writtenOff += writtenOff;
      x.payersOwe += payersOwe;
      x.patientsOwe += patientsOwe;
    }
  }
  for (const x of [...rows.values(), totals]) x.rate = rate(x.collected, x.billed);
  return { months: [...rows.values()], totals };
}

// ── Case acceptance ──────────────────────────────────────────────────────────

export interface AcceptanceFigures extends AcceptanceRow {
  /** Accepted as a share of what was given, by count and by value (%). */
  rate: number | null;
  valueRate: number | null;
}

export interface AcceptanceMonth extends AcceptanceFigures {
  month: string;
  label: string;
}

export interface AcceptanceReport {
  months: AcceptanceMonth[];
  totals: AcceptanceFigures;
  byDoctor: (AcceptanceFigures & { doctorId: string | null; name: string })[];
}

const withRates = <T extends AcceptanceRow>(r: T): T & { rate: number | null; valueRate: number | null } => ({ ...r, rate: rate(r.accepted, r.presented), valueRate: rate(r.acceptedValue, r.presentedValue) });

/**
 * Treatment plans given each month and what became of them (counted as on
 * the treatment plans page: a plan withdrawn or replaced by a revision is
 * left out, the revision counts), overall and by doctor.
 */
export async function acceptanceReport(scope: ReportScope, now: Date = new Date()): Promise<AcceptanceReport> {
  const months = monthsOf(scope);
  const today = startOfDayInTz(now, scope.timezone);
  const quotes = await db.quote.findMany({
    where: { tenantId: scope.tenantId, status: { in: ["SENT", "ACCEPTED", "DECLINED"] }, sentAt: span(scope), ...(scope.clinicId ? { clinicId: scope.clinicId } : {}) },
    select: { status: true, total: true, acceptedTotal: true, validUntil: true, doctorId: true, sentAt: true },
  });
  const rows = new Map(months.map((m) => [m.month, { month: m.month, label: m.label, ...emptyAcceptance() }]));
  const totals = emptyAcceptance();
  const doctors = new Map<string | null, AcceptanceRow>();
  for (const q of quotes) {
    const r = rows.get(monthOf(scope, q.sentAt!));
    if (!r) continue;
    const d = doctors.get(q.doctorId) ?? emptyAcceptance();
    doctors.set(q.doctorId, d);
    for (const x of [r, totals, d]) tallyQuote(x, q, today);
  }
  const ids = [...doctors.keys()].filter((d): d is string => Boolean(d));
  const users = ids.length ? await db.user.findMany({ where: { tenantId: scope.tenantId, id: { in: ids } }, select: { id: true, fullName: true, email: true } }) : [];
  const names = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
  return {
    months: [...rows.values()].map(withRates),
    totals: withRates(totals),
    byDoctor: [...doctors.entries()]
      .map(([doctorId, r]) => withRates({ ...r, doctorId, name: doctorId ? (names.get(doctorId) ?? "A former doctor") : "No doctor named" }))
      .sort((a, b) => b.presentedValue - a.presentedValue || a.name.localeCompare(b.name)),
  };
}

// ── Instalments due ──────────────────────────────────────────────────────────

export const INSTALMENT_MONTHS_AHEAD = 6;

export interface InstalmentMonth {
  month: string;
  label: string;
  /** A month to come. */
  ahead: boolean;
  instalments: number;
  /** What falls due in the month, what the plans' payments cover of it, and what is still owed (late, once its day is past). */
  due: number;
  paid: number;
  owed: number;
  late: number;
}

export interface InstalmentLine {
  planId: string;
  patientId: string;
  patientName: string;
  phone: string | null;
  title: string;
  /** 0: the down payment. */
  number: number;
  dueKey: string;
  amount: number;
  owed: number;
  state: InstalmentState;
  daysLate: number;
}

export interface InstalmentsDueReport {
  months: InstalmentMonth[];
  totals: { instalments: number; due: number; paid: number; owed: number; late: number };
  /** Still owed past its day, the latest first; and falling due within the next 30 days. */
  late: InstalmentLine[];
  next: InstalmentLine[];
  /** Active plans, and what they still have to collect. */
  activePlans: number;
  leftToCollect: number;
}

/**
 * What instalment plans have falling due each month, from the first month of
 * the window to six months ahead: due, paid (the plan's payments cover its
 * instalments in order) and still owed. A stopped plan's instalments count
 * only as far as they were paid.
 */
export async function instalmentsDueReport(scope: ReportScope, now: Date = new Date()): Promise<InstalmentsDueReport> {
  const todayKey = dateKeyInTz(now, scope.timezone);
  const first = scope.period.fromKey.slice(0, 7);
  const last = shiftMonth(todayKey.slice(0, 7), INSTALMENT_MONTHS_AHEAD);
  const rows = new Map<string, InstalmentMonth>();
  for (let key = first; key <= last; key = shiftMonth(key, 1)) rows.set(key, { month: key, label: monthName(key), ahead: key > todayKey.slice(0, 7), instalments: 0, due: 0, paid: 0, owed: 0, late: 0 });
  const plans = await db.instalmentPlan.findMany({
    where: { tenantId: scope.tenantId },
    select: {
      id: true,
      title: true,
      status: true,
      total: true,
      reminderDays: true,
      patient: { select: { id: true, fullName: true, phone: true, whatsapp: true } },
      quote: { select: { clinicId: true } },
      instalments: { select: { number: true, dueAt: true, amount: true } },
      payments: { where: { deletedAt: null }, select: { kind: true, amount: true } },
    },
  });
  const totals = { instalments: 0, due: 0, paid: 0, owed: 0, late: 0 };
  const late: InstalmentLine[] = [];
  const next: InstalmentLine[] = [];
  let activePlans = 0;
  let leftToCollect = 0;
  const in30 = dateKeyInTz(new Date(now.getTime() + 30 * DAY), scope.timezone);
  for (const plan of plans) {
    if (!inBranch(scope, plan.quote?.clinicId ?? null)) continue;
    const paid = plan.payments.reduce((s, p) => s + (p.kind === "REFUND" ? -p.amount : p.amount), 0);
    const covered = coverInstalments(
      plan.instalments.map((i) => ({ number: i.number, dueKey: dateKeyInTz(i.dueAt, scope.timezone), amount: i.amount })),
      paid,
      todayKey,
      plan.reminderDays,
    );
    const stopped = plan.status === "CANCELLED";
    if (plan.status === "ACTIVE") {
      activePlans += 1;
      leftToCollect += covered.reduce((s, i) => s + i.owed, 0);
    }
    for (const i of covered) {
      // A stopped plan's instalments are due only as far as they were paid.
      const due = stopped ? i.covered : i.amount;
      const owed = stopped ? 0 : i.owed;
      if (!due) continue;
      const r = rows.get(i.dueKey.slice(0, 7));
      const isLate = owed > 0 && i.dueKey < todayKey;
      if (r) {
        for (const x of [r, totals]) {
          x.instalments += 1;
          x.due += due;
          x.paid += i.covered;
          x.owed += owed;
          if (isLate) x.late += owed;
        }
      }
      if (!owed) continue;
      const line: InstalmentLine = {
        planId: plan.id,
        patientId: plan.patient.id,
        patientName: plan.patient.fullName,
        phone: plan.patient.whatsapp ?? plan.patient.phone,
        title: plan.title,
        number: i.number,
        dueKey: i.dueKey,
        amount: i.amount,
        owed,
        state: i.state,
        daysLate: i.daysLate,
      };
      if (isLate) late.push(line);
      else if (i.dueKey <= in30) next.push(line);
    }
  }
  late.sort((a, b) => b.dueKey.localeCompare(a.dueKey) || a.patientName.localeCompare(b.patientName));
  next.sort((a, b) => a.dueKey.localeCompare(b.dueKey) || a.patientName.localeCompare(b.patientName));
  return { months: [...rows.values()], totals, late, next, activePlans, leftToCollect };
}

// ── Revenue by marketing source ──────────────────────────────────────────────

export type SourceKey = LeadSourceValue | "unknown";

export interface SourceFigures {
  /** Patients from the source; new in the window; seen (with work) in the window. */
  patients: number;
  newPatients: number;
  seen: number;
  /** The work done for them in the window (production), and the money that came in for them. */
  production: number;
  collected: number;
  /** What the source's campaigns cost over the window (spread by day). */
  cost: number;
}

export interface SourceRow extends SourceFigures {
  source: SourceKey;
  label: string;
  /** Production per new patient; production for each pound of campaign cost. */
  perNewPatient: number | null;
  returnOnCost: number | null;
}

export interface SourceCampaign extends SourceFigures {
  campaignId: string;
  name: string;
  source: SourceKey;
  returnOnCost: number | null;
}

export interface SourcesReport {
  rows: SourceRow[];
  totals: SourceFigures;
  campaigns: SourceCampaign[];
  /** Production by source, month by month. */
  months: { month: string; label: string; bySource: Partial<Record<SourceKey, number>> }[];
}

const zeroSource = (): SourceFigures => ({ patients: 0, newPatients: 0, seen: 0, production: 0, collected: 0, cost: 0 });

/**
 * The work and the money each marketing source brings: a patient's source is
 * where they first came from (the CRM's first touch, else their first lead's),
 * "Unknown" when none was recorded; the campaign is their first lead's. The
 * campaigns' costs are the clinic's, whatever the branch.
 */
export async function sourcesReport(scope: ReportScope): Promise<SourcesReport> {
  const t = scope.tenantId;
  const months = monthsOf(scope);
  const [patients, charges, payments, payerMoney, campaigns] = await Promise.all([
    db.patient.findMany({
      where: { tenantId: t },
      select: { id: true, source: true, createdAt: true, leads: { where: { deletedAt: null }, orderBy: { createdAt: "asc" }, take: 1, select: { source: true, campaignId: true } } },
    }),
    db.charge.findMany({ where: { tenantId: t, chargedAt: span(scope) }, select: { patientId: true, amount: true, chargedAt: true, clinicId: true } }),
    db.payment.findMany({ where: { tenantId: t, deletedAt: null, paidAt: span(scope) }, select: { patientId: true, kind: true, amount: true, paidAt: true, clinicId: true } }),
    db.claimAnswer.findMany({
      where: { tenantId: t, voidedAt: null, paid: { gt: 0 }, payerPayment: { voidedAt: null, paidAt: span(scope) } },
      select: { paid: true, claimLine: { select: { claim: { select: { patientId: true, clinicId: true } } } } },
    }),
    db.campaign.findMany({ where: { tenantId: t }, select: { id: true, name: true, source: true, costs: { select: { campaignId: true, periodStart: true, periodEnd: true, amount: true } } } }),
  ]);
  const sourceOf = new Map<string, SourceKey>();
  const campaignOf = new Map<string, string>();
  for (const p of patients) {
    const lead = p.leads[0];
    const s = (p.source ?? lead?.source ?? null) as LeadSourceValue | null;
    sourceOf.set(p.id, s && (LEAD_SOURCES as readonly string[]).includes(s) ? s : "unknown");
    if (lead?.campaignId) campaignOf.set(p.id, lead.campaignId);
  }
  const bySource = new Map<SourceKey, SourceFigures & { seenIds: Set<string> }>();
  const byCampaign = new Map<string, SourceFigures & { seenIds: Set<string> }>();
  const monthly = new Map(months.map((m) => [m.month, { month: m.month, label: m.label, bySource: {} as Partial<Record<SourceKey, number>> }]));
  const fig = <K>(map: Map<K, SourceFigures & { seenIds: Set<string> }>, key: K) => {
    let f = map.get(key);
    if (!f) map.set(key, (f = { ...zeroSource(), seenIds: new Set() }));
    return f;
  };
  const targets = (patientId: string) => {
    const out = [fig(bySource, sourceOf.get(patientId) ?? "unknown")];
    const c = campaignOf.get(patientId);
    if (c) out.push(fig(byCampaign, c));
    return out;
  };
  for (const p of patients) {
    const isNew = p.createdAt >= scope.period.from && p.createdAt < scope.period.to;
    for (const f of targets(p.id)) {
      f.patients += 1;
      if (isNew) f.newPatients += 1;
    }
  }
  const produced = (patientId: string, amount: number, at: Date) => {
    for (const f of targets(patientId)) {
      f.production += amount;
      f.seenIds.add(patientId);
    }
    const m = monthly.get(monthOf(scope, at));
    const s = sourceOf.get(patientId) ?? "unknown";
    if (m) m.bySource[s] = (m.bySource[s] ?? 0) + amount;
  };
  for (const c of charges) if (inBranch(scope, c.clinicId)) produced(c.patientId, c.amount, c.chargedAt);
  for (const p of payments) {
    if (!inBranch(scope, p.clinicId)) continue;
    if (p.kind === "CONSULTATION_FEE") produced(p.patientId, p.amount, p.paidAt);
    for (const f of targets(p.patientId)) f.collected += p.kind === "REFUND" ? -p.amount : p.amount;
  }
  for (const a of payerMoney) {
    if (!inBranch(scope, a.claimLine.claim.clinicId)) continue;
    for (const f of targets(a.claimLine.claim.patientId)) f.collected += a.paid;
  }
  for (const c of campaigns) {
    const cost = Math.round(c.costs.reduce((s, x) => s + prorateCost(x, scope.period, scope.timezone), 0));
    if (!cost) continue;
    fig(bySource, (LEAD_SOURCES as readonly string[]).includes(c.source) ? (c.source as LeadSourceValue) : "unknown").cost += cost;
    fig(byCampaign, c.id).cost += cost;
  }
  const totals = zeroSource();
  const rows: SourceRow[] = [];
  for (const source of [...LEAD_SOURCES, "unknown" as const]) {
    const f = bySource.get(source);
    if (!f) continue;
    const { seenIds, ...figures } = f;
    figures.seen = seenIds.size;
    if (!figures.patients && !figures.cost) continue;
    rows.push({ source, label: source === "unknown" ? "Not recorded" : SOURCE_LABELS[source], ...figures, perNewPatient: figures.newPatients ? Math.round(figures.production / figures.newPatients) : null, returnOnCost: figures.cost ? Math.round((figures.production / figures.cost) * 10) / 10 : null });
    for (const k of ["patients", "newPatients", "seen", "production", "collected", "cost"] as const) totals[k] += figures[k];
  }
  rows.sort((a, b) => b.production - a.production || a.label.localeCompare(b.label));
  const names = new Map(campaigns.map((c) => [c.id, c]));
  const campaignRows: SourceCampaign[] = [...byCampaign.entries()]
    .map(([campaignId, f]) => {
      const { seenIds, ...figures } = f;
      const c = names.get(campaignId);
      const source: SourceKey = c && (LEAD_SOURCES as readonly string[]).includes(c.source) ? (c.source as LeadSourceValue) : "unknown";
      return { campaignId, name: c?.name ?? "A campaign", source, ...figures, seen: seenIds.size, returnOnCost: figures.cost ? Math.round((figures.production / figures.cost) * 10) / 10 : null };
    })
    .filter((c) => c.patients || c.cost)
    .sort((a, b) => b.production - a.production || a.name.localeCompare(b.name));
  return { rows, totals, campaigns: campaignRows, months: [...monthly.values()] };
}

// ── Any of them ──────────────────────────────────────────────────────────────

export async function monthlyReport(scope: ReportScope, key: MonthlyReportKey, now: Date = new Date()) {
  switch (key) {
    case "pnl":
      return profitAndLossReport(scope, now);
    case "owed":
      return owedByAgeReport(scope, now);
    case "collection":
      return collectionReport(scope);
    case "acceptance":
      return acceptanceReport(scope, now);
    case "instalments":
      return instalmentsDueReport(scope, now);
    case "sources":
      return sourcesReport(scope);
  }
}

const pct = (v: number | null) => (v === null ? "" : v);

export async function monthlyReportCsv(scope: ReportScope, key: MonthlyReportKey, now: Date = new Date()): Promise<{ filename: string; csv: string }> {
  const window = `${scope.period.fromKey.slice(0, 7)}-to-${scope.period.toKey.slice(0, 7)}`;
  if (key === "pnl") {
    const r = await profitAndLossReport(scope, now);
    const cells = (x: PnlFigures): CsvCell[] => [x.production, -x.writtenOff, x.revenue, ...r.categories.map((c) => -(x.byCategory[c.key] ?? 0)), -x.expenses, -x.doctorPay, x.profit, pct(x.margin), x.moneyIn, -x.moneyOut];
    return {
      filename: `profit-and-loss-${window}.csv`,
      csv: toCsv(
        ["Month", "Production (EGP)", "Written off (EGP)", "Revenue (EGP)", ...r.categories.map((c) => `${c.label} (EGP)`), "Expenses (EGP)", "Doctors' pay (EGP)", "Profit (EGP)", "Margin (%)", "Money in (EGP)", "Money out (EGP)", "Doctors' pay final"],
        [...r.months.map((m) => [m.month, ...cells(m), m.doctorPayOpen ? "no: month not closed" : "yes"]), ["Total", ...cells(r.totals), ""]],
      ),
    };
  }
  if (key === "owed") {
    const r = await owedByAgeReport(scope, now);
    const asOf = dateKeyInTz(new Date(r.asOf), scope.timezone);
    return {
      filename: `owed-by-age-${asOf}.csv`,
      csv: toCsv(
        ["Who", "Kind", "Phone", ...OWED_AGES.map((a) => `${a} (EGP)`), "Owed (EGP)", "Not sent yet (EGP)", "Late (EGP)", "Invoices or claims"],
        [
          ...r.patients.map((p) => [p.name, "Patient", p.phone, ...p.buckets, p.total, "", "", p.invoices]),
          ...r.rows.filter((x) => x.kind !== "PATIENTS").map((x) => [x.name, x.kind === "INSURER" ? "Insurer" : "Company", "", ...x.buckets, x.total, x.notSent, x.late, x.count]),
          ["Total", "", "", ...r.totals.buckets, r.totals.total, r.totals.notSent, r.totals.late, ""],
        ],
      ),
    };
  }
  if (key === "collection") {
    const r = await collectionReport(scope);
    const cells = (x: CollectionFigures): CsvCell[] => [x.invoices, x.billed, x.fromPatients, x.fromPayers, x.collected, x.writtenOff, x.payersOwe, x.patientsOwe, pct(x.rate)];
    return {
      filename: `collection-rate-${window}.csv`,
      csv: toCsv(
        ["Month issued", "Invoices", "Billed (EGP)", "Paid by patients (EGP)", "Paid by insurers and companies (EGP)", "Collected (EGP)", "Written off (EGP)", "Owed by payers (EGP)", "Owed by patients (EGP)", "Collection rate (%)"],
        [...r.months.map((m) => [m.month, ...cells(m)]), ["Total", ...cells(r.totals)]],
      ),
    };
  }
  if (key === "acceptance") {
    const r = await acceptanceReport(scope, now);
    const cells = (x: AcceptanceFigures): CsvCell[] => [x.presented, x.presentedValue, x.accepted, x.acceptedValue, x.declined, x.expired, x.open, pct(x.rate), pct(x.valueRate)];
    return {
      filename: `case-acceptance-${window}.csv`,
      csv: toCsv(
        ["Month or doctor", "Plans given", "Value given (EGP)", "Accepted", "Value accepted (EGP)", "Declined", "Expired", "Waiting", "Acceptance (%)", "Acceptance by value (%)"],
        [...r.months.map((m) => [m.month, ...cells(m)]), ["Total", ...cells(r.totals)], ...r.byDoctor.map((d) => [d.name, ...cells(d)])],
      ),
    };
  }
  if (key === "instalments") {
    const r = await instalmentsDueReport(scope, now);
    return {
      filename: `instalments-due-${window}.csv`,
      csv: toCsv(
        ["Month", "To come", "Instalments", "Due (EGP)", "Paid (EGP)", "Still owed (EGP)", "Late (EGP)"],
        [...r.months.map((m) => [m.month, m.ahead ? "yes" : "", m.instalments, m.due, m.paid, m.owed, m.late]), ["Total", "", r.totals.instalments, r.totals.due, r.totals.paid, r.totals.owed, r.totals.late]],
      ),
    };
  }
  const r = await sourcesReport(scope);
  const cells = (x: SourceFigures): CsvCell[] => [x.patients, x.newPatients, x.seen, x.production, x.collected, x.cost];
  return {
    filename: `revenue-by-source-${window}.csv`,
    csv: toCsv(
      ["Source or campaign", "Kind", "Patients", "New patients", "Seen", "Production (EGP)", "Collected (EGP)", "Campaign cost (EGP)", "Production per new patient (EGP)", "Production per EGP of cost"],
      [
        ...r.rows.map((s) => [s.label, "Source", ...cells(s), s.perNewPatient ?? "", s.returnOnCost ?? ""]),
        ["Total", "", ...cells(r.totals), "", ""],
        ...r.campaigns.map((c) => [c.name, `Campaign (${SOURCE_LABELS[c.source]})`, ...cells(c), "", c.returnOnCost ?? ""]),
      ],
    ),
  };
}
