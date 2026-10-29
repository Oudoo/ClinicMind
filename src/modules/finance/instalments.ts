import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { addDays, dateKeyInTz, formatDateInTz, fromDateKey, startOfDayInTz } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { sendPatientMessage } from "@/modules/messaging/outbound";
import { isQuiet, readReminderSettings } from "@/modules/messaging/reminder-settings";
import { notify } from "@/modules/notifications/service";
import { payableBy } from "./allocations";
import { MAX_AMOUNT, netPaid } from "./constants";
import { FinanceError } from "./errors";
import {
  coverInstalments,
  DEFAULT_REMINDER_DAYS,
  INSTALMENT_INTERVALS,
  MAX_INSTALMENTS,
  planPosition,
  scheduleOf,
  type CoveredInstalment,
  type PlanPosition,
} from "./instalment-schedule";

/**
 * Instalment plans: a patient pays for treatment over time (an implant,
 * braces, a hair transplant, a laser course). The plan is a down payment and
 * so many instalments every so many months from a first day, in whole
 * pounds; its schedule never changes (the database refuses it), and a plan
 * is never deleted, only cancelled with a reason. Payments recorded towards
 * the plan (by the patient, or the head of their family) cover its
 * instalments in order, the down payment first; the plan completes when
 * they are all covered, and opens again if a payment is voided. A WhatsApp
 * reminder goes before each instalment is due and one the day after it
 * when it is still owed, in the patient's language, never in the quiet
 * hours or to a patient who said no; the desk is told what became overdue
 * and has the list. Plans do not change what is invoiced: the money goes to
 * invoices as any payment does.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id?: string | null; email?: string | null; ip?: string | null };

const zDayKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const InstalmentPlanInput = z
  .object({
    patientId: zText(64).min(1),
    /** The accepted treatment plan it pays for. */
    quoteId: zOptionalText(64),
    title: zText(120).min(2, "Say what the plan pays for"),
    total: z.number().int().positive().max(MAX_AMOUNT),
    downPayment: z.number().int().min(0).max(MAX_AMOUNT).default(0),
    count: z.number().int().min(1).max(MAX_INSTALMENTS),
    everyMonths: z
      .number()
      .int()
      .refine((n) => (INSTALMENT_INTERVALS as readonly number[]).includes(n), "Every 1, 2, 3 or 6 months")
      .default(1),
    /** The first instalment's day (YYYY-MM-DD, clinic clock). */
    firstDue: zDayKey,
    reminderDays: z.number().int().min(0).max(14).default(DEFAULT_REMINDER_DAYS),
    note: zOptionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.downPayment >= v.total) ctx.addIssue({ code: "custom", path: ["downPayment"], message: "The down payment is part of the total: less than it" });
    else if (v.total - v.downPayment < v.count) ctx.addIssue({ code: "custom", path: ["count"], message: "Fewer instalments: each is at least 1 EGP" });
  });

export const InstalmentCancelInput = z.object({ reason: zText(300).min(3, "Say why the plan is stopped") });

export const INSTALMENT_VIEWS = ["overdue", "due", "active", "completed", "cancelled"] as const;
export type InstalmentView = (typeof INSTALMENT_VIEWS)[number];

