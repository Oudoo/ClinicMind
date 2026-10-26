import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { TenantScopeError } from "@/lib/tenant-scope";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import { notify } from "@/modules/notifications/service";
import { KIND_LABELS, LARGE_PAYMENT_THRESHOLD, MAX_AMOUNT, METHOD_LABELS, PAYMENT_KINDS, PAYMENT_METHODS } from "./constants";
import { PaymentNotFoundError } from "./errors";
import { requireTenantAppointment, type Actor } from "./procedures";

/**
 * Payments: money in or out, whole EGP. Deposits and payments are linked to a
 * procedure when there is one, consultation fees to an appointment. A voided
 * payment is soft-deleted (kept for the audit trail, out of every total).
 */

const zId = zText(64).min(1);

export const PaymentInput = z.object({
  patientId: zId,
  kind: z.enum(PAYMENT_KINDS),
  method: z.enum(PAYMENT_METHODS).default("CASH"),
  amount: z.number().int().positive().max(MAX_AMOUNT),
  paidAt: zDateTime.optional(),
  procedureId: zOptionalText(64),
  appointmentId: zOptionalText(64),
  reference: zOptionalText(120),
  note: zOptionalText(1000),
});
export type PaymentInput = z.infer<typeof PaymentInput>;

export const PaymentVoidInput = z.object({ reason: zText(300).min(1, "A reason is required") });

export const PaymentListQuery = z.object({
  patientId: zOptionalText(64),
  procedureId: zOptionalText(64),
  kind: z.enum(PAYMENT_KINDS).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  from: zDateTime.optional(),
  to: zDateTime.optional(),
  includeVoided: z.preprocess((v) => v === "1" || v === "true" || v === true, z.boolean()).default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaymentListQuery = z.infer<typeof PaymentListQuery>;

const paymentInclude = {
  patient: { select: { id: true, fullName: true } },
  procedure: { select: { id: true, status: true, performedAt: true, treatment: { select: { id: true, key: true, name: true } } } },
} as const;

export type PaymentView = Prisma.PaymentGetPayload<{ include: typeof paymentInclude }>;

export async function listPayments(tenantId: string, query: PaymentListQuery) {
  const where: Prisma.PaymentWhereInput = {
    tenantId,
    ...(query.includeVoided ? {} : notDeleted),
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.procedureId ? { procedureId: query.procedureId } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.method ? { method: query.method } : {}),
    ...(query.from || query.to ? { paidAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } } : {}),
  };
  const skip = (query.page - 1) * query.pageSize;
  const [payments, total] = await db.$transaction([
    db.payment.findMany({ where, orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }], skip, take: query.pageSize, include: paymentInclude }),
    db.payment.count({ where }),
  ]);
  return { payments, total, page: query.page, pageSize: query.pageSize };
}

function describe(p: { kind: string; amount: number; method: string }): string {
  const kind = KIND_LABELS[p.kind as keyof typeof KIND_LABELS] ?? p.kind;
  const method = METHOD_LABELS[p.method as keyof typeof METHOD_LABELS] ?? p.method;
  return `${kind} — ${p.amount.toLocaleString("en-US")} EGP (${method.toLowerCase()})`;
}

export async function recordPayment(tenantId: string, rawInput: unknown, actor: Actor = {}): Promise<PaymentView> {
  const input = PaymentInput.parse(rawInput);
  await requireTenantPatient(tenantId, input.patientId);
  let procedureLabel: string | null = null;
  if (input.procedureId) {
    const procedure = await db.procedure.findFirst({
      where: { id: input.procedureId, tenantId, ...notDeleted, patientId: input.patientId },
      select: { id: true, treatment: { select: { name: true } } },
    });
    if (!procedure) throw new TenantScopeError("procedure", input.procedureId);
    procedureLabel = procedure.treatment.name;
  }
  if (input.appointmentId) await requireTenantAppointment(tenantId, input.appointmentId, input.patientId);

  const paidAt = input.paidAt ?? new Date();
  const payment = await db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        tenantId,
        patientId: input.patientId,
        procedureId: input.procedureId ?? null,
        appointmentId: input.appointmentId ?? null,
        kind: input.kind,
        method: input.method,
        amount: input.amount,
        paidAt,
        reference: input.reference ?? null,
        note: input.note ?? null,
        createdById: actor.id ?? null,
      },
      include: paymentInclude,
    });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: input.patientId,
        kind: "PAYMENT",
        title: describe(payment),
        body: [procedureLabel ? `Towards ${procedureLabel}` : null, input.reference ? `Ref ${input.reference}` : null, input.note ?? null].filter(Boolean).join(" · ") || null,
        refId: payment.id,
        occurredAt: paidAt,
      },
    });
    return payment;
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "payment.record",
    entity: "Payment",
    entityId: payment.id,
    after: {
      patientId: payment.patientId,
      procedureId: payment.procedureId,
      appointmentId: payment.appointmentId,
      kind: payment.kind,
      method: payment.method,
      amount: payment.amount,
      paidAt: payment.paidAt.toISOString(),
      reference: payment.reference,
    },
  });

  if (payment.amount >= LARGE_PAYMENT_THRESHOLD && payment.kind !== "REFUND") {
    notify(tenantId, {
      kind: "PAYMENT_RECORDED",
      title: `${describe(payment)} from ${payment.patient.fullName}`,
      body: procedureLabel ? `Towards ${procedureLabel}` : null,
      href: `/dashboard/patients/${payment.patientId}`,
      entity: "Payment",
      entityId: payment.id,
      roles: ["CLINIC_OWNER"],
      excludeUserId: actor.id ?? null,
    }).catch((err: unknown) => console.error("[finance] payment notification failed", err));
  }
  return payment;
}

/** Soft-delete a payment with a reason; it leaves every total but stays in the audit trail. */
export async function voidPayment(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}): Promise<PaymentView> {
  const input = PaymentVoidInput.parse(rawInput);
  const now = new Date();
  const { before, after } = await db.$transaction(async (tx) => {
    const before = await tx.payment.findFirst({ where: { id, tenantId, ...notDeleted }, include: paymentInclude });
    if (!before) throw new PaymentNotFoundError(id);
    const after = await tx.payment.update({ where: { id, tenantId }, data: { deletedAt: now }, include: paymentInclude });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: before.patientId,
        kind: "PAYMENT",
        title: `Voided: ${describe(before)}`,
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
    action: "payment.void",
    entity: "Payment",
    entityId: id,
    before: { kind: before.kind, amount: before.amount, deletedAt: null },
    after: { kind: before.kind, amount: before.amount, deletedAt: now.toISOString(), reason: input.reason },
  });
  return after;
}
