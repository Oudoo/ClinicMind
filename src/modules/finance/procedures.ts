import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantPatient, requireTenantUser, TenantScopeError } from "@/lib/tenant-scope";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import { requireTenantTreatment } from "@/modules/treatments/service";
import { enrolOnSignedProcedure } from "@/modules/concierge/service";
import { MAX_AMOUNT, PAYMENT_METHODS, PROCEDURE_STATUSES, procedureBalance } from "./constants";
import { ProcedureNotFoundError, ProcedureStateError } from "./errors";

/**
 * Procedures: a treatment planned for or performed on a patient, with its
 * price. Signing a procedure is the clinical act that makes it count as
 * revenue and enrols the patient in the concierge protocol of the treatment
 * (`enrolOnSignedProcedure`, owned by the concierge module). Every query is
 * tenant-scoped, every client-supplied id is proven to belong to the tenant
 * and every mutation is audited.
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
    treatmentId: zId,
    doctorId: zOptionalText(64),
    appointmentId: zOptionalText(64),
    performedAt: zDateTime,
    price: zMoney,
    discount: zMoney.default(0),
    notes: zOptionalText(2000),
    /** Record a deposit in the same call (requires payments:write at the route). */
    deposit: DepositInput.optional(),
  })
  .superRefine((v, ctx) => {
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
  })
  .superRefine((v, ctx) => {
    if (isNum(v.price) && isNum(v.discount) && v.discount > v.price) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discount"], message: "Discount cannot exceed the price" });
    }
  });
export type ProcedureUpdateInput = z.infer<typeof ProcedureUpdateInput>;

export const ProcedureCancelInput = z.object({ reason: zText(300).min(1, "A reason is required") });

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
  payments: { where: { deletedAt: null }, select: { id: true, kind: true, amount: true, method: true, paidAt: true, reference: true, note: true } },
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
    select: { id: true, patientId: true, doctorId: true, startsAt: true },
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

function snapshot(p: { patientId: string; treatmentId: string; doctorId: string | null; appointmentId: string | null; performedAt: Date; price: number; discount: number; status: string; notes: string | null }) {
  return {
    patientId: p.patientId,
    treatmentId: p.treatmentId,
    doctorId: p.doctorId,
    appointmentId: p.appointmentId,
    performedAt: p.performedAt.toISOString(),
    price: p.price,
    discount: p.discount,
    status: p.status,
    notes: p.notes,
  };
}

export async function createProcedure(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = ProcedureInput.parse(rawInput);

  // Every client-supplied foreign key must belong to the acting tenant (SEC-4).
  await requireTenantPatient(tenantId, input.patientId);
  const treatment = await requireTenantTreatment(tenantId, input.treatmentId);
  if (input.doctorId) await requireTenantUser(tenantId, input.doctorId);
  if (input.appointmentId) await requireTenantAppointment(tenantId, input.appointmentId, input.patientId);

  const { procedure, deposit } = await db.$transaction(async (tx) => {
    const procedure = await tx.procedure.create({
      data: {
        tenantId,
        patientId: input.patientId,
        treatmentId: input.treatmentId,
        doctorId: input.doctorId ?? null,
        appointmentId: input.appointmentId ?? null,
        performedAt: input.performedAt,
        price: input.price,
        discount: input.discount,
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
    const after = await tx.procedure.update({
      where: { id, tenantId },
      data: {
        treatmentId: input.treatmentId,
        doctorId: input.doctorId,
        appointmentId: input.appointmentId,
        performedAt: input.performedAt,
        price,
        discount,
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

/**
 * Sign a planned procedure: it becomes revenue, lands on the patient timeline
 * and enrols the patient in the treatment's concierge protocol. The enrolment
 * is the concierge module's contract; a failure there is logged and never
 * undoes the signature.
 */
export async function signProcedure(tenantId: string, id: string, actor: Actor = {}) {
  const now = new Date();
  const { after, doctorName } = await db.$transaction(async (tx) => {
    const before = await tx.procedure.findFirst({ where: { id, tenantId, ...notDeleted }, include: { treatment: { select: { name: true } } } });
    if (!before) throw new ProcedureNotFoundError(id);
    if (before.status !== "PLANNED") throw new ProcedureStateError(before.status, "signed");
    const doctorId = before.doctorId ?? actor.id ?? null;
    const doctor = doctorId
      ? await tx.user.findFirst({ where: { id: doctorId, tenantId }, select: { fullName: true, email: true } })
      : null;
    const doctorName = doctor ? (doctor.fullName ?? doctor.email) : null;
    const after = await tx.procedure.update({
      where: { id, tenantId },
      data: { status: "SIGNED", signedAt: now, signedById: actor.id ?? null, doctorId },
      include: procedureInclude,
    });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: before.patientId,
        kind: "PROCEDURE",
        title: doctorName ? `${before.treatment.name} performed by Dr ${doctorName.replace(/^Dr\.?\s+/i, "")}` : `${before.treatment.name} performed`,
        body: `${(before.price - before.discount).toLocaleString("en-US")} EGP${before.notes ? ` · ${before.notes}` : ""}`,
        refId: before.id,
        occurredAt: before.performedAt,
      },
    });
    return { after, doctorName };
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "procedure.sign",
    entity: "Procedure",
    entityId: id,
    before: { status: "PLANNED" },
    after: { status: "SIGNED", signedAt: now.toISOString(), signedById: actor.id ?? null, doctor: doctorName },
  });

  // The concierge module owns what happens next; its failure must not undo the signature.
  const enrolment = await enrolOnSignedProcedure(tenantId, after.id, actor).catch((err: unknown) => {
    console.error(`[finance] concierge enrolment failed for procedure ${after.id}`, err);
    return null;
  });

  const [view] = await attachPeople(tenantId, [after]);
  return { procedure: view!, enrolment };
}

export async function cancelProcedure(
  tenantId: string,
  id: string,
  rawInput: unknown,
  actor: Actor = {},
  opts: { allowSigned?: boolean } = {},
) {
  const input = ProcedureCancelInput.parse(rawInput);
  const now = new Date();
  const { before, after } = await db.$transaction(async (tx) => {
    const before = await tx.procedure.findFirst({ where: { id, tenantId, ...notDeleted }, include: { treatment: { select: { name: true } } } });
    if (!before) throw new ProcedureNotFoundError(id);
    if (before.status === "CANCELLED") throw new ProcedureStateError(before.status, "cancelled again");
    if (before.status === "SIGNED" && !opts.allowSigned) throw new ProcedureStateError(before.status, "cancelled without a clinician");
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
        body: input.reason,
        refId: before.id,
        occurredAt: now,
      },
    });
    return { before, after };
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
    after: { status: "CANCELLED", reason: input.reason },
  });
  const [view] = await attachPeople(tenantId, [after]);
  return view!;
}