export const InstalmentListQuery = z.object({
  patientId: zOptionalText(64),
  /** With patientId: the plans that patient's payments can go towards (a family head's include the members'). */
  payable: z.preprocess((v) => v === "1" || v === "true" || v === true, z.boolean()).default(false),
  view: z.enum(INSTALMENT_VIEWS).default("active"),
  q: zOptionalText(60),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export class InstalmentPlanNotFoundError extends FinanceError {
  constructor(id: string) {
    super(404, "not_found", `instalment plan ${id} not found in tenant`, { entity: "instalment_plan" });
    this.name = "InstalmentPlanNotFoundError";
  }
}

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface InstalmentDTO extends Omit<CoveredInstalment, "dueKey"> {
  id: string;
  dueKey: string;
  paidAt: string | null;
  remindedAt: string | null;
  overdueRemindedAt: string | null;
}

export interface InstalmentPlanDTO {
  id: string;
  title: string;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  total: number;
  downPayment: number;
  everyMonths: number;
  reminderDays: number;
  /** Instalments after the down payment. */
  count: number;
  note: string | null;
  createdAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  timezone: string;
  patient: { id: string; fullName: string; phone: string | null; reminderConsent: boolean };
  quote: { id: string; number: string | null } | null;
  instalments: InstalmentDTO[];
  position: PlanPosition;
  payments: { id: string; kind: string; amount: number; paidAt: string; receiptNumber: string | null }[];
}

const planInclude = {
  patient: { select: { id: true, fullName: true, phone: true, whatsapp: true, reminderConsent: true } },
  quote: { select: { id: true, number: true } },
  instalments: { orderBy: { number: "asc" } },
  payments: { where: { deletedAt: null }, orderBy: { paidAt: "asc" }, select: { id: true, kind: true, amount: true, paidAt: true, receiptNumber: true } },
} satisfies Prisma.InstalmentPlanInclude;

type PlanRow = Prisma.InstalmentPlanGetPayload<{ include: typeof planInclude }>;

function toDTO(row: PlanRow, timezone: string, todayKey: string): InstalmentPlanDTO {
  const paid = netPaid(row.payments);
  const scheduled = row.instalments.map((i) => ({ number: i.number, dueKey: dateKeyInTz(i.dueAt, timezone), amount: i.amount }));
  const covered = coverInstalments(scheduled, paid, todayKey, row.reminderDays);
  const byNumber = new Map(row.instalments.map((i) => [i.number, i]));
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    total: row.total,
    downPayment: row.downPayment,
    everyMonths: row.everyMonths,
    reminderDays: row.reminderDays,
    count: row.instalments.filter((i) => i.number > 0).length,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    timezone,
    patient: { id: row.patient.id, fullName: row.patient.fullName, phone: row.patient.whatsapp ?? row.patient.phone, reminderConsent: row.patient.reminderConsent },
    quote: row.quote,
    instalments: covered.map((c) => {
      const i = byNumber.get(c.number)!;
      return { ...c, id: i.id, paidAt: i.paidAt?.toISOString() ?? null, remindedAt: i.remindedAt?.toISOString() ?? null, overdueRemindedAt: i.overdueRemindedAt?.toISOString() ?? null };
    }),
    position: planPosition(row.total, covered),
    payments: row.payments.map((p) => ({ id: p.id, kind: p.kind, amount: p.amount, paidAt: p.paidAt.toISOString(), receiptNumber: p.receiptNumber })),
  };
}

async function load(tenantId: string, id: string, now = new Date(), client: Tx | typeof db = db): Promise<InstalmentPlanDTO> {
  const row = await client.instalmentPlan.findFirst({ where: { id, tenantId }, include: planInclude });
  if (!row) throw new InstalmentPlanNotFoundError(id);
  const timezone = await getTenantTimezone(tenantId);
  return toDTO(row, timezone, dateKeyInTz(now, timezone));
}

export async function getPlan(tenantId: string, id: string): Promise<InstalmentPlanDTO> {
  return load(tenantId, id);
}

/** A patient's plans, with their schedules: the active ones first, then the newest. */
export async function patientPlans(tenantId: string, patientId: string, now = new Date()): Promise<InstalmentPlanDTO[]> {
  const rows = await db.instalmentPlan.findMany({ where: { tenantId, patientId }, include: planInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50 });
  const timezone = await getTenantTimezone(tenantId);
  const todayKey = dateKeyInTz(now, timezone);
  const rank = { ACTIVE: 0, COMPLETED: 1, CANCELLED: 2 } as const;
  return rows.map((r) => toDTO(r, timezone, todayKey)).sort((a, b) => rank[a.status] - rank[b.status]);
}

/** The plans made for an accepted treatment plan, the newest first. */
export async function quotePlans(tenantId: string, quoteId: string, now = new Date()): Promise<InstalmentPlanDTO[]> {
  const rows = await db.instalmentPlan.findMany({ where: { tenantId, quoteId }, include: planInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10 });
  if (!rows.length) return [];
  const timezone = await getTenantTimezone(tenantId);
  const todayKey = dateKeyInTz(now, timezone);
  return rows.map((r) => toDTO(r, timezone, todayKey));
}

// ── Making and stopping a plan ───────────────────────────────────────────────

/** A plan for a patient (or for an accepted treatment plan of theirs): its schedule from its terms. */
export async function createPlan(tenantId: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<InstalmentPlanDTO> {
  const input = InstalmentPlanInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const timezone = await getTenantTimezone(tenantId);
  const todayKey = dateKeyInTz(now, timezone);
  const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, ...notDeleted }, select: { id: true } });
  if (!patient) throw new TenantScopeError("patient", input.patientId);
  if (input.quoteId) {
    const quote = await db.quote.findFirst({ where: { id: input.quoteId, tenantId, patientId: patient.id }, select: { status: true } });
    if (!quote) throw new TenantScopeError("quote", input.quoteId);
    if (quote.status !== "ACCEPTED") throw new FinanceError(409, "invalid_state", "only an accepted treatment plan is paid in instalments", { message: "Only an accepted treatment plan is paid in instalments." });
    const already = await db.instalmentPlan.findFirst({ where: { tenantId, quoteId: input.quoteId, status: { not: "CANCELLED" } }, select: { status: true } });
    if (already) {
      throw new FinanceError(409, "invalid_state", "the treatment plan has an instalment plan already", {
        message: already.status === "ACTIVE" ? "This treatment plan is being paid in instalments already: stop that plan first to make another." : "This treatment plan was paid in full in instalments.",
      });
    }
  }
  const first = fromDateKey(input.firstDue, timezone);
  if (!first) throw new z.ZodError([{ code: "custom", path: ["firstDue"], message: "Not a real date" }]);
  if (input.firstDue < todayKey) throw new z.ZodError([{ code: "custom", path: ["firstDue"], message: "Today or later" }]);
  if (first.getTime() > addDays(startOfDayInTz(now, timezone), 366, timezone).getTime()) throw new z.ZodError([{ code: "custom", path: ["firstDue"], message: "Within a year from today" }]);
  const schedule = scheduleOf({ ...input, startKey: todayKey });
  const dueOf = (key: string) => fromDateKey(key, timezone)!;

  const plan = await db.$transaction(async (tx) => {
    const plan = await tx.instalmentPlan.create({
      data: {
        tenantId,
        patientId: patient.id,
        quoteId: input.quoteId ?? null,
        title: input.title,
        total: input.total,
        downPayment: input.downPayment,
        everyMonths: input.everyMonths,
        reminderDays: input.reminderDays,
        note: input.note ?? null,
        createdById: actor.id ?? null,
        createdAt: now,
        instalments: { create: schedule.map((s) => ({ tenantId, number: s.number, dueAt: dueOf(s.dueKey), amount: s.amount })) },
      },
      select: { id: true },
    });
    const each = schedule.filter((s) => s.number > 0);
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: patient.id,
        kind: "PAYMENT",
        title: `Instalment plan: ${input.title} — ${input.total.toLocaleString("en-US")} EGP`,
        body: `${input.downPayment ? `${input.downPayment.toLocaleString("en-US")} EGP down, then ` : ""}${each.length} × ${each[0]!.amount.toLocaleString("en-US")} EGP${input.everyMonths === 1 ? " a month" : ` every ${input.everyMonths} months`} from ${input.firstDue}`,
        refId: plan.id,
        occurredAt: now,
      },
    });
    return plan;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "instalments.create",
    entity: "InstalmentPlan",
    entityId: plan.id,
    after: { patientId: patient.id, quoteId: input.quoteId ?? null, total: input.total, downPayment: input.downPayment, count: input.count, everyMonths: input.everyMonths, firstDue: input.firstDue },
  });
  return load(tenantId, plan.id, now);
}

