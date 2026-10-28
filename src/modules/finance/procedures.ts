import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantPatient, requireTenantUser, TenantScopeError } from "@/lib/tenant-scope";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import { requireTenantTreatment } from "@/modules/treatments/service";
import { enrolOnSignedProcedure } from "@/modules/concierge/service";
import { MAX_AMOUNT, PAYMENT_METHODS, PROCEDURE_STATUSES, procedureBalance } from "./constants";
import { FinanceError, ProcedureNotFoundError, ProcedureStateError } from "./errors";
import { priceOn } from "./prices";
import { fromDateKey, startOfDayInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { postCharge, procedureLabel, reverseProcedureCharges, stagePhrase, stageShare, stagesFor, summarizeCharges } from "./charges";

/**
 * Procedures: a treatment planned for or performed on a patient, with its
 * price. Signing a procedure is the clinical act that makes it count as
 * revenue, charges it to the patient and enrols the patient in the concierge
 * protocol of the treatment (`enrolOnSignedProcedure`, owned by the concierge
 * module). Work done in stages (the sessions of a course) is started on a
 * day, each stage is charged its share as it is done and the last one signs
 * it. Every query is tenant-scoped, every client-supplied id is proven to
 * belong to the tenant and every mutation is audited.
 */

type Client = Prisma.TransactionClient;

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

// ── Validation ───────────────────────────────────────────────────────────────

const zId = zText(64).min(1);
const zMoney = z.number().int().min(0).max(MAX_AMOUNT);
const zPositiveMoney = z.number().int().positive().max(MAX_AMOUNT);

/** Optional text where a blank string means "clear" (null) and absence means "keep". */
const zClearableText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), zText(max).nullable().optional());

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const DepositInput = z.object({
  amount: zPositiveMoney,
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  paidAt: zDateTime.optional(),
  reference: zOptionalText(120),
});

export const ProcedureInput = z
  .object({
    patientId: zId,
    /** From the price list: the item and how many of its unit; the price is then the list price on the day unless given. */
    priceItemId: zOptionalText(64),
    quantity: z.number().int().min(1).max(10_000).default(1),
    /** Required without a price-list item; with one, it is the item's treatment. */
    treatmentId: zOptionalText(64),
    doctorId: zOptionalText(64),
    appointmentId: zOptionalText(64),
    performedAt: zDateTime,
    /** Required without a price-list item. */
    price: zMoney.optional(),
    discount: zMoney.default(0),
    notes: zOptionalText(2000),
    /** Why nothing is charged; required when price − discount is 0. */
    zeroChargeReason: zOptionalText(300),
    /** Record a deposit in the same call (requires payments:write at the route). */
    deposit: DepositInput.optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.priceItemId && !v.treatmentId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["treatmentId"], message: "Choose a treatment or a price-list item" });
    }
    if (!v.priceItemId && v.price === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["price"], message: "Enter the price" });
    }
    // Refinements run even when a field already failed; those issues are reported on their own.
    if (isNum(v.price) && isNum(v.discount) && v.discount > v.price) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discount"], message: "Discount cannot exceed the price" });
    }
  });
export type ProcedureInput = z.infer<typeof ProcedureInput>;

export const ProcedureUpdateInput = z
  .object({
    treatmentId: zOptionalText(64),
    doctorId: zClearableText(64),
    appointmentId: zClearableText(64),
    performedAt: zDateTime.optional(),
    price: zMoney.optional(),
    discount: zMoney.optional(),
    notes: zClearableText(2000),
    zeroChargeReason: zClearableText(300),
  })
  .superRefine((v, ctx) => {
    if (isNum(v.price) && isNum(v.discount) && v.discount > v.price) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discount"], message: "Discount cannot exceed the price" });
    }
  });
export type ProcedureUpdateInput = z.infer<typeof ProcedureUpdateInput>;

export const ProcedureCancelInput = z.object({ reason: zText(300).min(1, "A reason is required") });

const zDateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Start work done in stages: the day it started. */
export const ProcedureStartInput = z.object({ startedAt: zDateKey });

