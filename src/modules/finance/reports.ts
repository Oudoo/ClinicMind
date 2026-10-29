import type { PaymentKind, PaymentMethod } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { TenantScopeError } from "@/lib/tenant-scope";
import { addDays, dateKeyInTz, formatDateInTz, startOfDayInTz } from "@/lib/time";
import { zOptionalText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { toCsv, type CsvCell } from "@/modules/reporting/csv";
import { resolvePeriod, type ResolvedPeriod } from "@/modules/reporting/period";
import { OPEN_INVOICE_STATUSES } from "./allocations";
import { stageShare, summarizeCharges } from "./charges";
import {
  DISCOUNT_REASON_LABELS,
  METHOD_LABELS,
  PAYMENT_METHODS,
  PROCEDURE_STATUSES,
  PROCEDURE_STATUS_LABELS,
  WRITE_OFF_REASON_LABELS,
  type DiscountReasonValue,
  type PaymentMethodValue,
  type ProcedureStatusValue,
  type WriteOffReasonValue,
} from "./constants";
import { patientBalances } from "./ledger";

/**
 * The owner's financial reports, as Dentalore keeps them: the money that came
 * in each day (income), the work done each day (production) and at each
 * branch, the adjustments (discounts, write-offs, cancelled work, refunds,
 * voided payments, credit notes), what patients owe and the invoices, how the
 * procedures are getting on, and each doctor's figures. Production is counted
 * from the charges (the patients' accounts), on the day the work was done:
 *
 *   gross production = the work done at its price before any discount
 *   net production   = gross − discounts + cancelled work (negative) + consultation fees
 *                    = the period's charges and consultation fees
 *   income           = payments, deposits and consultation fees − refunds
 *
 * A procedure's own discount is spread over its charges as its price is
 * (a course, session by session), so each day's gross and discounts add up
 * to what was charged. A cancellation is a correction on the day it is made;
 * the day the work was done keeps its figures. Voided payments never count.
 */

export const FINANCE_REPORTS = ["income", "production", "branches", "adjustments", "balances", "procedures", "providers"] as const;
export type FinanceReportKey = (typeof FINANCE_REPORTS)[number];

export const FINANCE_REPORT_LABELS: Record<FinanceReportKey, string> = {
  income: "Daily income",
  production: "Daily production",
  branches: "Branch production",
  adjustments: "Daily adjustments",
  balances: "Balances & invoices",
  procedures: "Procedures tracking",
  providers: "Provider financials",
};

export const ADJUSTMENT_TYPES = ["DISCOUNT", "WRITE_OFF", "CANCELLED", "REFUND", "VOID", "CREDIT_NOTE"] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

export const ADJUSTMENT_LABELS: Record<AdjustmentType, string> = {
  DISCOUNT: "Discount",
  WRITE_OFF: "Write-off",
  CANCELLED: "Cancelled work",
  REFUND: "Refund",
  VOID: "Voided payment",
  CREDIT_NOTE: "Credit note",
};

export const ReportFilters = z.object({
  period: zOptionalText(16),
  from: zOptionalText(10),
  to: zOptionalText(10),
  clinicId: zOptionalText(64),
  /** Procedures tracking: one status. */
  status: z.enum(PROCEDURE_STATUSES).optional().catch(undefined),
  /** Procedures tracking: one doctor ("none": no doctor). */
  doctorId: zOptionalText(64),
  /** Adjustments: one type. */
  type: z.enum(ADJUSTMENT_TYPES).optional().catch(undefined),
});
export type ReportFilters = z.infer<typeof ReportFilters>;

export interface ReportScope {
  tenantId: string;
  timezone: string;
  period: ResolvedPeriod;
  /** One branch, or every branch (null). */
  clinicId: string | null;
  clinics: { id: string; name: string }[];
  /** Money and work with no branch of its own belong to the first. */
  defaultClinicId: string | null;
  filters: ReportFilters;
}

/** The period (28 days by default), the branch and the filters of a report. */
export async function reportScope(tenantId: string, raw: Record<string, string | undefined>, now: Date = new Date()): Promise<ReportScope> {
  const filters = ReportFilters.parse(raw);
  const [timezone, clinics] = await Promise.all([
    getTenantTimezone(tenantId),
    db.clinic.findMany({ where: { tenantId, ...notDeleted }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true } }),
  ]);
  if (filters.clinicId && !clinics.some((c) => c.id === filters.clinicId)) throw new TenantScopeError("clinic", filters.clinicId);
  const period = resolvePeriod({ period: filters.period, from: filters.from, to: filters.to }, timezone, now);
  return { tenantId, timezone, period, clinicId: filters.clinicId ?? null, clinics, defaultClinicId: clinics[0]?.id ?? null, filters };
}

/** Every branch over a period already resolved (the finance dashboard's). */
export async function scopeForPeriod(tenantId: string, period: ResolvedPeriod, timezone: string): Promise<ReportScope> {
  const clinics = await db.clinic.findMany({ where: { tenantId, ...notDeleted }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true } });
  return { tenantId, timezone, period, clinicId: null, clinics, defaultClinicId: clinics[0]?.id ?? null, filters: {} };
}

/** The comparison period of a resolved period, as a period of its own. */
export function previousOf(period: ResolvedPeriod, timezone: string): ResolvedPeriod {
  const { from, to } = period.previous;
  return { ...period, from, to, fromKey: dateKeyInTz(from, timezone), toKey: dateKeyInTz(new Date(to.getTime() - 1), timezone) };
}

const branchOf = (scope: ReportScope, clinicId: string | null) => clinicId ?? scope.defaultClinicId;
const inBranch = (scope: ReportScope, clinicId: string | null) => !scope.clinicId || branchOf(scope, clinicId) === scope.clinicId;
const dayOf = (scope: ReportScope, at: Date) => dateKeyInTz(at, scope.timezone);
const span = (scope: ReportScope) => ({ gte: scope.period.from, lt: scope.period.to });