/** Stop a plan with a reason: no more reminders; what was paid stays paid. */
export async function cancelPlan(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, opts: { now?: Date } = {}): Promise<InstalmentPlanDTO> {
  const input = InstalmentCancelInput.parse(rawInput);
  const now = opts.now ?? new Date();
  const patientId = await db.$transaction(async (tx) => {
    const plan = await tx.instalmentPlan.findFirst({ where: { id, tenantId }, select: { status: true, patientId: true, title: true } });
    if (!plan) throw new InstalmentPlanNotFoundError(id);
    if (plan.status !== "ACTIVE") throw new FinanceError(409, "invalid_state", `a ${plan.status} plan cannot be cancelled`, { status: plan.status, action: "cancelled", message: plan.status === "COMPLETED" ? "This plan is paid in full." : "This plan is cancelled already." });
    await tx.instalmentPlan.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: actor.id ?? null, cancelReason: input.reason } });
    await tx.timelineEvent.create({ data: { tenantId, patientId: plan.patientId, kind: "PAYMENT", title: `Instalment plan stopped: ${plan.title}`, body: input.reason, refId: id, occurredAt: now } });
    return plan.patientId;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "instalments.cancel", entity: "InstalmentPlan", entityId: id, after: { patientId, reason: input.reason } });
  return load(tenantId, id, now);
}