/** One stage done: when, by whom, at which visit. */
export const ProcedureStageInput = z.object({
  performedAt: zDateTime,
  doctorId: zOptionalText(64),
  appointmentId: zOptionalText(64),
});

export const ProcedureListQuery = z.object({
  patientId: zOptionalText(64),
  doctorId: zOptionalText(64),
  treatmentId: zOptionalText(64),
  treatmentKey: zOptionalText(64),
  status: z.enum(PROCEDURE_STATUSES).optional(),
  from: zDateTime.optional(),
  to: zDateTime.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type ProcedureListQuery = z.infer<typeof ProcedureListQuery>;

// ── Shapes ───────────────────────────────────────────────────────────────────

const procedureInclude = {
  patient: { select: { id: true, fullName: true } },
  treatment: { select: { id: true, key: true, name: true } },
  priceItem: { select: { id: true, code: true, name: true, unit: true, unitLabel: true, sessions: true } },
  payments: { where: { deletedAt: null }, select: { id: true, kind: true, amount: true, method: true, paidAt: true, reference: true, note: true } },
  charges: { select: { amount: true, stage: true, reversalOfId: true } },
} as const;

/** What charging a procedure reads. */
const chargeableInclude = {
  treatment: { select: { name: true } },
  priceItem: { select: { name: true } },
  charges: { select: { amount: true, stage: true, reversalOfId: true } },
} as const;

type ProcedureRecord = Prisma.ProcedureGetPayload<{ include: typeof procedureInclude }>;

export interface PersonSummary {
  id: string;
  fullName: string;
}

export type ProcedureView = ProcedureRecord & {
  doctor: PersonSummary | null;
  signedBy: PersonSummary | null;
  paid: number;
  balance: number;
  /** Charged so far (stages done, or the whole procedure once signed), net of reversals. */
  charged: number;
  stagesDone: number;
};

/** Resolve user names (doctor, signer) in one tenant-scoped lookup. */
async function attachPeople(tenantId: string, rows: ProcedureRecord[], client: Client = db): Promise<ProcedureView[]> {
  const ids = new Set<string>();
  for (const r of rows) {
    if (r.doctorId) ids.add(r.doctorId);
    if (r.signedById) ids.add(r.signedById);
  }
  const users = ids.size
    ? await client.user.findMany({ where: { tenantId, id: { in: [...ids] } }, select: { id: true, fullName: true, email: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, { id: u.id, fullName: u.fullName ?? u.email }]));
  return rows.map((r) => {
    const paid = r.payments.reduce((s, p) => s + (p.kind === "REFUND" ? -p.amount : p.amount), 0);
    return {
      ...r,
      doctor: r.doctorId ? (byId.get(r.doctorId) ?? null) : null,
      signedBy: r.signedById ? (byId.get(r.signedById) ?? null) : null,
      paid,
      balance: procedureBalance(r.price, r.discount, r.payments),
      ...summarizeCharges(r.charges),
    };
  });
}

/** The procedure must exist, be unarchived and belong to `tenantId` (404 otherwise). */
export async function requireTenantProcedure(tenantId: string, id: string, client: Client = db) {
  const row = await client.procedure.findFirst({
    where: { id, tenantId, ...notDeleted },
    select: { id: true, patientId: true, status: true, treatmentId: true },
  });
  if (!row) throw new TenantScopeError("procedure", id);
  return row;
}

/** The appointment must belong to the tenant (and to the patient when given). */
export async function requireTenantAppointment(tenantId: string, id: string, patientId?: string, client: Client = db) {
  const row = await client.appointment.findFirst({
    where: { id, tenantId, ...notDeleted, ...(patientId ? { patientId } : {}) },
    select: { id: true, patientId: true, doctorId: true, clinicId: true, startsAt: true },
  });
  if (!row) throw new TenantScopeError("appointment", id);
  return row;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listProcedures(tenantId: string, query: ProcedureListQuery) {
  const where: Prisma.ProcedureWhereInput = {
    tenantId,
    ...notDeleted,
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.doctorId ? { doctorId: query.doctorId } : {}),
    ...(query.treatmentId ? { treatmentId: query.treatmentId } : {}),
    ...(query.treatmentKey ? { treatment: { key: query.treatmentKey } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to ? { performedAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } } : {}),
  };
  const skip = (query.page - 1) * query.pageSize;
  const [rows, total] = await db.$transaction([
    db.procedure.findMany({ where, orderBy: [{ performedAt: "desc" }, { createdAt: "desc" }], skip, take: query.pageSize, include: procedureInclude }),
    db.procedure.count({ where }),
  ]);
  return { procedures: await attachPeople(tenantId, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getProcedure(tenantId: string, id: string): Promise<ProcedureView | null> {
  const row = await db.procedure.findFirst({ where: { id, tenantId, ...notDeleted }, include: procedureInclude });
  if (!row) return null;
  const [view] = await attachPeople(tenantId, [row]);
  return view ?? null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

function snapshot(p: {
  patientId: string;
  treatmentId: string;
  priceItemId?: string | null;
  quantity?: number;
  stages?: number;
  zeroChargeReason?: string | null;
  doctorId: string | null;
  appointmentId: string | null;
  performedAt: Date;
  price: number;
  discount: number;
  status: string;
  notes: string | null;
}) {
  return {
    patientId: p.patientId,
    treatmentId: p.treatmentId,
    priceItemId: p.priceItemId ?? null,
    quantity: p.quantity ?? 1,
    stages: p.stages ?? 1,
    zeroChargeReason: p.zeroChargeReason ?? null,
    doctorId: p.doctorId,
    appointmentId: p.appointmentId,
    performedAt: p.performedAt.toISOString(),
    price: p.price,
    discount: p.discount,
    status: p.status,
    notes: p.notes,
  };
}

/**
 * What a price-list item makes of a procedure: its treatment and, unless the
 * caller set one, the price on the day (the branch's own when the visit is at
 * a branch) times the quantity.
 */
async function fromPriceList(
  tenantId: string,
  input: { priceItemId: string; quantity: number; treatmentId?: string; price?: number; performedAt: Date },
  clinicId: string | null,
): Promise<{ treatmentId: string; price: number; stages: number }> {
  const item = await db.priceItem.findFirst({ where: { id: input.priceItemId, tenantId }, select: { id: true, treatmentId: true, active: true, name: true, unit: true, sessions: true } });
  if (!item) throw new TenantScopeError("price_item", input.priceItemId);
  if (!item.active) throw new FinanceError(422, "price_item_inactive", `${item.name} is no longer on the price list`, { issues: { fieldErrors: { priceItemId: ["No longer on the price list"] } } });
  if (input.treatmentId && input.treatmentId !== item.treatmentId) {
    throw new z.ZodError([{ code: "custom", path: ["treatmentId"], message: "The price-list item bills for another treatment" }]);
  }
  const stages = stagesFor(item, input.quantity);
  if (input.price !== undefined) return { treatmentId: item.treatmentId, price: input.price, stages };
  const unitPrice = await priceOn(tenantId, item.id, input.performedAt, clinicId);
  if (unitPrice === null) {
    throw new FinanceError(422, "no_price", `${item.name} has no price on that day`, { issues: { fieldErrors: { priceItemId: ["No price on that day: enter one"] } } });
  }
  return { treatmentId: item.treatmentId, price: unitPrice * input.quantity, stages };
}

export async function createProcedure(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const parsed = ProcedureInput.parse(rawInput);

  // Every client-supplied foreign key must belong to the acting tenant (SEC-4).
  await requireTenantPatient(tenantId, parsed.patientId);
  if (parsed.doctorId) await requireTenantUser(tenantId, parsed.doctorId);
  const appointment = parsed.appointmentId ? await requireTenantAppointment(tenantId, parsed.appointmentId, parsed.patientId) : null;
  const priced = parsed.priceItemId
    ? await fromPriceList(tenantId, { ...parsed, priceItemId: parsed.priceItemId }, appointment?.clinicId ?? null)
    : { treatmentId: parsed.treatmentId!, price: parsed.price!, stages: 1 };
  if (parsed.discount > priced.price) {
    throw new z.ZodError([{ code: "custom", path: ["discount"], message: "Discount cannot exceed the price" }]);
  }
  const free = priced.price - parsed.discount === 0;
  if (free && !parsed.zeroChargeReason) throw zeroReasonMissing();
  const input = { ...parsed, ...priced };
  const treatment = await requireTenantTreatment(tenantId, input.treatmentId);

  const { procedure, deposit } = await db.$transaction(async (tx) => {
    const procedure = await tx.procedure.create({
      data: {
        tenantId,
        patientId: input.patientId,
        treatmentId: input.treatmentId,
        priceItemId: input.priceItemId ?? null,
        quantity: input.quantity,
        doctorId: input.doctorId ?? null,
        appointmentId: input.appointmentId ?? null,
        performedAt: input.performedAt,
        price: input.price,
        discount: input.discount,
        stages: input.stages,
        zeroChargeReason: free ? (input.zeroChargeReason ?? null) : null,
        notes: input.notes ?? null,
        status: "PLANNED",
        createdById: actor.id ?? null,
      },
      include: procedureInclude,
    });
    let deposit: { id: string; amount: number } | null = null;
    if (input.deposit) {
      const paidAt = input.deposit.paidAt ?? new Date();
      const payment = await tx.payment.create({
        data: {
          tenantId,
          patientId: input.patientId,
          procedureId: procedure.id,
          appointmentId: input.appointmentId ?? null,
          kind: "DEPOSIT",
          method: input.deposit.method,
          amount: input.deposit.amount,
          paidAt,
          reference: input.deposit.reference ?? null,
          createdById: actor.id ?? null,
        },
        select: { id: true, amount: true },
      });
      await tx.timelineEvent.create({
        data: {
          tenantId,
          patientId: input.patientId,
          kind: "PAYMENT",
          title: `Deposit received — ${payment.amount.toLocaleString("en-US")} EGP`,
          body: `Towards ${treatment.name}`,
          refId: payment.id,
          occurredAt: paidAt,
        },
      });
      deposit = payment;
    }
    return { procedure, deposit };
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.create",
    entity: "Procedure",
    entityId: procedure.id,
    after: { ...snapshot(procedure), deposit: deposit?.amount ?? null },
  });
  if (deposit) {
    await audit({
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      ip: actor.ip,
      action: "payment.record",
      entity: "Payment",
      entityId: deposit.id,
      after: { procedureId: procedure.id, kind: "DEPOSIT", amount: deposit.amount },
    });
  }
  const fresh = await db.procedure.findFirstOrThrow({ where: { id: procedure.id, tenantId }, include: procedureInclude });
  const [view] = await attachPeople(tenantId, [fresh]);
  return view!;
}

/** Only a PLANNED procedure can be edited; signed ones are part of the record. */
export async function updateProcedure(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = ProcedureUpdateInput.parse(rawInput);
  if (input.treatmentId) await requireTenantTreatment(tenantId, input.treatmentId);
  if (input.doctorId) await requireTenantUser(tenantId, input.doctorId);

  const { before, after } = await db.$transaction(async (tx) => {
    const before = await tx.procedure.findFirst({ where: { id, tenantId, ...notDeleted } });
    if (!before) throw new ProcedureNotFoundError(id);
    if (before.status !== "PLANNED") throw new ProcedureStateError(before.status, "edited");
    if (input.appointmentId) await requireTenantAppointment(tenantId, input.appointmentId, before.patientId, tx);
    const price = input.price ?? before.price;
    const discount = input.discount ?? before.discount;
    if (discount > price) {
      throw new z.ZodError([{ code: "custom", path: ["discount"], message: "Discount cannot exceed the price" }]);
    }
    const zeroChargeReason = input.zeroChargeReason === undefined ? before.zeroChargeReason : input.zeroChargeReason;
    if (price - discount === 0 && !zeroChargeReason) throw zeroReasonMissing();
    const after = await tx.procedure.update({
      where: { id, tenantId },
      data: {
        treatmentId: input.treatmentId,
        doctorId: input.doctorId,
        appointmentId: input.appointmentId,
        performedAt: input.performedAt,
        price,
        discount,
        zeroChargeReason: price - discount === 0 ? zeroChargeReason : null,
        notes: input.notes,
      },
      include: procedureInclude,
    });
    return { before, after };
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.update",
    entity: "Procedure",
    entityId: id,
    before: snapshot(before),
    after: snapshot(after),
  });
  const [view] = await attachPeople(tenantId, [after]);
  return view!;
}

// ── Charging ─────────────────────────────────────────────────────────────────

function zeroReasonMissing() {
  return new z.ZodError([{ code: "custom", path: ["zeroChargeReason"], message: "Say why nothing is charged" }]);
}

function issue(path: string, message: string) {
  return new z.ZodError([{ code: "custom", path: [path], message }]);
}

/** The branch an appointment was at. */
async function clinicOf(tx: Client, tenantId: string, appointmentId: string | null): Promise<string | null> {
  if (!appointmentId) return null;
  const row = await tx.appointment.findFirst({ where: { id: appointmentId, tenantId }, select: { clinicId: true } });
  return row?.clinicId ?? null;
}

type Chargeable = Prisma.ProcedureGetPayload<{ include: typeof chargeableInclude }>;

/**
 * Sign inside the caller's transaction: charge what is left (the whole
 * procedure, or the stages not charged yet; a procedure charged nothing gets
 * one row with the reason), mark it signed and write the timeline.
 */
async function signInTx(tx: Client, tenantId: string, before: Chargeable, actor: Actor, now: Date) {
  const net = before.price - before.discount;
  if (net === 0 && !before.zeroChargeReason) throw zeroReasonMissing();
  const doctorId = before.doctorId ?? actor.id ?? null;
  const doctor = doctorId ? await tx.user.findFirst({ where: { id: doctorId, tenantId }, select: { fullName: true, email: true } }) : null;
  const doctorName = doctor ? (doctor.fullName ?? doctor.email) : null;

  const { charged, stagesDone } = summarizeCharges(before.charges);
  const label = procedureLabel(before);
  const left = net - charged;
  if (left !== 0 || before.charges.length === 0) {
    const staged = before.stages > 1;
    await postCharge(tx, {
      tenantId,
      patientId: before.patientId,
      procedureId: before.id,
      appointmentId: before.appointmentId,
      amount: left,
      description: staged ? `${label} · ${stagePhrase(stagesDone + 1, before.stages, before.stages)}` : net === 0 ? `${label} · no charge: ${before.zeroChargeReason}` : label,
      // Work done at once is charged on its day; what was left of staged work, the day it is signed.
      chargedAt: staged ? now : before.performedAt,
      doctorId,
      clinicId: await clinicOf(tx, tenantId, before.appointmentId),
      createdById: actor.id ?? null,
    });
  }
  const after = await tx.procedure.update({
    where: { id: before.id, tenantId },
    data: { status: "SIGNED", signedAt: now, signedById: actor.id ?? null, doctorId },
    include: procedureInclude,
  });
  await tx.timelineEvent.create({
    data: {
      tenantId,
      patientId: before.patientId,
      kind: "PROCEDURE",
      title: doctorName ? `${before.treatment.name} performed by Dr ${doctorName.replace(/^Dr\.?\s+/i, "")}` : `${before.treatment.name} performed`,
      body: `${net.toLocaleString("en-US")} EGP${before.notes ? ` · ${before.notes}` : ""}`,
      refId: before.id,
      occurredAt: before.stages > 1 ? now : before.performedAt,
    },
  });
  return { after, doctorName, from: before.status };
}

/** After a signature: the audit row, and the concierge enrolment (its failure must not undo the signature). */
async function afterSigning(tenantId: string, signed: { after: ProcedureRecord; doctorName: string | null; from: string }, actor: Actor, now: Date) {
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.sign",
    entity: "Procedure",
    entityId: signed.after.id,
    before: { status: signed.from },
    after: { status: "SIGNED", signedAt: now.toISOString(), signedById: actor.id ?? null, doctor: signed.doctorName },
  });
  return enrolOnSignedProcedure(tenantId, signed.after.id, actor).catch((err: unknown) => {
    console.error(`[finance] concierge enrolment failed for procedure ${signed.after.id}`, err);
    return null;
  });
}

/**
 * Sign a procedure: it becomes revenue, is charged to the patient, lands on
 * the timeline and enrols the patient in the treatment's concierge protocol.
 * Work done at once is signed from PLANNED; work done in stages is started
 * first, and signing it early charges the stages left.
 */
export async function signProcedure(tenantId: string, id: string, actor: Actor = {}) {
  const now = new Date();
  const signed = await db.$transaction(async (tx) => {
    const before = await tx.procedure.findFirst({ where: { id, tenantId, ...notDeleted }, include: chargeableInclude });
    if (!before) throw new ProcedureNotFoundError(id);
    if (before.status !== "PLANNED" && before.status !== "STARTED") throw new ProcedureStateError(before.status, "signed");
    if (before.status === "PLANNED" && before.stages > 1) {
      throw new FinanceError(409, "not_started", "staged work is started before it is signed", {
        message: `This is done in ${before.stages} sessions: start it on the day of the first one, then mark each session done.`,
      });
    }
    return signInTx(tx, tenantId, before, actor, now);
  });
  const enrolment = await afterSigning(tenantId, signed, actor, now);
  const [view] = await attachPeople(tenantId, [signed.after]);
  return { procedure: view!, enrolment };
}

/** Start work done in stages, on the day it started (today or earlier). */
export async function startProcedure(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = ProcedureStartInput.parse(rawInput);
  const timezone = await getTenantTimezone(tenantId);
  const startedAt = fromDateKey(input.startedAt, timezone);
  if (!startedAt) throw issue("startedAt", "Not a real date");
  if (startedAt.getTime() > startOfDayInTz(new Date(), timezone).getTime()) throw issue("startedAt", "Today or earlier: the day it started");
  const after = await db.$transaction(async (tx) => {
    const before = await tx.procedure.findFirst({ where: { id, tenantId, ...notDeleted }, include: chargeableInclude });
    if (!before) throw new ProcedureNotFoundError(id);
    if (before.status !== "PLANNED") throw new ProcedureStateError(before.status, "started");
    if (before.stages <= 1) {
      throw new FinanceError(409, "not_staged", "only work done in stages is started", { message: "This is done in one go: sign it once it is done." });
    }
    const after = await tx.procedure.update({
      where: { id, tenantId },
      data: { status: "STARTED", startedAt, startedById: actor.id ?? null },
      include: procedureInclude,
    });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: before.patientId,
        kind: "PROCEDURE",
        title: `${procedureLabel(before)} started`,
        body: `${before.stages} sessions, charged as each is done`,
        refId: before.id,
        occurredAt: startedAt,
      },
    });
    return after;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.start",
    entity: "Procedure",
    entityId: id,
    before: { status: "PLANNED" },
    after: { status: "STARTED", startedAt: input.startedAt, stages: after.stages },
  });
  const [view] = await attachPeople(tenantId, [after]);
  return view!;
}

/**
 * One stage of started work is done: it is charged its share on the day it
 * was done (by whoever did it, at the visit's branch). The last stage signs
 * the procedure.
 */
export async function completeStage(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = ProcedureStageInput.parse(rawInput);
  const performedAt = new Date(input.performedAt);
  const now = new Date();
  if (performedAt.getTime() > now.getTime() + 5 * 60_000) throw issue("performedAt", "Not in the future: mark a session done once it is");
  if (input.doctorId) await requireTenantUser(tenantId, input.doctorId);
  const timezone = await getTenantTimezone(tenantId);

  const result = await db.$transaction(async (tx) => {
    const before = await tx.procedure.findFirst({ where: { id, tenantId, ...notDeleted }, include: chargeableInclude });
    if (!before) throw new ProcedureNotFoundError(id);
    if (before.status !== "STARTED") {
      throw new ProcedureStateError(before.status, before.status === "PLANNED" ? "charged by the session before it is started" : "given another session");
    }
    if (before.startedAt && performedAt.getTime() < startOfDayInTz(before.startedAt, timezone).getTime()) {
      throw issue("performedAt", "Not before the day it started");
    }
    const appointment = input.appointmentId ? await requireTenantAppointment(tenantId, input.appointmentId, before.patientId, tx) : null;
    const { stagesDone } = summarizeCharges(before.charges);
    if (stagesDone >= before.stages) throw new ProcedureStateError(before.status, "given another session");
    const stage = stagesDone + 1;
    const amount = stageShare(before.price - before.discount, before.stages, stage);
    const label = procedureLabel(before);
    const charge = await postCharge(tx, {
      tenantId,
      patientId: before.patientId,
      procedureId: before.id,
      appointmentId: appointment?.id ?? null,
      stage,
      amount,
      description: `${label} · ${stagePhrase(stage, stage, before.stages)}`,
      chargedAt: performedAt,
      doctorId: input.doctorId ?? appointment?.doctorId ?? before.doctorId ?? actor.id ?? null,
      clinicId: appointment?.clinicId ?? (await clinicOf(tx, tenantId, before.appointmentId)),
      createdById: actor.id ?? null,
    });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: before.patientId,
        kind: "PROCEDURE",
        title: `${label}: ${stagePhrase(stage, stage, before.stages)} done`,
        body: `${amount.toLocaleString("en-US")} EGP`,
        refId: before.id,
        occurredAt: performedAt,
      },
    });
    if (stage < before.stages) {
      const after = await tx.procedure.findFirstOrThrow({ where: { id, tenantId }, include: procedureInclude });
      return { stage, of: before.stages, amount, chargeId: charge.id, after, signed: null };
    }
    // The last stage: the work is done.
    const signed = await signInTx(tx, tenantId, { ...before, charges: [...before.charges, { amount, stage, reversalOfId: null }] }, actor, now);
    return { stage, of: before.stages, amount, chargeId: charge.id, after: signed.after, signed };
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.stage",
    entity: "Procedure",
    entityId: id,
    after: { stage: result.stage, of: result.of, amount: result.amount, chargeId: result.chargeId, performedAt: performedAt.toISOString() },
  });
  const enrolment = result.signed ? await afterSigning(tenantId, result.signed, actor, now) : null;
  const [view] = await attachPeople(tenantId, [result.after]);
  return { procedure: view!, stage: result.stage, of: result.of, amount: result.amount, enrolment };
}

