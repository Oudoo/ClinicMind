import type { Prisma, UserRole } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { MAX_AMOUNT, PAYMENT_METHODS, type PaymentMethodValue } from "./constants";
import { FinanceError } from "./errors";
import { voidExpenseTx } from "./expenses";
import { procedureLabel } from "./charges";
import { splitByWeight } from "./reports";
import {
  CONSULTATIONS,
  describeTerms,
  earnedBy,
  isMonthKey,
  monthLabel,
  monthOfKey,
  PAY_BASES,
  PAY_CATEGORIES,
  payCategoryLabel,
  ruleFor,
  settle,
  shiftMonth,
  type PayBasisValue,
  type PayTerms,
  type WorkToDate,
} from "./doctor-pay-calc";

/**
 * Doctor pay: each doctor's pay per category of the price list (and for
 * consultation fees, and for everything else), as a share of what is billed
 * or of what is collected for their work, or a fixed fee for each session
 * done. The lab's bills and the materials used come off first (the price
 * list's materials for each unit, and costs recorded on the procedure), and
 * a share is never below zero.
 *
 * A month's statement lists, for each piece of the doctor's work, what it
 * had earned by the month's end less what earlier statements paid for it:
 * work billed this month, money collected this month for work done before
 * (an instalment, a late payment), a cost that came in, a cancellation or a
 * refund (which earn less, and take back what was paid) all count in the
 * month they happen. The current month is worked out as it goes; a month
 * that is over is closed by the owner, and from then on it never changes
 * (the database refuses it) but to be marked paid. Statements close in
 * order: closing a month covers any month before it not closed. A doctor's
 * pay counts from the month their first rule was set.
 */

type Actor = { id?: string | null; email?: string | null; ip?: string | null };

/** Who is paid for their work: the owner, the doctors and the nurses. */
export const PAYABLE_ROLES = ["CLINIC_OWNER", "DOCTOR", "NURSE"] as const satisfies readonly UserRole[];

const zDayKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const zMonth = z.string().trim().refine(isMonthKey, "Use YYYY-MM");

export const PayRuleInput = z
  .object({
    doctorId: zText(64).min(1, "Whose pay"),
    category: z.enum(PAY_CATEGORIES),
    basis: z.enum(PAY_BASES),
    /** A share, in percent (37.5). */
    percent: z.number().min(0, "0 to 100").max(100, "0 to 100").optional(),
    /** A fixed fee, EGP a session. */
    amount: z.number().int("Whole EGP").min(0).max(MAX_AMOUNT).optional(),
    deductCosts: z.boolean().default(true),
    note: zOptionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.basis === "FIXED" && v.amount === undefined) ctx.addIssue({ code: "custom", path: ["amount"], message: "How much a session" });
    if (v.basis !== "FIXED" && v.percent === undefined) ctx.addIssue({ code: "custom", path: ["percent"], message: "What share" });
    if (v.percent !== undefined && Math.abs(v.percent * 100 - Math.round(v.percent * 100)) > 1e-6) ctx.addIssue({ code: "custom", path: ["percent"], message: "At most two decimals" });
  });

export const ProcedureCostInput = z.object({
  kind: z.enum(["LAB", "MATERIAL"]),
  description: zText(200).min(2, "Say what it is: the lab's bill, the materials"),
  amount: z.number().int("Whole EGP").positive("More than zero").max(MAX_AMOUNT),
  /** The day of the bill (clinic clock; today when left out). */
  incurredOn: zDayKey.optional(),
});

export const ProcedureCostVoidInput = z.object({ reason: zText(300).min(3, "Say why the cost is voided") });

export const StatementPaidInput = z.object({
  method: z.enum(PAYMENT_METHODS).default("BANK_TRANSFER"),
  reference: zOptionalText(120),
  /** The day it was paid (clinic clock; today when left out). */
  paidOn: zDayKey.optional(),
});