/**
 * Count the payments towards a plan against its instalments, inside the
 * caller's transaction (a payment recorded or voided): an instalment newly
 * covered in full is stamped paid, one no longer covered loses its stamp, and
 * the plan completes, or opens again.
 */
export async function settlePlan(tx: Tx, tenantId: string, planId: string, now: Date): Promise<void> {
  const plan = await tx.instalmentPlan.findFirst({
    where: { id: planId, tenantId },
    select: { status: true, instalments: { select: { id: true, number: true, amount: true, paidAt: true } }, payments: { where: { deletedAt: null }, select: { kind: true, amount: true } } },
  });
  if (!plan) return;
  // The money covers the instalments in order, the down payment first.
  let left = Math.max(0, netPaid(plan.payments));
  let done = true;
  for (const i of [...plan.instalments].sort((a, b) => a.number - b.number)) {
    const covered = Math.min(left, i.amount);
    left -= covered;
    const paid = covered === i.amount;
    done &&= paid;
    if (paid && !i.paidAt) await tx.instalment.update({ where: { id: i.id }, data: { paidAt: now } });
    else if (!paid && i.paidAt) await tx.instalment.update({ where: { id: i.id }, data: { paidAt: null } });
  }
  if (plan.status === "CANCELLED") return;
  if (done && plan.status !== "COMPLETED") await tx.instalmentPlan.update({ where: { id: planId }, data: { status: "COMPLETED", completedAt: now } });
  else if (!done && plan.status === "COMPLETED") await tx.instalmentPlan.update({ where: { id: planId }, data: { status: "ACTIVE", completedAt: null } });
}

/** The plan a payment goes towards: the patient's own, or a family member's when the payer is the head; active, unless it is a refund. */
export async function requirePlanFor(tx: Tx, tenantId: string, planId: string, patientIds: readonly string[], kind: string): Promise<{ id: string; title: string }> {
  const plan = await tx.instalmentPlan.findFirst({ where: { id: planId, tenantId, patientId: { in: [...patientIds] } }, select: { id: true, title: true, status: true } });
  if (!plan) throw new TenantScopeError("instalment_plan", planId);
  if (kind !== "REFUND" && plan.status !== "ACTIVE") {
    throw new FinanceError(409, "invalid_state", `a ${plan.status} plan takes no more payments`, { status: plan.status, action: "paid", message: plan.status === "COMPLETED" ? "This plan is paid in full." : "This plan was stopped: record the payment without it." });
  }
  return plan;
}