/**
 * Cancel a procedure with a reason. Planned or started work needs no
 * clinician; what a started course was already charged stays (those sessions
 * were done). A signed procedure is cancelled only by a clinician
 * (`allowSigned`), and its charges are reversed on the day of the cancellation.
 */
export async function cancelProcedure(
  tenantId: string,
  id: string,
  rawInput: unknown,
  actor: Actor = {},
  opts: { allowSigned?: boolean } = {},
) {
  const input = ProcedureCancelInput.parse(rawInput);
  const now = new Date();
  const { before, after, reversed } = await db.$transaction(async (tx) => {
    const before = await tx.procedure.findFirst({ where: { id, tenantId, ...notDeleted }, include: { treatment: { select: { name: true } } } });
    if (!before) throw new ProcedureNotFoundError(id);
    if (before.status === "CANCELLED") throw new ProcedureStateError(before.status, "cancelled again");
    if (before.status === "SIGNED" && !opts.allowSigned) throw new ProcedureStateError(before.status, "cancelled without a clinician");
    const reversed = before.status === "SIGNED" ? await reverseProcedureCharges(tx, tenantId, id, now, actor.id ?? null) : 0;
    const after = await tx.procedure.update({
      where: { id, tenantId },
      data: { status: "CANCELLED", cancelledAt: now, cancelReason: input.reason },
      include: procedureInclude,
    });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: before.patientId,
        kind: "PROCEDURE",
        title: `${before.treatment.name} cancelled`,
        body: reversed ? `${input.reason} · ${reversed.toLocaleString("en-US")} EGP charge reversed` : input.reason,
        refId: before.id,
        occurredAt: now,
      },
    });
    return { before, after, reversed };
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.cancel",
    entity: "Procedure",
    entityId: id,
    before: { status: before.status },
    after: { status: "CANCELLED", reason: input.reason, ...(reversed ? { chargeReversed: reversed } : {}) },
  });
  const [view] = await attachPeople(tenantId, [after]);
  return view!;
}