export class PayRuleNotFoundError extends FinanceError {
  constructor(id: string) {
    super(404, "not_found", `pay rule ${id} not found in tenant`, { entity: "pay_rule" });
    this.name = "PayRuleNotFoundError";
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface PayRuleDTO {
  id: string;
  doctorId: string;
  category: string;
  categoryLabel: string;
  basis: PayBasisValue;
  rate: number | null;
  amount: number | null;
  deductCosts: boolean;
  note: string | null;
  terms: string;
  updatedAt: string;
}

export interface PayDoctorDTO {
  id: string;
  fullName: string;
  role: UserRole;
  rules: PayRuleDTO[];
  /** The first month their pay counts (YYYY-MM), from their first rule; null without rules. */
  payFrom: string | null;
}

export interface StatementLineDTO {
  key: string;
  procedureId: string | null;
  feeId: string | null;
  patientId: string;
  patientName: string;
  description: string;
  category: string;
  categoryLabel: string;
  workAt: string;
  /** The rule it is paid under; null when no rule covers it. */
  terms: (PayTerms & { label: string }) | null;
  billedInMonth: number;
  collectedInMonth: number;
  costsInMonth: number;
  billedToDate: number;
  collectedToDate: number;
  costsToDate: number;
  sessionsToDate: number;
  earnedToDate: number;
  paidBefore: number;
  due: number;
}

/** Worked out as it goes; closed by the owner; paid; or paid in a later statement, never closed on its own. */
export type StatementStatus = "OPEN" | "CLOSED" | "PAID" | "COVERED";

export interface StatementDTO {
  id: string | null;
  doctor: { id: string; fullName: string };
  month: string;
  monthLabel: string;
  timezone: string;
  status: StatementStatus;
  /** The later statement that paid this month's work (COVERED). */
  coveredBy: string | null;
  periodStart: string;
  periodEnd: string;
  /** The month is over: it can be closed. */
  ended: boolean;
  payFrom: string | null;
  billed: number;
  collected: number;
  costs: number;
  earned: number;
  broughtForward: number;
  payable: number;
  carriedForward: number;
  lines: StatementLineDTO[];
  /** Lines no rule covers (they earn nothing). */
  unruled: number;
  closedAt: string | null;
  closedBy: string | null;
  paidAt: string | null;
  paidBy: string | null;
  paidMethod: PaymentMethodValue | null;
  paidReference: string | null;
}

export interface ProcedureCostDTO {
  id: string;
  procedureId: string;
  kind: "LAB" | "MATERIAL";
  description: string;
  amount: number;
  incurredAt: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

const nameOf = (u: { fullName: string | null; email: string }) => u.fullName ?? u.email;

function ruleDTO(r: { id: string; doctorId: string; category: string; basis: PayBasisValue; rate: number | null; amount: number | null; deductCosts: boolean; note: string | null; updatedAt: Date }): PayRuleDTO {
  return {
    id: r.id,
    doctorId: r.doctorId,
    category: r.category,
    categoryLabel: payCategoryLabel(r.category),
    basis: r.basis,
    rate: r.rate,
    amount: r.amount,
    deductCosts: r.deductCosts,
    note: r.note,
    terms: describeTerms(r),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ── Rules ────────────────────────────────────────────────────────────────────

/** The month of the first day a doctor's pay counts: their first rule's month, or their first closed statement's if earlier. */
function payFromOf(rules: readonly { createdAt: Date }[], closedMonths: readonly string[], timezone: string): string | null {
  const months = [...rules.map((r) => monthOfKey(dateKeyInTz(r.createdAt, timezone))), ...closedMonths].sort();
  return months[0] ?? null;
}

/** Everyone who can be paid for work (the owner, doctors, nurses), with their rules. */
export async function payDoctors(tenantId: string): Promise<PayDoctorDTO[]> {
  const [users, timezone, statements] = await Promise.all([
    db.user.findMany({
      where: { tenantId, ...notDeleted, status: { not: "DISABLED" }, role: { in: [...PAYABLE_ROLES] } },
      orderBy: [{ role: "asc" }, { fullName: "asc" }],
      select: { id: true, fullName: true, email: true, role: true, payRules: { orderBy: { category: "asc" } } },
    }),
    getTenantTimezone(tenantId),
    db.doctorStatement.findMany({ where: { tenantId }, select: { doctorId: true, month: true } }),
  ]);
  return users.map((u) => ({
    id: u.id,
    fullName: nameOf(u),
    role: u.role,
    rules: u.payRules.map(ruleDTO),
    payFrom: payFromOf(
      u.payRules,
      statements.filter((s) => s.doctorId === u.id).map((s) => s.month),
      timezone,
    ),
  }));
}

async function requirePayable(tenantId: string, doctorId: string) {
  const user = await db.user.findFirst({ where: { id: doctorId, tenantId, ...notDeleted }, select: { id: true, fullName: true, email: true, role: true } });
  if (!user) throw new TenantScopeError("user", doctorId);
  return user;
}

/** Set a doctor's rule for a category (replacing the one there was). */
export async function savePayRule(tenantId: string, rawInput: unknown, actor: Actor = {}): Promise<PayRuleDTO> {
  const input = PayRuleInput.parse(rawInput);
  const doctor = await requirePayable(tenantId, input.doctorId);
  if (!(PAYABLE_ROLES as readonly string[]).includes(doctor.role)) {
    throw new FinanceError(422, "not_payable", "only the owner, doctors and nurses are paid for work", { message: "Pay rules are for the owner, doctors and nurses." });
  }
  const terms = {
    basis: input.basis,
    rate: input.basis === "FIXED" ? null : Math.round((input.percent ?? 0) * 100),
    amount: input.basis === "FIXED" ? (input.amount ?? 0) : null,
    deductCosts: input.basis === "FIXED" ? false : input.deductCosts,
    note: input.note ?? null,
  };
  const before = await db.doctorPayRule.findUnique({ where: { tenantId_doctorId_category: { tenantId, doctorId: doctor.id, category: input.category } } });
  const rule = await db.doctorPayRule.upsert({
    where: { tenantId_doctorId_category: { tenantId, doctorId: doctor.id, category: input.category } },
    create: { tenantId, doctorId: doctor.id, category: input.category, ...terms, createdById: actor.id ?? null, updatedById: actor.id ?? null },
    update: { ...terms, updatedById: actor.id ?? null },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: before ? "doctor_pay.rule_update" : "doctor_pay.rule_create",
    entity: "DoctorPayRule",
    entityId: rule.id,
    before: before ? { doctorId: before.doctorId, category: before.category, basis: before.basis, rate: before.rate, amount: before.amount, deductCosts: before.deductCosts } : undefined,
    after: { doctorId: rule.doctorId, category: rule.category, basis: rule.basis, rate: rule.rate, amount: rule.amount, deductCosts: rule.deductCosts },
  });
  return ruleDTO(rule);
}

export async function deletePayRule(tenantId: string, id: string, actor: Actor = {}): Promise<void> {
  const rule = await db.doctorPayRule.findFirst({ where: { id, tenantId } });
  if (!rule) throw new PayRuleNotFoundError(id);
  await db.doctorPayRule.delete({ where: { id } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "doctor_pay.rule_delete",
    entity: "DoctorPayRule",
    entityId: id,
    before: { doctorId: rule.doctorId, category: rule.category, basis: rule.basis, rate: rule.rate, amount: rule.amount, deductCosts: rule.deductCosts },
  });
}

// ── Procedure costs ──────────────────────────────────────────────────────────

function costDTO(c: { id: string; procedureId: string; kind: "LAB" | "MATERIAL"; description: string; amount: number; incurredAt: Date; createdAt: Date; voidedAt: Date | null; voidReason: string | null }): ProcedureCostDTO {
  return {
    id: c.id,
    procedureId: c.procedureId,
    kind: c.kind,
    description: c.description,
    amount: c.amount,
    incurredAt: c.incurredAt.toISOString(),
    createdAt: c.createdAt.toISOString(),
    voidedAt: c.voidedAt?.toISOString() ?? null,
    voidReason: c.voidReason,
  };
}

/** The costs of procedures (voided ones too, marked), oldest first. */
export async function procedureCosts(tenantId: string, procedureIds: readonly string[]): Promise<Map<string, ProcedureCostDTO[]>> {
  const out = new Map<string, ProcedureCostDTO[]>();
  if (!procedureIds.length) return out;
  const rows = await db.procedureCost.findMany({ where: { tenantId, procedureId: { in: [...procedureIds] } }, orderBy: [{ incurredAt: "asc" }, { createdAt: "asc" }] });
  for (const r of rows) out.set(r.procedureId, [...(out.get(r.procedureId) ?? []), costDTO(r)]);
  return out;
}

/** A lab's bill or materials for a procedure: it comes off the work before the doctor's share. */
export async function addProcedureCost(tenantId: string, procedureId: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<ProcedureCostDTO> {
  const input = ProcedureCostInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const procedure = await db.procedure.findFirst({ where: { id: procedureId, tenantId, ...notDeleted }, select: { id: true, patientId: true } });
  if (!procedure) throw new TenantScopeError("procedure", procedureId);
  const timezone = await getTenantTimezone(tenantId);
  let incurredAt = now;
  if (input.incurredOn) {
    if (input.incurredOn > dateKeyInTz(now, timezone)) throw new z.ZodError([{ code: "custom", path: ["incurredOn"], message: "Not a day ahead" }]);
    const day = fromDateKey(input.incurredOn, timezone);
    if (!day) throw new z.ZodError([{ code: "custom", path: ["incurredOn"], message: "Not a real date" }]);
    // The day of the bill, at noon (today: now).
    incurredAt = input.incurredOn === dateKeyInTz(now, timezone) ? now : new Date(day.getTime() + 12 * 3_600_000);
  }
  const cost = await db.procedureCost.create({
    data: { tenantId, procedureId: procedure.id, kind: input.kind, description: input.description, amount: input.amount, incurredAt, createdById: actor.id ?? null, createdAt: now },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.cost_add",
    entity: "Procedure",
    entityId: procedure.id,
    after: { patientId: procedure.patientId, costId: cost.id, kind: cost.kind, amount: cost.amount, description: cost.description },
  });
  return costDTO(cost);
}

/** Void a cost entered by mistake: it no longer comes off the doctor's share. */
export async function voidProcedureCost(tenantId: string, costId: string, rawInput: unknown, actor: Actor = {}): Promise<ProcedureCostDTO> {
  const input = ProcedureCostVoidInput.parse(rawInput);
  const cost = await db.procedureCost.findFirst({ where: { id: costId, tenantId }, include: { procedure: { select: { patientId: true } } } });
  if (!cost) throw new TenantScopeError("procedure_cost", costId);
  if (cost.voidedAt) throw new FinanceError(409, "invalid_state", "the cost is voided already", { message: "This cost is voided already." });
  const now = new Date();
  const { after, bill } = await db.$transaction(async (tx) => {
    const after = await tx.procedureCost.update({ where: { id: cost.id }, data: { voidedAt: now, voidedById: actor.id ?? null, voidReason: input.reason } });
    // A lab's bill: the expense goes with its cost.
    const order = await tx.labOrder.findFirst({ where: { tenantId, costId: cost.id }, select: { expense: { select: { id: true, voidedAt: true, payments: true } } } });
    const bill = order?.expense && !order.expense.voidedAt ? order.expense : null;
    if (bill) await voidExpenseTx(tx, tenantId, bill, `Its cost on the procedure was voided: ${input.reason}`, actor, now);
    return { after, bill };
  });
  if (bill) await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "expense.void", entity: "Expense", entityId: bill.id, after: { reason: input.reason, via: "procedure.cost_void", costId: cost.id } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.cost_void",
    entity: "Procedure",
    entityId: cost.procedureId,
    after: { patientId: cost.procedure.patientId, costId: cost.id, amount: cost.amount, reason: input.reason },
  });
  return costDTO(after);
}

// ── The work ─────────────────────────────────────────────────────────────────

interface ChargeRow {
  id: string;
  amount: number;
  chargedAt: Date;
  stage: number | null;
  reversalOfId: string | null;
  discountOfId: string | null;
}

interface ProcedureWork {
  kind: "procedure";
  key: string;
  id: string;
  patientId: string;
  patientName: string;
  description: string;
  category: string | null;
  workAt: Date;
  stages: number;
  /** The price list's materials for it (each unit's, times the units). */
  materials: number;
  charges: ChargeRow[];
  collections: { amount: number; at: Date }[];
  costs: { amount: number; incurredAt: Date; voidedAt: Date | null }[];
  /** Given to another doctor since a statement paid for it: it earns this doctor nothing more. */
  moved: boolean;
}

interface FeeWork {
  kind: "fee";
  key: string;
  id: string;
  patientId: string;
  patientName: string;
  description: string;
  workAt: Date;
  amount: number;
  voidedAt: Date | null;
}

type Work = ProcedureWork | FeeWork;

const before = (d: Date, t: Date) => d.getTime() < t.getTime();

/** A piece of work as it stood just before `t`. */
export function workToDate(w: Work, t: Date): WorkToDate {
  if (w.kind === "fee") {
    const counts = before(w.workAt, t) && (!w.voidedAt || !before(w.voidedAt, t));
    return counts ? { billed: w.amount, collected: w.amount, costs: 0, sessions: 1 } : { billed: 0, collected: 0, costs: 0, sessions: 0 };
  }
  const charges = w.charges.filter((c) => before(c.chargedAt, t));
  const billed = charges.reduce((s, c) => s + c.amount, 0);
  const reversed = new Set(charges.filter((c) => c.reversalOfId).map((c) => c.reversalOfId!));
  const work = charges.filter((c) => !c.reversalOfId && !c.discountOfId && !reversed.has(c.id));
  // Signed (the rest charged at once): every session done; else the sessions charged one by one.
  const sessions = work.some((c) => c.stage === null) ? w.stages : work.length;
  const costs = w.costs.filter((c) => before(c.incurredAt, t) && (!c.voidedAt || !before(c.voidedAt, t))).reduce((s, c) => s + c.amount, 0) + (sessions > 0 ? w.materials : 0);
  const collected = w.collections.filter((c) => before(c.at, t)).reduce((s, c) => s + c.amount, 0);
  return { billed, collected, costs, sessions };
}

/**
 * A doctor's work from `from` to `end`: their procedures with work charged
 * in it (the charges, the money put towards them as their invoices were
 * paid, shared over each invoice's lines, and their costs), their
 * consultation fees, and whatever an earlier statement paid for.
 */
async function gatherWork(tenantId: string, doctorId: string, from: Date, end: Date, paidKeys: ReadonlySet<string>): Promise<Work[]> {
  const paidProcedures = [...paidKeys].filter((k) => k.startsWith("p:")).map((k) => k.slice(2));
  const paidFees = [...paidKeys].filter((k) => k.startsWith("f:")).map((k) => k.slice(2));
  const procedures = await db.procedure.findMany({
    where: { tenantId, OR: [{ doctorId, charges: { some: { chargedAt: { gte: from, lt: end } } } }, ...(paidProcedures.length ? [{ id: { in: paidProcedures } }] : [])] },
    select: {
      id: true,
      doctorId: true,
      patientId: true,
      patient: { select: { fullName: true } },
      performedAt: true,
      stages: true,
      quantity: true,
      treatment: { select: { name: true, category: true } },
      priceItem: { select: { name: true, category: true, materialCost: true } },
      charges: { where: { chargedAt: { gte: from, lt: end } }, select: { id: true, amount: true, chargedAt: true, stage: true, reversalOfId: true, discountOfId: true } },
      costs: { where: { incurredAt: { lt: end } }, select: { amount: true, incurredAt: true, voidedAt: true } },
    },
  });

  // The money put towards the work: each allocation to an invoice, from the later of the payment and the issue, shared over the invoice's lines.
  const ours = new Map<string, string>();
  for (const p of procedures) for (const c of p.charges) ours.set(c.id, p.id);
  const collections = new Map<string, { amount: number; at: Date }[]>();
  if (ours.size) {
    const invoiceIds = [...new Set((await db.invoiceLine.findMany({ where: { tenantId, chargeId: { in: [...ours.keys()] } }, select: { invoiceId: true } })).map((l) => l.invoiceId))];
    if (invoiceIds.length) {
      const [lines, allocations] = await Promise.all([
        db.invoiceLine.findMany({ where: { tenantId, invoiceId: { in: invoiceIds } }, select: { invoiceId: true, amount: true, chargeId: true } }),
        db.paymentAllocation.findMany({
          where: { tenantId, invoiceId: { in: invoiceIds }, payment: { deletedAt: null, paidAt: { lt: end } } },
          select: { invoiceId: true, amount: true, payment: { select: { paidAt: true } }, invoice: { select: { issuedAt: true } } },
        }),
      ]);
      const weights = new Map<string, Map<string, number>>();
      for (const l of lines) {
        const key = ours.get(l.chargeId) ?? "other";
        const w = weights.get(l.invoiceId) ?? new Map<string, number>();
        w.set(key, (w.get(key) ?? 0) + l.amount);
        weights.set(l.invoiceId, w);
      }
      for (const a of allocations) {
        const at = new Date(Math.max(a.payment.paidAt.getTime(), (a.invoice.issuedAt ?? a.payment.paidAt).getTime()));
        if (!before(at, end)) continue;
        const positive = new Map([...(weights.get(a.invoiceId) ?? new Map<string, number>())].filter(([, w]) => w > 0));
        for (const [key, amount] of splitByWeight(a.amount, positive)) {
          if (key === "other" || !amount) continue;
          collections.set(key, [...(collections.get(key) ?? []), { amount, at }]);
        }
      }
    }
  }

  const work: Work[] = procedures.map((p) => ({
    kind: "procedure",
    key: `p:${p.id}`,
    id: p.id,
    patientId: p.patientId,
    patientName: p.patient.fullName,
    description: procedureLabel(p),
    // The price list's category, else the treatment's.
    category: p.priceItem?.category ?? p.treatment.category ?? null,
    workAt: p.performedAt,
    stages: Math.max(1, p.stages),
    materials: (p.priceItem?.materialCost ?? 0) * Math.max(1, p.quantity),
    charges: p.charges,
    collections: collections.get(p.id) ?? [],
    costs: p.costs,
    moved: p.doctorId !== doctorId,
  }));

  // Consultation fees: the visit's doctor's (voided ones too: a fee paid for and then voided is taken back).
  const fees = await db.payment.findMany({
    where: { tenantId, kind: "CONSULTATION_FEE", appointmentId: { not: null }, OR: [{ paidAt: { gte: from, lt: end } }, ...(paidFees.length ? [{ id: { in: paidFees } }] : [])] },
    select: { id: true, patientId: true, patient: { select: { fullName: true } }, appointmentId: true, amount: true, paidAt: true, deletedAt: true },
  });
  const visits = fees.length
    ? new Map((await db.appointment.findMany({ where: { tenantId, id: { in: fees.map((f) => f.appointmentId!) } }, select: { id: true, doctorId: true } })).map((a) => [a.id, a.doctorId]))
    : new Map<string, string | null>();
  for (const f of fees) {
    const mine = visits.get(f.appointmentId!) === doctorId;
    if (!mine && !paidKeys.has(`f:${f.id}`)) continue;
    work.push({
      kind: "fee",
      key: `f:${f.id}`,
      id: f.id,
      patientId: f.patientId,
      patientName: f.patient.fullName,
      description: "Consultation fee",
      workAt: f.paidAt,
      amount: mine ? f.amount : 0,
      voidedAt: f.deletedAt,
    });
  }
  return work;
}

// ── Statements ───────────────────────────────────────────────────────────────

const monthStartOf = (month: string, timezone: string) => fromDateKey(`${month}-01`, timezone)!;

type StoredStatement = Prisma.DoctorStatementGetPayload<{ include: { lines: true } }>;

async function namesOf(tenantId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  return new Map((await db.user.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true, fullName: true, email: true } })).map((u) => [u.id, nameOf(u)]));
}

async function storedDTO(s: StoredStatement, doctor: { id: string; fullName: string }, timezone: string, payFrom: string | null): Promise<StatementDTO> {
  const names = await namesOf(s.tenantId, [s.closedById, s.paidById]);
  const lines: StatementLineDTO[] = s.lines
    .sort((a, b) => a.position - b.position)
    .map((l) => ({
      key: l.procedureId ? `p:${l.procedureId}` : `f:${l.feeId}`,
      procedureId: l.procedureId,
      feeId: l.feeId,
      patientId: l.patientId,
      patientName: l.patientName,
      description: l.description,
      category: l.category,
      categoryLabel: payCategoryLabel(l.category),
      workAt: l.workAt.toISOString(),
      terms: l.basis ? { basis: l.basis, rate: l.rate, amount: l.amount, deductCosts: l.deductCosts, label: describeTerms({ basis: l.basis, rate: l.rate, amount: l.amount, deductCosts: l.deductCosts }) } : null,
      billedInMonth: l.billedInMonth,
      collectedInMonth: l.collectedInMonth,
      costsInMonth: l.costsInMonth,
      billedToDate: l.billedToDate,
      collectedToDate: l.collectedToDate,
      costsToDate: l.costsToDate,
      sessionsToDate: l.sessionsToDate,
      earnedToDate: l.earnedToDate,
      paidBefore: l.paidBefore,
      due: l.due,
    }));
  return {
    id: s.id,
    doctor,
    month: s.month,
    monthLabel: monthLabel(s.month),
    timezone,
    status: s.status,
    coveredBy: null,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    ended: true,
    payFrom,
    billed: s.billed,
    collected: s.collected,
    costs: s.costs,
    earned: s.earned,
    broughtForward: s.broughtForward,
    payable: s.payable,
    carriedForward: s.carriedForward,
    lines,
    unruled: lines.filter((l) => !l.terms).length,
    closedAt: s.closedAt.toISOString(),
    closedBy: s.closedById ? (names.get(s.closedById) ?? null) : null,
    paidAt: s.paidAt?.toISOString() ?? null,
    paidBy: s.paidById ? (names.get(s.paidById) ?? null) : null,
    paidMethod: s.paidMethod,
    paidReference: s.paidReference,
  };
}

/**
 * A doctor's statement for a month: the closed one as it was closed, or
 * worked out now from their work (the current month as it goes).
 */
export async function statementFor(tenantId: string, doctorId: string, rawMonth: string, now: Date = new Date()): Promise<StatementDTO> {
  const month = zMonth.parse(rawMonth);
  const user = await requirePayable(tenantId, doctorId);
  const doctor = { id: user.id, fullName: nameOf(user) };
  const timezone = await getTenantTimezone(tenantId);
  const [rules, statements] = await Promise.all([
    db.doctorPayRule.findMany({ where: { tenantId, doctorId } }),
    db.doctorStatement.findMany({ where: { tenantId, doctorId }, orderBy: { month: "asc" }, include: { lines: true } }),
  ]);
  const payFrom = payFromOf(rules, statements.map((s) => s.month), timezone);
  const stored = statements.find((s) => s.month === month);
  if (stored) return storedDTO(stored, doctor, timezone, payFrom);

  const monthStart = monthStartOf(month, timezone);
  const periodEnd = monthStartOf(shiftMonth(month, 1), timezone);
  const closed = statements.filter((s) => s.month < month);
  const later = statements.find((s) => s.month > month);
  const last = closed.at(-1);
  const periodStart = last ? last.periodEnd : payFrom ? monthStartOf(payFrom, timezone) : monthStart;
  const base: StatementDTO = {
    id: null,
    doctor,
    month,
    monthLabel: monthLabel(month),
    timezone,
    status: later ? "COVERED" : "OPEN",
    coveredBy: later?.month ?? null,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    ended: periodEnd.getTime() <= now.getTime(),
    payFrom,
    billed: 0,
    collected: 0,
    costs: 0,
    earned: 0,
    broughtForward: last?.carriedForward ?? 0,
    payable: 0,
    carriedForward: 0,
    lines: [],
    unruled: 0,
    closedAt: null,
    closedBy: null,
    paidAt: null,
    paidBy: null,
    paidMethod: null,
    paidReference: null,
  };
  // Covered by a later statement, before the doctor's pay starts, or not begun yet: nothing to work out.
  if (later || !payFrom || month < payFrom || monthStart.getTime() > now.getTime()) {
    const settled = settle(0, base.broughtForward);
    return { ...base, ...settled };
  }

  const paid = new Map<string, number>();
  for (const s of closed) for (const l of s.lines) {
    const key = l.procedureId ? `p:${l.procedureId}` : `f:${l.feeId}`;
    paid.set(key, (paid.get(key) ?? 0) + l.due);
  }
  const work = await gatherWork(tenantId, doctorId, monthStartOf(payFrom, timezone), periodEnd, new Set(paid.keys()));
  const lines: StatementLineDTO[] = [];
  for (const w of work) {
    const category = w.kind === "fee" ? CONSULTATIONS : w.category;
    const rule = ruleFor(rules, category);
    const end = workToDate(w, periodEnd);
    const start = workToDate(w, monthStart);
    const moved = w.kind === "procedure" && w.moved;
    const earnedToDate = moved ? 0 : earnedBy(rule, end);
    const paidBefore = paid.get(w.key) ?? 0;
    const line: StatementLineDTO = {
      key: w.key,
      procedureId: w.kind === "procedure" ? w.id : null,
      feeId: w.kind === "fee" ? w.id : null,
      patientId: w.patientId,
      patientName: w.patientName,
      description: moved ? `${w.description} (now another doctor's)` : w.description,
      category: category ?? "*",
      categoryLabel: payCategoryLabel(category ?? "*"),
      workAt: w.workAt.toISOString(),
      terms: rule ? { basis: rule.basis, rate: rule.rate, amount: rule.amount, deductCosts: rule.deductCosts, label: describeTerms(rule) } : null,
      billedInMonth: end.billed - start.billed,
      collectedInMonth: end.collected - start.collected,
      costsInMonth: end.costs - start.costs,
      billedToDate: end.billed,
      collectedToDate: end.collected,
      costsToDate: end.costs,
      sessionsToDate: end.sessions,
      earnedToDate,
      paidBefore,
      due: earnedToDate - paidBefore,
    };
    if (line.due !== 0 || line.billedInMonth !== 0 || line.collectedInMonth !== 0 || line.costsInMonth !== 0) lines.push(line);
  }
  lines.sort((a, b) => a.workAt.localeCompare(b.workAt) || a.patientName.localeCompare(b.patientName) || a.key.localeCompare(b.key));
  const earned = lines.reduce((s, l) => s + l.due, 0);
  return {
    ...base,
    billed: lines.reduce((s, l) => s + l.billedInMonth, 0),
    collected: lines.reduce((s, l) => s + l.collectedInMonth, 0),
    costs: lines.reduce((s, l) => s + l.costsInMonth, 0),
    earned,
    ...settle(earned, base.broughtForward),
    lines,
    unruled: lines.filter((l) => !l.terms).length,
  };
}

/** Close a month that is over: its statement is kept as it is now, and never changes but to be marked paid. */
export async function closeStatement(tenantId: string, doctorId: string, rawMonth: string, actor: Actor = {}, opts: { now?: Date } = {}): Promise<StatementDTO> {
  const now = opts.now ?? new Date();
  const s = await statementFor(tenantId, doctorId, rawMonth, now);
  if (s.status === "CLOSED" || s.status === "PAID") throw new FinanceError(409, "invalid_state", "the statement is closed already", { message: `${s.monthLabel} is closed already.` });
  if (s.status === "COVERED") throw new FinanceError(409, "invalid_state", "a later statement covers the month", { message: `${s.monthLabel} was paid in the statement of ${monthLabel(s.coveredBy!)}.` });
  if (!s.payFrom || s.month < s.payFrom) throw new FinanceError(409, "no_rules", "no pay rules for the month", { message: `${s.doctor.fullName} has no pay rules for ${s.monthLabel}.` });
  if (!s.ended) throw new FinanceError(409, "not_ended", "the month is not over", { message: `${s.monthLabel} is not over yet: close it from the 1st of the next month.` });
  const statement = await db
    .$transaction(async (tx) =>
      tx.doctorStatement.create({
        data: {
          tenantId,
          doctorId,
          month: s.month,
          periodStart: new Date(s.periodStart),
          periodEnd: new Date(s.periodEnd),
          status: "CLOSED",
          billed: s.billed,
          collected: s.collected,
          costs: s.costs,
          earned: s.earned,
          broughtForward: s.broughtForward,
          payable: s.payable,
          carriedForward: s.carriedForward,
          closedAt: now,
          closedById: actor.id ?? null,
          lines: {
            create: s.lines.map((l, i) => ({
              tenantId,
              procedureId: l.procedureId,
              feeId: l.feeId,
              patientId: l.patientId,
              patientName: l.patientName,
              description: l.description,
              category: l.category,
              workAt: new Date(l.workAt),
              basis: l.terms?.basis ?? null,
              rate: l.terms?.rate ?? null,
              amount: l.terms?.amount ?? null,
              deductCosts: l.terms?.deductCosts ?? false,
              billedInMonth: l.billedInMonth,
              collectedInMonth: l.collectedInMonth,
              costsInMonth: l.costsInMonth,
              billedToDate: l.billedToDate,
              collectedToDate: l.collectedToDate,
              costsToDate: l.costsToDate,
              sessionsToDate: l.sessionsToDate,
              earnedToDate: l.earnedToDate,
              paidBefore: l.paidBefore,
              due: l.due,
              position: i + 1,
            })),
          },
        },
        select: { id: true },
      }),
    )
    .catch((err: unknown) => {
      if ((err as { code?: string }).code === "P2002") throw new FinanceError(409, "invalid_state", "the statement is closed already", { message: `${s.monthLabel} is closed already.` });
      throw err;
    });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "doctor_pay.close",
    entity: "DoctorStatement",
    entityId: statement.id,
    after: { doctorId, month: s.month, lines: s.lines.length, earned: s.earned, broughtForward: s.broughtForward, payable: s.payable, carriedForward: s.carriedForward },
  });
  return statementFor(tenantId, doctorId, s.month, now);
}