/** Every day of the period, oldest first (YYYY-MM-DD on the clinic clock). */
function daysOf(scope: ReportScope): string[] {
  const out: string[] = [];
  for (let at = startOfDayInTz(scope.period.from, scope.timezone); at < scope.period.to; at = addDays(at, 1, scope.timezone)) out.push(dateKeyInTz(at, scope.timezone));
  return out;
}

async function namesOf(tenantId: string): Promise<Map<string, string>> {
  const users = await db.user.findMany({ where: { tenantId }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
}

async function patientNames(tenantId: string, ids: Iterable<string>): Promise<Map<string, { name: string; phone: string | null }>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.patient.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, fullName: true, phone: true } });
  return new Map(rows.map((p) => [p.id, { name: p.fullName, phone: p.phone }]));
}

/** Split `amount` over the weights in proportion, in whole pounds, the shares adding up to `amount`. */
export function splitByWeight<K>(amount: number, weights: Map<K, number>): Map<K, number> {
  const out = new Map<K, number>();
  const total = [...weights.values()].reduce((s, w) => s + w, 0);
  if (!weights.size) return out;
  if (total <= 0) {
    const [first] = weights.keys();
    out.set(first as K, amount);
    return out;
  }
  let given = 0;
  const parts = [...weights].map(([key, w]) => {
    const exact = (amount * w) / total;
    const whole = Math.floor(exact);
    given += whole;
    return { key, whole, rest: exact - whole };
  });
  let left = amount - given;
  parts.sort((x, y) => y.rest - x.rest);
  for (const p of parts) {
    out.set(p.key, p.whole + (left > 0 ? 1 : 0));
    if (left > 0) left -= 1;
  }
  return out;
}

// ── Charges ──────────────────────────────────────────────────────────────────

interface DiscountedProcedure {
  price: number;
  discount: number;
  stages: number;
  charges: { stage: number | null; reversalOfId: string | null; discountOfId: string | null }[];
}

/**
 * The part of a procedure's own discount that one of its charges carries:
 * all of it on work charged at once; on a course, each session's share (the
 * discount spread as the price is); what was left at the signature carries
 * the rest.
 */
export function procedureDiscountShare(procedure: DiscountedProcedure, charge: { stage: number | null }): number {
  const { price, discount, stages } = procedure;
  if (discount <= 0) return 0;
  if (stages <= 1) return discount;
  const share = (k: number) => stageShare(price, stages, k) - stageShare(price - discount, stages, k);
  if (charge.stage !== null) return share(charge.stage);
  const carried = procedure.charges.filter((c) => c.stage !== null && c.reversalOfId === null && c.discountOfId === null).reduce((s, c) => s + share(c.stage!), 0);
  return discount - carried;
}

export interface ChargeLine {
  id: string;
  kind: "work" | "discount" | "reversal";
  patientId: string;
  procedureId: string | null;
  clinicId: string | null;
  doctorId: string | null;
  chargedAt: Date;
  day: string;
  amount: number;
  /** Work: the procedure's own discount this charge carries. */
  procedureDiscount: number;
  description: string;
  treatment: string | null;
  /** A discount: its reason (a key of the fixed list); work: the procedure's discount reason. */
  reason: string | null;
  note: string | null;
  /** Who gave the discount (a procedure's), or who posted the charge. */
  by: string | null;
  cancelReason: string | null;
}