// ── Lists ────────────────────────────────────────────────────────────────────

export interface InstalmentPlanRow {
  id: string;
  title: string;
  status: InstalmentPlanDTO["status"];
  patient: { id: string; fullName: string; phone: string | null; reminderConsent: boolean };
  quote: { id: string; number: string | null } | null;
  total: number;
  position: PlanPosition;
  count: number;
  /** The first instalment still owed that falls due within the week, if any. */
  dueThisWeek: InstalmentDTO | null;
  lastReminderAt: string | null;
}

export interface InstalmentKpis {
  overdue: { plans: number; amount: number };
  dueThisWeek: { plans: number; amount: number };
  active: { plans: number; left: number };
  collectedThisMonth: number;
}

/** A week from today, as a day key: the window of "due this week". */
const weekAheadKey = (now: Date, timezone: string) => dateKeyInTz(addDays(startOfDayInTz(now, timezone), 7, timezone), timezone);

/** The first instalment of a plan still owed that falls due today or within the week. */
const owedWithin = (plan: InstalmentPlanDTO, todayKey: string, weekKey: string) => plan.instalments.find((i) => i.owed > 0 && i.dueKey >= todayKey && i.dueKey <= weekKey) ?? null;

/**
 * Plans by view: overdue (the most days late first), with an instalment
 * falling due within the week (the soonest first; a plan can be overdue and
 * due this week both), active, completed or cancelled (the newest first).
 */
export async function listPlans(tenantId: string, rawQuery: unknown = {}, now = new Date()) {
  const query = InstalmentListQuery.parse(rawQuery);
  const timezone = await getTenantTimezone(tenantId);
  const todayKey = dateKeyInTz(now, timezone);
  const weekKey = weekAheadKey(now, timezone);
  const status = query.view === "completed" ? "COMPLETED" : query.view === "cancelled" ? "CANCELLED" : "ACTIVE";
  const patients = query.patientId && query.payable ? await db.$transaction((tx) => payableBy(tx, tenantId, query.patientId!)) : null;
  const rows = await db.instalmentPlan.findMany({
    where: {
      tenantId,
      status,
      ...(patients ? { patientId: { in: patients } } : query.patientId ? { patientId: query.patientId } : {}),
      ...(query.q ? { OR: [{ title: { contains: query.q, mode: "insensitive" } }, { patient: { fullName: { contains: query.q, mode: "insensitive" } } }] } : {}),
    },
    include: planInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 1000,
  });
  let plans = rows.map((r) => toDTO(r, timezone, todayKey));
  if (query.view === "overdue") plans = plans.filter((p) => p.position.overdue > 0).sort((a, b) => b.position.daysLate - a.position.daysLate || b.position.overdue - a.position.overdue);
  if (query.view === "due") {
    plans = plans
      .filter((p) => owedWithin(p, todayKey, weekKey))
      .sort((a, b) => owedWithin(a, todayKey, weekKey)!.dueKey.localeCompare(owedWithin(b, todayKey, weekKey)!.dueKey) || a.patient.fullName.localeCompare(b.patient.fullName));
  }
  const total = plans.length;
  const page = plans.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  return {
    plans: page.map(
      (p): InstalmentPlanRow => ({
        id: p.id,
        title: p.title,
        status: p.status,
        patient: p.patient,
        quote: p.quote,
        total: p.total,
        position: p.position,
        count: p.count,
        dueThisWeek: p.status === "ACTIVE" ? owedWithin(p, todayKey, weekKey) : null,
        lastReminderAt: p.instalments.flatMap((i) => [i.remindedAt, i.overdueRemindedAt]).filter((d): d is string => Boolean(d)).sort().pop() ?? null,
      }),
    ),
    total,
    page: query.page,
    pageSize: query.pageSize,
    timezone,
  };
}