/** The clinic paid a closed statement: how, and the reference. */
export async function markStatementPaid(tenantId: string, doctorId: string, rawMonth: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<StatementDTO> {
  const month = zMonth.parse(rawMonth);
  const input = StatementPaidInput.parse(rawInput ?? {});
  const now = opts.now ?? new Date();
  const statement = await db.doctorStatement.findFirst({ where: { tenantId, doctorId, month } });
  if (!statement) throw new FinanceError(409, "invalid_state", "the statement is not closed", { message: `Close ${monthLabel(month)} first.` });
  if (statement.status === "PAID") throw new FinanceError(409, "invalid_state", "the statement is paid already", { message: `${monthLabel(month)} is paid already.` });
  if (statement.payable <= 0) throw new FinanceError(409, "nothing_to_pay", "nothing to pay", { message: "Nothing is to be paid on this statement." });
  const timezone = await getTenantTimezone(tenantId);
  let paidAt = now;
  if (input.paidOn) {
    if (input.paidOn > dateKeyInTz(now, timezone)) throw new z.ZodError([{ code: "custom", path: ["paidOn"], message: "Not a day ahead" }]);
    const day = fromDateKey(input.paidOn, timezone);
    if (!day) throw new z.ZodError([{ code: "custom", path: ["paidOn"], message: "Not a real date" }]);
    paidAt = input.paidOn === dateKeyInTz(now, timezone) ? now : new Date(day.getTime() + 12 * 3_600_000);
  }
  await db.doctorStatement.update({ where: { id: statement.id }, data: { status: "PAID", paidAt, paidById: actor.id ?? null, paidMethod: input.method, paidReference: input.reference ?? null } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "doctor_pay.paid",
    entity: "DoctorStatement",
    entityId: statement.id,
    after: { doctorId, month, payable: statement.payable, method: input.method, reference: input.reference ?? null },
  });
  return statementFor(tenantId, doctorId, month, now);
}

export interface PayOverviewRow {
  doctor: { id: string; fullName: string; role: UserRole };
  rules: number;
  statement: Omit<StatementDTO, "lines">;
}

/** Every paid doctor's statement for a month, in a line each; and who did work that month with no pay rules. */
export async function payOverview(tenantId: string, rawMonth: string, now: Date = new Date()): Promise<{ month: string; monthLabel: string; rows: PayOverviewRow[]; withoutRules: { id: string; fullName: string }[] }> {
  const month = zMonth.parse(rawMonth);
  const doctors = await payDoctors(tenantId);
  const paid = doctors.filter((d) => d.payFrom);
  const rows: PayOverviewRow[] = [];
  for (const d of paid) {
    const { lines: _lines, ...statement } = await statementFor(tenantId, d.id, month, now);
    void _lines;
    rows.push({ doctor: { id: d.id, fullName: d.fullName, role: d.role }, rules: d.rules.length, statement });
  }
  // Work in the month by someone the clinic has set no pay for.
  const timezone = await getTenantTimezone(tenantId);
  const from = monthStartOf(month, timezone);
  const to = monthStartOf(shiftMonth(month, 1), timezone);
  const unpaid = doctors.filter((d) => !d.payFrom);
  const busy = unpaid.length
    ? new Set(
        (
          await db.charge.findMany({
            where: { tenantId, chargedAt: { gte: from, lt: to }, procedure: { doctorId: { in: unpaid.map((d) => d.id) } } },
            select: { procedure: { select: { doctorId: true } } },
            distinct: ["procedureId"],
          })
        ).map((c) => c.procedure?.doctorId),
      )
    : new Set<string | null | undefined>();
  return { month, monthLabel: monthLabel(month), rows, withoutRules: unpaid.filter((d) => busy.has(d.id)).map((d) => ({ id: d.id, fullName: d.fullName })) };
}