async function chargesIn(scope: ReportScope): Promise<ChargeLine[]> {
  const rows = await db.charge.findMany({
    where: { tenantId: scope.tenantId, chargedAt: span(scope) },
    orderBy: [{ chargedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      patientId: true,
      procedureId: true,
      clinicId: true,
      doctorId: true,
      chargedAt: true,
      amount: true,
      stage: true,
      reversalOfId: true,
      discountOfId: true,
      description: true,
      reason: true,
      createdById: true,
      procedure: {
        select: {
          price: true,
          discount: true,
          stages: true,
          discountReason: true,
          discountNote: true,
          discountById: true,
          cancelReason: true,
          treatment: { select: { name: true } },
          charges: { select: { stage: true, reversalOfId: true, discountOfId: true } },
        },
      },
    },
  });
  return rows
    .filter((c) => inBranch(scope, c.clinicId))
    .map((c): ChargeLine => {
      const kind = c.reversalOfId ? "reversal" : c.discountOfId ? "discount" : "work";
      const p = c.procedure;
      const procedureDiscount = kind === "work" && p ? procedureDiscountShare(p, c) : 0;
      return {
        id: c.id,
        kind,
        patientId: c.patientId,
        procedureId: c.procedureId,
        clinicId: branchOf(scope, c.clinicId),
        doctorId: c.doctorId,
        chargedAt: c.chargedAt,
        day: dayOf(scope, c.chargedAt),
        amount: c.amount,
        procedureDiscount,
        description: c.description,
        treatment: p?.treatment.name ?? null,
        reason: kind === "discount" ? c.reason : procedureDiscount > 0 ? (p?.discountReason ?? null) : null,
        note: procedureDiscount > 0 ? (p?.discountNote ?? null) : null,
        by: procedureDiscount > 0 ? (p?.discountById ?? c.createdById) : c.createdById,
        cancelReason: kind === "reversal" ? (p?.cancelReason ?? null) : null,
      };
    });
}

interface FeeLine {
  id: string;
  patientId: string;
  clinicId: string | null;
  doctorId: string | null;
  paidAt: Date;
  day: string;
  amount: number;
}

/** Consultation fees: charged and paid at once, so production and income alike. */
async function feesIn(scope: ReportScope): Promise<FeeLine[]> {
  const rows = await db.payment.findMany({
    where: { tenantId: scope.tenantId, kind: "CONSULTATION_FEE", deletedAt: null, paidAt: span(scope) },
    select: { id: true, patientId: true, clinicId: true, appointmentId: true, paidAt: true, amount: true },
  });
  const kept = rows.filter((p) => inBranch(scope, p.clinicId));
  const appointmentIds = [...new Set(kept.map((p) => p.appointmentId).filter((id): id is string => Boolean(id)))];
  const doctors = appointmentIds.length
    ? new Map((await db.appointment.findMany({ where: { tenantId: scope.tenantId, id: { in: appointmentIds } }, select: { id: true, doctorId: true } })).map((a) => [a.id, a.doctorId]))
    : new Map<string, string | null>();
  return kept.map((p) => ({
    id: p.id,
    patientId: p.patientId,
    clinicId: branchOf(scope, p.clinicId),
    doctorId: p.appointmentId ? (doctors.get(p.appointmentId) ?? null) : null,
    paidAt: p.paidAt,
    day: dayOf(scope, p.paidAt),
    amount: p.amount,
  }));
}

// ── Production ───────────────────────────────────────────────────────────────

export interface ProductionTotals {
  /** Work done, at its price before any discount. */
  gross: number;
  /** Discounts (negative): a procedure's own, and those taken off invoice lines. */
  discounts: number;
  /** Work cancelled after it was charged (negative). */
  cancelled: number;
  fees: number;
  net: number;
  /** Procedures and sessions charged. */
  procedures: number;
}

const zeroProduction = (): ProductionTotals => ({ gross: 0, discounts: 0, cancelled: 0, fees: 0, net: 0, procedures: 0 });

function addCharge(t: ProductionTotals, c: ChargeLine): void {
  if (c.kind === "work") {
    t.gross += c.amount + c.procedureDiscount;
    t.discounts -= c.procedureDiscount;
    if (c.procedureId) t.procedures += 1;
  } else if (c.kind === "discount") {
    t.discounts += c.amount;
  } else {
    t.cancelled += c.amount;
  }
  t.net += c.amount;
}

function addFee(t: ProductionTotals, f: FeeLine): void {
  t.fees += f.amount;
  t.net += f.amount;
}

export interface ProductionDay extends ProductionTotals {
  date: string;
}

export interface ProductionReport {
  days: ProductionDay[];
  totals: ProductionTotals;
  byTreatment: { name: string; net: number; procedures: number }[];
}

export async function productionReport(scope: ReportScope): Promise<ProductionReport> {
  const [charges, fees] = await Promise.all([chargesIn(scope), feesIn(scope)]);
  const days = new Map(daysOf(scope).map((d) => [d, { date: d, ...zeroProduction() }]));
  const totals = zeroProduction();
  const treatments = new Map<string, { name: string; net: number; procedures: number }>();
  for (const c of charges) {
    const day = days.get(c.day);
    if (day) addCharge(day, c);
    addCharge(totals, c);
    const name = c.treatment ?? "Visits";
    const t = treatments.get(name) ?? { name, net: 0, procedures: 0 };
    t.net += c.amount;
    if (c.kind === "work" && c.procedureId) t.procedures += 1;
    treatments.set(name, t);
  }
  for (const f of fees) {
    const day = days.get(f.day);
    if (day) addFee(day, f);
    addFee(totals, f);
    const t = treatments.get("Consultation fees") ?? { name: "Consultation fees", net: 0, procedures: 0 };
    t.net += f.amount;
    treatments.set("Consultation fees", t);
  }
  return { days: [...days.values()], totals, byTreatment: [...treatments.values()].filter((t) => t.net !== 0 || t.procedures).sort((a, b) => b.net - a.net) };
}

// ── Income ───────────────────────────────────────────────────────────────────

export interface IncomeTotals {
  payments: number;
  deposits: number;
  fees: number;
  /** Money paid back (negative). */
  refunds: number;
  net: number;
  /** Net per method (refunds taken off the method they went out by). */
  methods: Partial<Record<PaymentMethodValue, number>>;
  receipts: number;
}

export interface IncomeDay extends IncomeTotals {
  date: string;
  /** The drawer: every branch that took money that day signed it off ("yes"), some ("partly"), none ("no"); null: no money. */
  signedOff: "yes" | "partly" | "no" | null;
}

export interface IncomeReport {
  days: IncomeDay[];
  totals: IncomeTotals;
  /** Methods that moved in the period, in the usual order. */
  methods: { method: PaymentMethodValue; label: string }[];
}

const zeroIncome = (): IncomeTotals => ({ payments: 0, deposits: 0, fees: 0, refunds: 0, net: 0, methods: {}, receipts: 0 });

function addPayment(t: IncomeTotals, p: { kind: PaymentKind; method: PaymentMethod; amount: number }): void {
  const signed = p.kind === "REFUND" ? -p.amount : p.amount;
  if (p.kind === "PAYMENT") t.payments += p.amount;
  else if (p.kind === "DEPOSIT") t.deposits += p.amount;
  else if (p.kind === "CONSULTATION_FEE") t.fees += p.amount;
  else t.refunds -= p.amount;
  t.net += signed;
  t.methods[p.method] = (t.methods[p.method] ?? 0) + signed;
  t.receipts += 1;
}

export async function incomeReport(scope: ReportScope): Promise<IncomeReport> {
  const [payments, closes] = await Promise.all([
    db.payment.findMany({ where: { tenantId: scope.tenantId, deletedAt: null, paidAt: span(scope) }, select: { kind: true, method: true, amount: true, paidAt: true, clinicId: true } }),
    db.dayClose.findMany({ where: { tenantId: scope.tenantId, day: { gte: scope.period.fromKey, lte: scope.period.toKey } }, select: { clinicId: true, day: true } }),
  ]);
  const closed = new Set(closes.map((c) => `${c.clinicId}|${c.day}`));
  const days = new Map(daysOf(scope).map((d) => [d, { date: d, ...zeroIncome(), signedOff: null as IncomeDay["signedOff"] }]));
  const branchesOn = new Map<string, Set<string>>();
  const totals = zeroIncome();
  for (const p of payments) {
    if (!inBranch(scope, p.clinicId)) continue;
    const key = dayOf(scope, p.paidAt);
    const day = days.get(key);
    if (day) addPayment(day, p);
    addPayment(totals, p);
    const branch = branchOf(scope, p.clinicId);
    if (branch) branchesOn.set(key, (branchesOn.get(key) ?? new Set()).add(branch));
  }
  for (const day of days.values()) {
    const branches = [...(branchesOn.get(day.date) ?? [])];
    if (!branches.length) continue;
    const signed = branches.filter((b) => closed.has(`${b}|${day.date}`)).length;
    day.signedOff = signed === branches.length ? "yes" : signed ? "partly" : "no";
  }
  const methods = PAYMENT_METHODS.filter((m) => totals.methods[m] !== undefined).map((method) => ({ method, label: METHOD_LABELS[method] }));
  return { days: [...days.values()], totals, methods };
}

// ── Branches ─────────────────────────────────────────────────────────────────

export interface BranchRow extends ProductionTotals {
  clinicId: string;
  name: string;
  /** Money in, net of refunds. */
  income: number;
  writtenOff: number;
}

/** Every branch side by side (the branch filter does not apply). */
export async function branchReport(scope: ReportScope): Promise<{ rows: BranchRow[]; totals: Omit<BranchRow, "clinicId" | "name"> }> {
  const all = { ...scope, clinicId: null };
  const [charges, fees, payments, writeOffs] = await Promise.all([
    chargesIn(all),
    feesIn(all),
    db.payment.findMany({ where: { tenantId: scope.tenantId, deletedAt: null, paidAt: span(scope) }, select: { kind: true, amount: true, clinicId: true } }),
    db.writeOff.findMany({ where: { tenantId: scope.tenantId, voidedAt: null, writtenOffAt: span(scope) }, select: { amount: true, invoice: { select: { clinicId: true } } } }),
  ]);
  const rows = new Map<string, BranchRow>(scope.clinics.map((c) => [c.id, { clinicId: c.id, name: c.name, ...zeroProduction(), income: 0, writtenOff: 0 }]));
  const totals = { ...zeroProduction(), income: 0, writtenOff: 0 };
  // A branch closed since keeps its own row, so the rows always add up to the total.
  const rowOf = (clinicId: string | null) => {
    if (!clinicId) return undefined;
    let r = rows.get(clinicId);
    if (!r) {
      r = { clinicId, name: "A former branch", ...zeroProduction(), income: 0, writtenOff: 0 };
      rows.set(clinicId, r);
    }
    return r;
  };
  for (const c of charges) {
    const r = rowOf(c.clinicId);
    if (r) addCharge(r, c);
    addCharge(totals, c);
  }
  for (const f of fees) {
    const r = rowOf(f.clinicId);
    if (r) addFee(r, f);
    addFee(totals, f);
  }
  for (const p of payments) {
    const signed = p.kind === "REFUND" ? -p.amount : p.amount;
    const r = rowOf(branchOf(all, p.clinicId));
    if (r) r.income += signed;
    totals.income += signed;
  }
  for (const w of writeOffs) {
    const r = rowOf(w.invoice.clinicId);
    if (r) r.writtenOff += w.amount;
    totals.writtenOff += w.amount;
  }
  return { rows: [...rows.values()], totals };
}

// ── Adjustments ──────────────────────────────────────────────────────────────

export interface AdjustmentRow {
  id: string;
  type: AdjustmentType;
  at: string;
  date: string;
  patientId: string;
  patientName: string;
  description: string;
  /** What it did to the books: negative lowers what is owed or takes money out. */
  amount: number;
  reason: string | null;
  by: string | null;
  /** A receipt, invoice or credit-note number. */
  reference: string | null;
}

export interface AdjustmentsReport {
  rows: AdjustmentRow[];
  totals: Record<AdjustmentType, { count: number; amount: number }>;
}

const discountWords = (key: string | null, note: string | null) => {
  const label = key ? (DISCOUNT_REASON_LABELS[key as DiscountReasonValue] ?? key) : null;
  return label && note ? `${label}: ${note}` : (label ?? note);
};

export async function adjustmentsReport(scope: ReportScope): Promise<AdjustmentsReport> {
  const t = scope.tenantId;
  const [charges, writeOffs, refunds, voided, creditNotes, names] = await Promise.all([
    chargesIn(scope),
    db.writeOff.findMany({
      where: { tenantId: t, voidedAt: null, writtenOffAt: span(scope) },
      select: { id: true, patientId: true, amount: true, reason: true, note: true, writtenOffAt: true, createdById: true, invoice: { select: { number: true, clinicId: true } } },
    }),
    db.payment.findMany({
      where: { tenantId: t, kind: "REFUND", deletedAt: null, paidAt: span(scope) },
      select: { id: true, patientId: true, amount: true, method: true, paidAt: true, note: true, receiptNumber: true, createdById: true, clinicId: true },
    }),
    db.payment.findMany({
      where: { tenantId: t, deletedAt: span(scope) },
      select: { id: true, patientId: true, kind: true, amount: true, method: true, paidAt: true, deletedAt: true, receiptNumber: true, clinicId: true },
    }),
    db.creditNote.findMany({
      where: { tenantId: t, issuedAt: span(scope) },
      select: { id: true, number: true, amount: true, reason: true, issuedAt: true, issuedById: true, clinicId: true, invoice: { select: { number: true, patientId: true } } },
    }),
    namesOf(t),
  ]);
  const voids = voided.filter((p) => inBranch(scope, p.clinicId));
  const voidAudit = voids.length
    ? await db.auditLog.findMany({ where: { tenantId: t, action: "payment.void", entityId: { in: voids.map((v) => v.id) } }, select: { entityId: true, actorId: true, after: true } })
    : [];
  const whyVoided = new Map(voidAudit.map((a) => [a.entityId, { by: a.actorId, reason: (a.after as { reason?: string } | null)?.reason ?? null }]));
  const who = (id: string | null | undefined) => (id ? (names.get(id) ?? null) : null);
  const rows: Omit<AdjustmentRow, "patientName">[] = [];
  for (const c of charges) {
    if (c.kind === "work" && c.procedureDiscount > 0) {
      rows.push({ id: `${c.id}:discount`, type: "DISCOUNT", at: c.chargedAt.toISOString(), date: c.day, patientId: c.patientId, description: c.description, amount: -c.procedureDiscount, reason: discountWords(c.reason, c.note), by: who(c.by), reference: null });
    } else if (c.kind === "discount") {
      rows.push({ id: c.id, type: "DISCOUNT", at: c.chargedAt.toISOString(), date: c.day, patientId: c.patientId, description: c.description, amount: c.amount, reason: discountWords(c.reason, null), by: who(c.by), reference: null });
    } else if (c.kind === "reversal") {
      rows.push({ id: c.id, type: "CANCELLED", at: c.chargedAt.toISOString(), date: c.day, patientId: c.patientId, description: c.description, amount: c.amount, reason: c.cancelReason, by: who(c.by), reference: null });
    }
  }
  for (const w of writeOffs) {
    if (!inBranch(scope, w.invoice.clinicId)) continue;
    const label = WRITE_OFF_REASON_LABELS[w.reason as WriteOffReasonValue] ?? w.reason;
    rows.push({ id: w.id, type: "WRITE_OFF", at: w.writtenOffAt.toISOString(), date: dayOf(scope, w.writtenOffAt), patientId: w.patientId, description: `Written off on invoice ${w.invoice.number ?? ""}`.trim(), amount: -w.amount, reason: w.note ? `${label}: ${w.note}` : label, by: who(w.createdById), reference: w.invoice.number });
  }
  for (const r of refunds) {
    if (!inBranch(scope, r.clinicId)) continue;
    rows.push({ id: r.id, type: "REFUND", at: r.paidAt.toISOString(), date: dayOf(scope, r.paidAt), patientId: r.patientId, description: `Refund, ${METHOD_LABELS[r.method].toLowerCase()}`, amount: -r.amount, reason: r.note, by: who(r.createdById), reference: r.receiptNumber });
  }
  for (const v of voids) {
    const why = whyVoided.get(v.id);
    const kind = v.kind === "REFUND" ? "refund" : v.kind === "DEPOSIT" ? "deposit" : v.kind === "CONSULTATION_FEE" ? "consultation fee" : "payment";
    rows.push({
      id: `${v.id}:void`,
      type: "VOID",
      at: v.deletedAt!.toISOString(),
      date: dayOf(scope, v.deletedAt!),
      patientId: v.patientId,
      description: `Voided ${kind} of ${formatDateInTz(v.paidAt, scope.timezone)}, ${METHOD_LABELS[v.method].toLowerCase()}`,
      amount: v.kind === "REFUND" ? v.amount : -v.amount,
      reason: why?.reason ?? null,
      by: who(why?.by),
      reference: v.receiptNumber,
    });
  }
  for (const n of creditNotes) {
    if (!inBranch(scope, n.clinicId)) continue;
    rows.push({ id: n.id, type: "CREDIT_NOTE", at: n.issuedAt.toISOString(), date: dayOf(scope, n.issuedAt), patientId: n.invoice.patientId, description: `Invoice ${n.invoice.number ?? ""} cancelled: its work can be invoiced again`, amount: -n.amount, reason: n.reason, by: who(n.issuedById), reference: n.number });
  }
  const patients = await patientNames(t, rows.map((r) => r.patientId));
  const typed = scope.filters.type;
  const all = rows
    .map((r) => ({ ...r, patientName: patients.get(r.patientId)?.name ?? "" }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const totals = Object.fromEntries(ADJUSTMENT_TYPES.map((k) => [k, { count: 0, amount: 0 }])) as AdjustmentsReport["totals"];
  for (const r of all) {
    totals[r.type].count += 1;
    totals[r.type].amount += r.amount;
  }
  return { rows: typed ? all.filter((r) => r.type === typed) : all, totals };
}

// ── Balances and invoices ────────────────────────────────────────────────────

export const AGING = ["0–30 days", "31–60 days", "61–90 days", "Over 90 days"] as const;

export interface BalanceRow {
  patientId: string;
  patientName: string;
  phone: string | null;
  /** Owed now (negative: in credit). */
  balance: number;
  dueOnInvoices: number;
  notInvoiced: number;
  credit: number;
  /** What is due on invoices, by how long ago they were issued. */
  aging: [number, number, number, number];
  /** When the oldest invoice with something due was issued. */
  oldestDueAt: string | null;
}

export interface InvoiceRow {
  id: string;
  number: string | null;
  patientId: string;
  patientName: string;
  issuedAt: string;
  status: string;
  total: number;
  paid: number;
  writtenOff: number;
  due: number;
}

export interface BalancesReport {
  asOf: string;
  totals: { owed: number; owing: number; credit: number; inCredit: number; dueOnInvoices: number; notInvoiced: number; aging: [number, number, number, number] };
  rows: BalanceRow[];
  invoices: { issued: number; issuedTotal: number; paid: number; writtenOff: number; due: number; cancelled: number; rows: InvoiceRow[] };
}

const BILLED = ["ISSUED", "PART_PAID", "PAID"] as const;

/**
 * Where every patient's account stands now (the clinic's, whatever the
 * branch: a balance is the patient's), what is due on invoices by age, and
 * the invoices issued in the period (at the branch, when one is chosen).
 */
export async function balancesReport(scope: ReportScope, now: Date = new Date()): Promise<BalancesReport> {
  const t = scope.tenantId;
  const [chargedIds, paidIds, open, unbilled, issued] = await Promise.all([
    db.charge.groupBy({ by: ["patientId"], where: { tenantId: t } }),
    db.payment.groupBy({ by: ["patientId"], where: { tenantId: t, deletedAt: null } }),
    db.invoice.findMany({
      where: { tenantId: t, status: { in: [...OPEN_INVOICE_STATUSES] } },
      select: { patientId: true, issuedAt: true, total: true, allocations: { select: { amount: true } }, writeOffs: { where: { voidedAt: null }, select: { amount: true } } },
    }),
    db.charge.groupBy({ by: ["patientId"], where: { tenantId: t, invoiceLines: { none: { invoice: { status: { in: [...BILLED] } } } } }, _sum: { amount: true } }),
    db.invoice.findMany({
      where: { tenantId: t, issuedAt: span(scope), ...(scope.clinicId ? { clinicId: scope.clinicId } : {}) },
      orderBy: [{ issuedAt: "asc" }, { sequence: "asc" }],
      select: { id: true, number: true, patientId: true, issuedAt: true, status: true, total: true, allocations: { select: { amount: true } }, writeOffs: { where: { voidedAt: null }, select: { amount: true } } },
    }),
  ]);
  const ids = [...new Set([...chargedIds.map((r) => r.patientId), ...paidIds.map((r) => r.patientId)])];
  const [balances, patients] = await Promise.all([patientBalances(db, t, ids), patientNames(t, [...ids, ...issued.map((i) => i.patientId)])]);
  const due = new Map<string, { total: number; aging: [number, number, number, number]; oldest: Date | null }>();
  for (const i of open) {
    const owed = Math.max(0, i.total - i.allocations.reduce((s, a) => s + a.amount, 0) - i.writeOffs.reduce((s, w) => s + w.amount, 0));
    if (!owed) continue;
    const age = i.issuedAt ? Math.floor((now.getTime() - i.issuedAt.getTime()) / 86_400_000) : 0;
    const bucket = age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
    const d = due.get(i.patientId) ?? { total: 0, aging: [0, 0, 0, 0] as [number, number, number, number], oldest: null };
    d.total += owed;
    d.aging[bucket] += owed;
    if (i.issuedAt && (!d.oldest || i.issuedAt < d.oldest)) d.oldest = i.issuedAt;
    due.set(i.patientId, d);
  }
  const notInvoiced = new Map(unbilled.map((r) => [r.patientId, r._sum.amount ?? 0]));
  const rows: BalanceRow[] = [];
  const totals: BalancesReport["totals"] = { owed: 0, owing: 0, credit: 0, inCredit: 0, dueOnInvoices: 0, notInvoiced: 0, aging: [0, 0, 0, 0] };
  for (const id of ids) {
    const balance = balances.get(id) ?? 0;
    const d = due.get(id);
    const dueOnInvoices = d?.total ?? 0;
    const unbilledAmount = notInvoiced.get(id) ?? 0;
    // balance = due on invoices + not invoiced − credit (see ledger.ts)
    const credit = Math.max(0, dueOnInvoices + unbilledAmount - balance);
    if (balance === 0 && dueOnInvoices === 0) continue;
    rows.push({ patientId: id, patientName: patients.get(id)?.name ?? "", phone: patients.get(id)?.phone ?? null, balance, dueOnInvoices, notInvoiced: unbilledAmount, credit, aging: d?.aging ?? [0, 0, 0, 0], oldestDueAt: d?.oldest?.toISOString() ?? null });
    if (balance > 0) {
      totals.owed += balance;
      totals.owing += 1;
    } else if (balance < 0) {
      totals.credit -= balance;
      totals.inCredit += 1;
    }
    totals.dueOnInvoices += dueOnInvoices;
    totals.notInvoiced += unbilledAmount;
    if (d) for (let k = 0; k < 4; k++) totals.aging[k as 0 | 1 | 2 | 3] += d.aging[k as 0 | 1 | 2 | 3];
  }
  rows.sort((a, b) => b.balance - a.balance || a.patientName.localeCompare(b.patientName));
  const invoiceRows: InvoiceRow[] = issued.map((i) => {
    const live = i.status !== "CANCELLED";
    const paid = live ? i.allocations.reduce((s, a) => s + a.amount, 0) : 0;
    const writtenOff = live ? i.writeOffs.reduce((s, w) => s + w.amount, 0) : 0;
    return {
      id: i.id,
      number: i.number,
      patientId: i.patientId,
      patientName: patients.get(i.patientId)?.name ?? "",
      issuedAt: i.issuedAt!.toISOString(),
      status: i.status,
      total: i.total,
      paid,
      writtenOff,
      due: live ? Math.max(0, i.total - paid - writtenOff) : 0,
    };
  });
  const live = invoiceRows.filter((i) => i.status !== "CANCELLED");
  return {
    asOf: now.toISOString(),
    totals,
    rows,
    invoices: {
      issued: invoiceRows.length,
      issuedTotal: live.reduce((s, i) => s + i.total, 0),
      paid: live.reduce((s, i) => s + i.paid, 0),
      writtenOff: live.reduce((s, i) => s + i.writtenOff, 0),
      due: live.reduce((s, i) => s + i.due, 0),
      cancelled: invoiceRows.length - live.length,
      rows: invoiceRows,
    },
  };
}

// ── Procedures ───────────────────────────────────────────────────────────────

export interface ProcedureTrackRow {
  id: string;
  patientId: string;
  patientName: string;
  label: string;
  doctorId: string | null;
  doctorName: string | null;
  status: ProcedureStatusValue;
  performedAt: string;
  stages: number;
  stagesDone: number;
  /** Its price after its own discount. */
  net: number;
  /** Charged so far (net of reversals and invoice discounts). */
  charged: number;
  /** Of what was charged, what is on an issued invoice. */
  invoiced: number;
  notInvoiced: number;
}

export interface ProceduresReport {
  counts: Record<ProcedureStatusValue, number>;
  rows: ProcedureTrackRow[];
}

/** The procedures done (or planned for a day) in the period, and every course still under way. */
export async function proceduresReport(scope: ReportScope): Promise<ProceduresReport> {
  const t = scope.tenantId;
  const [rows, names] = await Promise.all([
    db.procedure.findMany({
      where: { tenantId: t, ...notDeleted, OR: [{ performedAt: span(scope) }, { status: "STARTED" }] },
      orderBy: [{ performedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        status: true,
        performedAt: true,
        price: true,
        discount: true,
        stages: true,
        quantity: true,
        patient: { select: { fullName: true } },
        treatment: { select: { name: true } },
        priceItem: { select: { name: true } },
        appointmentId: true,
        charges: { select: { amount: true, stage: true, reversalOfId: true, invoiceLines: { select: { invoice: { select: { status: true } } } } } },
      },
    }),
    namesOf(t),
  ]);
  // A procedure's branch is its visit's.
  const visitIds = [...new Set(rows.map((p) => p.appointmentId).filter((id): id is string => Boolean(id)))];
  const visitBranch = visitIds.length
    ? new Map((await db.appointment.findMany({ where: { tenantId: t, id: { in: visitIds } }, select: { id: true, clinicId: true } })).map((a) => [a.id, a.clinicId]))
    : new Map<string, string | null>();
  const { status, doctorId } = scope.filters;
  const all: ProcedureTrackRow[] = rows
    .filter((p) => inBranch(scope, p.appointmentId ? (visitBranch.get(p.appointmentId) ?? null) : null))
    .map((p) => {
      const { charged, stagesDone } = summarizeCharges(p.charges);
      const invoiced = p.charges.filter((c) => c.invoiceLines.some((l) => (BILLED as readonly string[]).includes(l.invoice.status))).reduce((s, c) => s + c.amount, 0);
      const name = p.priceItem?.name ?? p.treatment.name;
      return {
        id: p.id,
        patientId: p.patientId,
        patientName: p.patient.fullName,
        label: p.quantity > 1 && p.stages === 1 ? `${name} × ${p.quantity.toLocaleString("en-US")}` : name,
        doctorId: p.doctorId,
        doctorName: p.doctorId ? (names.get(p.doctorId) ?? null) : null,
        status: p.status as ProcedureStatusValue,
        performedAt: p.performedAt.toISOString(),
        stages: p.stages,
        stagesDone: p.status === "SIGNED" ? p.stages : stagesDone,
        net: p.price - p.discount,
        charged,
        invoiced,
        notInvoiced: charged - invoiced,
      };
    });
  const counts = Object.fromEntries(PROCEDURE_STATUSES.map((s) => [s, 0])) as Record<ProcedureStatusValue, number>;
  for (const r of all) counts[r.status] += 1;
  const kept = all.filter((r) => (!status || r.status === status) && (!doctorId || (doctorId === "none" ? r.doctorId === null : r.doctorId === doctorId)));
  return { counts, rows: kept };
}

// ── Providers ────────────────────────────────────────────────────────────────

export interface ProviderRow extends ProductionTotals {
  doctorId: string | null;
  name: string;
  /** Money put towards their work (as invoices are paid, shared over the invoice's lines) and their consultation fees. */
  collected: number;
  /** Written off on their work, shared the same way. */
  writtenOff: number;
}

/** Shares of an invoice by doctor: the doctor's lines (their work, less its invoice discounts) over the invoice. */
async function invoiceShares(tenantId: string, invoiceIds: string[]): Promise<Map<string, Map<string | null, number>>> {
  const out = new Map<string, Map<string | null, number>>();
  if (!invoiceIds.length) return out;
  const lines = await db.invoiceLine.findMany({ where: { tenantId, invoiceId: { in: invoiceIds } }, select: { invoiceId: true, amount: true, charge: { select: { doctorId: true } } } });
  for (const l of lines) {
    const byDoctor = out.get(l.invoiceId) ?? new Map<string | null, number>();
    byDoctor.set(l.charge.doctorId, (byDoctor.get(l.charge.doctorId) ?? 0) + l.amount);
    out.set(l.invoiceId, byDoctor);
  }
  return out;
}

export async function providersReport(scope: ReportScope): Promise<{ rows: ProviderRow[]; totals: Omit<ProviderRow, "doctorId" | "name"> }> {
  const t = scope.tenantId;
  const [charges, fees, allocations, writeOffs, names] = await Promise.all([
    chargesIn(scope),
    feesIn(scope),
    db.paymentAllocation.findMany({
      where: {
        tenantId: t,
        payment: { deletedAt: null, paidAt: { lt: scope.period.to } },
        invoice: { issuedAt: { lt: scope.period.to }, ...(scope.clinicId ? { clinicId: scope.clinicId } : {}) },
        OR: [{ payment: { paidAt: { gte: scope.period.from } } }, { invoice: { issuedAt: { gte: scope.period.from } } }],
      },
      select: { amount: true, invoiceId: true, payment: { select: { paidAt: true } }, invoice: { select: { issuedAt: true } } },
    }),
    db.writeOff.findMany({ where: { tenantId: t, voidedAt: null, writtenOffAt: span(scope), ...(scope.clinicId ? { invoice: { clinicId: scope.clinicId } } : {}) }, select: { amount: true, invoiceId: true } }),
    namesOf(t),
  ]);
  // Money is put towards an invoice once both are there: the later of the payment and the issue.
  const applied = allocations.filter((a) => Math.max(a.payment.paidAt.getTime(), a.invoice.issuedAt!.getTime()) >= scope.period.from.getTime());
  const shares = await invoiceShares(t, [...new Set([...applied.map((a) => a.invoiceId), ...writeOffs.map((w) => w.invoiceId)])]);
  const rows = new Map<string, ProviderRow>();
  const rowOf = (doctorId: string | null) => {
    const key = doctorId ?? "none";
    let r = rows.get(key);
    if (!r) {
      r = { doctorId, name: doctorId ? (names.get(doctorId) ?? "Unknown doctor") : "No doctor", ...zeroProduction(), collected: 0, writtenOff: 0 };
      rows.set(key, r);
    }
    return r;
  };
  const totals = { ...zeroProduction(), collected: 0, writtenOff: 0 };
  for (const c of charges) {
    addCharge(rowOf(c.doctorId), c);
    addCharge(totals, c);
  }
  for (const f of fees) {
    const r = rowOf(f.doctorId);
    addFee(r, f);
    r.collected += f.amount;
    addFee(totals, f);
    totals.collected += f.amount;
  }
  for (const a of applied) {
    for (const [doctorId, amount] of splitByWeight(a.amount, shares.get(a.invoiceId) ?? new Map([[null, 1]]))) rowOf(doctorId).collected += amount;
    totals.collected += a.amount;
  }
  for (const w of writeOffs) {
    for (const [doctorId, amount] of splitByWeight(w.amount, shares.get(w.invoiceId) ?? new Map([[null, 1]]))) rowOf(doctorId).writtenOff += amount;
    totals.writtenOff += w.amount;
  }
  return { rows: [...rows.values()].sort((a, b) => (a.doctorId === null ? 1 : 0) - (b.doctorId === null ? 1 : 0) || b.net - a.net), totals };
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const PRODUCTION_HEADERS = ["Gross production (EGP)", "Discounts (EGP)", "Cancelled work (EGP)", "Consultation fees (EGP)", "Net production (EGP)", "Procedures and sessions"];
const productionCells = (p: ProductionTotals): CsvCell[] => [p.gross, p.discounts, p.cancelled, p.fees, p.net, p.procedures];

/** A report as CSV (every row, the filters applied), with its file name. */
export async function financeReportCsv(scope: ReportScope, key: FinanceReportKey): Promise<{ filename: string; csv: string }> {
  const filename = `${key}-${scope.period.fromKey}-to-${scope.period.toKey}.csv`;
  const date = (iso: string) => formatDateInTz(new Date(iso), scope.timezone);
  if (key === "income") {
    const r = await incomeReport(scope);
    const methods = PAYMENT_METHODS.filter((m) => r.totals.methods[m] !== undefined);
    const cells = (x: IncomeTotals): CsvCell[] => [x.payments, x.deposits, x.fees, x.refunds, x.net, ...methods.map((m) => x.methods[m] ?? 0), x.receipts];
    return {
      filename,
      csv: toCsv(
        ["Date", "Payments (EGP)", "Deposits (EGP)", "Consultation fees (EGP)", "Refunds (EGP)", "Net income (EGP)", ...methods.map((m) => `${METHOD_LABELS[m]} (EGP)`), "Receipts", "Signed off"],
        [...r.days.map((d) => [d.date, ...cells(d), d.signedOff ?? ""]), ["Total", ...cells(r.totals), ""]],
      ),
    };
  }
  if (key === "production") {
    const r = await productionReport(scope);
    return { filename, csv: toCsv(["Date", ...PRODUCTION_HEADERS], [...r.days.map((d) => [d.date, ...productionCells(d)]), ["Total", ...productionCells(r.totals)]]) };
  }
  if (key === "branches") {
    const r = await branchReport(scope);
    const cells = (x: Omit<BranchRow, "clinicId" | "name">): CsvCell[] => [...productionCells(x), x.income, x.writtenOff];
    return { filename, csv: toCsv(["Branch", ...PRODUCTION_HEADERS, "Income (EGP)", "Written off (EGP)"], [...r.rows.map((b) => [b.name, ...cells(b)]), ["Total", ...cells(r.totals)]]) };
  }
  if (key === "adjustments") {
    const r = await adjustmentsReport(scope);
    return {
      filename,
      csv: toCsv(
        ["Date", "Type", "Patient", "What", "Amount (EGP)", "Reason", "By", "Reference"],
        r.rows.map((a) => [date(a.at), ADJUSTMENT_LABELS[a.type], a.patientName, a.description, a.amount, a.reason, a.by, a.reference]),
      ),
    };
  }
  if (key === "balances") {
    const r = await balancesReport(scope);
    return {
      filename: `balances-${dateKeyInTz(new Date(r.asOf), scope.timezone)}.csv`,
      csv: toCsv(
        ["Patient", "Phone", "Balance (EGP)", "Due on invoices (EGP)", "Not invoiced (EGP)", "Credit (EGP)", ...AGING.map((a) => `Due ${a} (EGP)`)],
        r.rows.map((b) => [b.patientName, b.phone, b.balance, b.dueOnInvoices, b.notInvoiced, b.credit, ...b.aging]),
      ),
    };
  }
  if (key === "procedures") {
    const r = await proceduresReport(scope);
    return {
      filename,
      csv: toCsv(
        ["Date", "Patient", "Procedure", "Doctor", "Status", "Sessions done", "Sessions", "Price after discount (EGP)", "Charged (EGP)", "Invoiced (EGP)", "Not invoiced (EGP)"],
        r.rows.map((p) => [date(p.performedAt), p.patientName, p.label, p.doctorName, PROCEDURE_STATUS_LABELS[p.status], p.stagesDone, p.stages, p.net, p.charged, p.invoiced, p.notInvoiced]),
      ),
    };
  }
  const r = await providersReport(scope);
  const cells = (x: Omit<ProviderRow, "doctorId" | "name">): CsvCell[] => [...productionCells(x), x.collected, x.writtenOff];
  return { filename, csv: toCsv(["Doctor", ...PRODUCTION_HEADERS, "Collected (EGP)", "Written off (EGP)"], [...r.rows.map((p) => [p.name, ...cells(p)]), ["Total", ...cells(r.totals)]]) };
}

// ── Any report ───────────────────────────────────────────────────────────────

/** One report with the period and branch it covers (the API's JSON). */
export async function financeReport(scope: ReportScope, key: FinanceReportKey) {
  const base = { report: key, period: { preset: scope.period.preset, from: scope.period.fromKey, to: scope.period.toKey }, clinicId: scope.clinicId, timezone: scope.timezone };
  switch (key) {
    case "income":
      return { ...base, ...(await incomeReport(scope)) };
    case "production":
      return { ...base, ...(await productionReport(scope)) };
    case "branches":
      return { ...base, ...(await branchReport(scope)) };
    case "adjustments":
      return { ...base, ...(await adjustmentsReport(scope)) };
    case "balances":
      return { ...base, ...(await balancesReport(scope)) };
    case "procedures":
      return { ...base, ...(await proceduresReport(scope)) };
    case "providers":
      return { ...base, ...(await providersReport(scope)) };
  }
}

export const isFinanceReport = (key: unknown): key is FinanceReportKey => typeof key === "string" && (FINANCE_REPORTS as readonly string[]).includes(key);