/** The desk's figures: what is overdue, what falls due this week, what the active plans still have to pay, what was paid towards plans this month. */
export async function instalmentKpis(tenantId: string, now = new Date()): Promise<InstalmentKpis> {
  const timezone = await getTenantTimezone(tenantId);
  const todayKey = dateKeyInTz(now, timezone);
  const monthStart = fromDateKey(`${todayKey.slice(0, 8)}01`, timezone)!;
  const [rows, collected] = await Promise.all([
    db.instalmentPlan.findMany({ where: { tenantId, status: "ACTIVE" }, include: planInclude, take: 2000 }),
    db.payment.findMany({ where: { tenantId, deletedAt: null, instalmentPlanId: { not: null }, paidAt: { gte: monthStart } }, select: { kind: true, amount: true } }),
  ]);
  const plans = rows.map((r) => toDTO(r, timezone, todayKey));
  const weekKey = weekAheadKey(now, timezone);
  const dueThisWeek = plans.flatMap((p) => p.instalments.filter((i) => i.owed > 0 && i.dueKey >= todayKey && i.dueKey <= weekKey).map((i) => ({ plan: p.id, owed: i.owed })));
  return {
    overdue: { plans: plans.filter((p) => p.position.overdue > 0).length, amount: plans.reduce((s, p) => s + p.position.overdue, 0) },
    dueThisWeek: { plans: new Set(dueThisWeek.map((d) => d.plan)).size, amount: dueThisWeek.reduce((s, d) => s + d.owed, 0) },
    active: { plans: plans.length, left: plans.reduce((s, p) => s + p.position.left, 0) },
    collectedThisMonth: netPaid(collected),
  };
}

// ── Reminders ────────────────────────────────────────────────────────────────

type Language = "ar" | "en";
const languageOf = (code: string | null | undefined): Language => (code === "en" ? "en" : "ar");

/** The reminder before an instalment's day, or the one after it, in the patient's language. */
export function instalmentMessage(input: {
  kind: "due" | "overdue";
  language: Language;
  patientName: string;
  clinicName: string;
  clinicPhone: string | null;
  title: string;
  number: number;
  count: number;
  amount: number;
  dueAt: Date;
  timezone: string;
}): string {
  const first = input.patientName.trim().split(/\s+/)[0] || input.patientName;
  const ar = input.language === "ar";
  const day = formatDateInTz(input.dueAt, input.timezone, { weekday: "long", day: "numeric", month: "long" }, ar ? "ar-EG-u-nu-latn" : "en-GB");
  const amount = input.amount.toLocaleString("en-US");
  // In Arabic the plan's name in «», as it may be written in English.
  const which = input.number === 0 ? (ar ? `الدفعة المقدمة لـ«${input.title}»` : `the down payment for your ${input.title}`) : ar ? `القسط ${input.number} من ${input.count} لـ«${input.title}»` : `instalment ${input.number} of ${input.count} for your ${input.title}`;
  const phone = input.clinicPhone ? (ar ? ` على ${input.clinicPhone}` : ` on ${input.clinicPhone}`) : "";
  if (input.kind === "due") {
    return ar
      ? `مرحبًا ${first}، تذكير من ${input.clinicName}: ${which} بقيمة ${amount} جنيه مستحق يوم ${day}. شكرًا لك.`
      : `Hi ${first}, a reminder from ${input.clinicName}: ${which}, ${amount} EGP, is due on ${day}. Thank you.`;
  }
  return ar
    ? `مرحبًا ${first}، ${which} بقيمة ${amount} جنيه كان مستحقًا يوم ${day} ولم يُسدَّد بعد. يمكنك السداد في العيادة، أو الاتصال بنا${phone} إذا احتجت ترتيبًا آخر.`
    : `Hi ${first}, ${which}, ${amount} EGP, was due on ${day} and is still open. You can pay at the clinic, or call us${phone} if you need another arrangement.`;
}

const BATCH = 100;

export interface InstalmentReminderSummary {
  tenants: number;
  reminded: number;
  overdue: number;
  failed: number;
}

/**
 * One pass for every active clinic (or one): the reminder for each
 * instalment within its plan's reminder days (the down payment has none), and
 * for each one owed since yesterday or before (up to 30 days back) the
 * overdue message, once each; the desk and the owner are told what became
 * overdue. Never in the quiet hours (a pass then waits for their end); a
 * patient who said no gets no message, but the desk still hears.
 */
export async function sendInstalmentReminders(now: Date = new Date(), opts: { tenantId?: string } = {}): Promise<InstalmentReminderSummary> {
  const summary: InstalmentReminderSummary = { tenants: 0, reminded: 0, overdue: 0, failed: 0 };
  const tenants = await db.tenant.findMany({ where: { status: "ACTIVE", deletedAt: null, ...(opts.tenantId ? { id: opts.tenantId } : {}) }, select: { id: true, name: true } });
  for (const tenant of tenants) {
    const settings = await readReminderSettings(tenant.id);
    const timezone = await getTenantTimezone(tenant.id);
    summary.tenants += 1;
    if (isQuiet(now, timezone, settings)) continue;
    const today = startOfDayInTz(now, timezone);
    const clinic = await db.clinic.findFirst({ where: { tenantId: tenant.id, ...notDeleted }, orderBy: { createdAt: "asc" }, select: { phone: true } });
    const rows = await db.instalment.findMany({
      where: {
        tenantId: tenant.id,
        paidAt: null,
        plan: { status: "ACTIVE" },
        OR: [
          { remindedAt: null, number: { gt: 0 }, dueAt: { gte: today, lte: addDays(today, 14, timezone) } },
          { overdueRemindedAt: null, dueAt: { lt: today, gte: addDays(today, -30, timezone) } },
        ],
      },
      orderBy: { dueAt: "asc" },
      take: BATCH,
      select: {
        id: true,
        number: true,
        dueAt: true,
        amount: true,
        remindedAt: true,
        overdueRemindedAt: true,
        plan: { select: { id: true, title: true, reminderDays: true, patientId: true, patient: { select: { fullName: true, language: true, reminderConsent: true, phone: true, whatsapp: true } }, instalments: { select: { number: true } } } },
      },
    });
    const late: { title: string; patient: string; amount: number }[] = [];
    for (const i of rows) {
      const overdue = i.dueAt.getTime() < today.getTime();
      if (!overdue && i.dueAt.getTime() > addDays(today, i.plan.reminderDays, timezone).getTime()) continue;
      // Claim first: each message goes once, however many servers run the job.
      const claimed = await db.instalment.updateMany({
        where: { id: i.id, paidAt: null, ...(overdue ? { overdueRemindedAt: null } : { remindedAt: null }) },
        data: overdue ? { overdueRemindedAt: now } : { remindedAt: now },
      });
      if (!claimed.count) continue;
      const owed = await owedOn(tenant.id, i.plan.id, i.number, timezone, now);
      if (owed <= 0) continue;
      if (overdue) {
        summary.overdue += 1;
        late.push({ title: i.plan.title, patient: i.plan.patient.fullName, amount: owed });
      }
      const p = i.plan.patient;
      if (!p.reminderConsent || !(p.whatsapp ?? p.phone)) continue;
      try {
        await sendPatientMessage(tenant.id, {
          patientId: i.plan.patientId,
          body: instalmentMessage({
            kind: overdue ? "overdue" : "due",
            language: languageOf(p.language),
            patientName: p.fullName,
            clinicName: tenant.name,
            clinicPhone: clinic?.phone ?? null,
            title: i.plan.title,
            number: i.number,
            count: i.plan.instalments.filter((x) => x.number > 0).length,
            amount: owed,
            dueAt: i.dueAt,
            timezone,
          }),
          channel: "WHATSAPP",
          templateKey: overdue ? "instalment:overdue" : "instalment:due",
          author: "SYSTEM",
          meta: { instalmentPlanId: i.plan.id, instalment: i.number },
        });
        if (!overdue) summary.reminded += 1;
      } catch (err) {
        summary.failed += 1;
        console.error(`[instalments] reminder for plan ${i.plan.id} failed`, err);
      }
    }
    if (late.length) {
      await notify(tenant.id, {
        kind: "INSTALMENT_OVERDUE",
        level: "WARNING",
        title: late.length === 1 ? `An instalment is overdue: ${late[0]!.patient}` : `${late.length} instalments are overdue`,
        body: late.map((l) => `${l.patient} · ${l.title} · ${l.amount.toLocaleString("en-US")} EGP`).slice(0, 5).join("\n"),
        href: "/dashboard/finance/instalments?view=overdue",
        entity: "InstalmentPlan",
        roles: ["RECEPTIONIST", "CLINIC_OWNER"],
      }).catch((err: unknown) => console.error("[instalments] overdue notification failed", err));
    }
  }
  return summary;
}

/** What is still owed on one instalment of a plan, now. */
async function owedOn(tenantId: string, planId: string, number: number, timezone: string, now: Date): Promise<number> {
  const row = await db.instalmentPlan.findFirst({ where: { id: planId, tenantId }, include: planInclude });
  if (!row) return 0;
  return toDTO(row, timezone, dateKeyInTz(now, timezone)).instalments.find((i) => i.number === number)?.owed ?? 0;
}

/** The desk sends the reminder now (the next instalment owed): not to a patient who said no, nor without a number. */
export async function remindNow(tenantId: string, id: string, actor: Actor = {}): Promise<{ delivery: string; conversationId: string }> {
  const now = new Date();
  const plan = await load(tenantId, id, now);
  if (plan.status !== "ACTIVE") throw new FinanceError(409, "invalid_state", "only an active plan is reminded", { message: "Only an active plan is reminded." });
  const next = plan.position.next;
  if (!next) throw new FinanceError(409, "nothing_owed", "nothing is owed", { message: "Nothing is owed on this plan." });
  if (!plan.patient.reminderConsent) throw new FinanceError(409, "no_consent", "the patient said no to reminders", { message: "The patient asked for no reminders: call them instead." });
  if (!plan.patient.phone) throw new FinanceError(409, "no_phone", "no number", { message: "The patient has no WhatsApp or phone number." });
  const [tenant, clinic, patient] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    db.clinic.findFirst({ where: { tenantId, ...notDeleted }, orderBy: { createdAt: "asc" }, select: { phone: true } }),
    db.patient.findFirst({ where: { id: plan.patient.id, tenantId }, select: { language: true } }),
  ]);
  const instalment = plan.instalments.find((i) => i.number === next.number)!;
  const overdue = next.state === "OVERDUE";
  const sent = await sendPatientMessage(tenantId, {
    patientId: plan.patient.id,
    body: instalmentMessage({
      kind: overdue ? "overdue" : "due",
      language: languageOf(patient?.language),
      patientName: plan.patient.fullName,
      clinicName: tenant?.name ?? "",
      clinicPhone: clinic?.phone ?? null,
      title: plan.title,
      number: next.number,
      count: plan.count,
      amount: next.owed,
      dueAt: fromDateKey(next.dueKey, plan.timezone)!,
      timezone: plan.timezone,
    }),
    channel: "WHATSAPP",
    templateKey: overdue ? "instalment:overdue" : "instalment:due",
    authorId: actor.id ?? null,
    author: "HUMAN",
    meta: { instalmentPlanId: id, instalment: next.number },
  });
  // The automatic one need not follow.
  await db.instalment.update({ where: { id: instalment.id }, data: overdue ? { overdueRemindedAt: now } : { remindedAt: now } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "instalments.remind", entity: "InstalmentPlan", entityId: id, after: { instalment: next.number, owed: next.owed, overdue, delivery: sent.delivery } });
  return { delivery: sent.delivery, conversationId: sent.conversationId };
}
