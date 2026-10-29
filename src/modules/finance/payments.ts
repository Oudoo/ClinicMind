import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { TenantScopeError } from "@/lib/tenant-scope";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import { notify } from "@/modules/notifications/service";
import { KIND_LABELS, LARGE_PAYMENT_THRESHOLD, MAX_AMOUNT, METHOD_LABELS, PAYMENT_KINDS, PAYMENT_METHODS } from "./constants";
import { FinanceError, PaymentNotFoundError } from "./errors";
import { requireTenantAppointment, type Actor } from "./procedures";
import { takeNumber, visitClinic } from "./documents";
import { assertDayOpen, cashFor, zPaidAt } from "./cash";
import { allocateCredit, CREDITING_KINDS, patientCredit, payableBy, refreshInvoiceStatus, releasePayment, settledOn } from "./allocations";
import { requirePlanFor, settlePlan } from "./instalments";

/**
 * Payments: money in or out, whole EGP. Deposits and payments are linked to a
 * procedure when there is one, consultation fees to an appointment. Each gets
 * its branch's next receipt number (a refund, a refund voucher number) as it
 * is recorded; money in goes towards the patient's open invoices, oldest
 * first (a deposit for a procedure waits for the invoice that bills it; the
 * head of a family's money goes on to the members' invoices). A
 * refund needs a reason and the patient's credit to cover it. A voided
 * payment is soft-deleted (kept for the audit trail, out of every total) and
 * gives back what it had paid on invoices. Money taken today goes into the
 * cashier's open shift (see cash.ts); none is recorded on, or voided from, a
 * day signed off.
 */

const zId = zText(64).min(1);

export const PaymentInput = z
  .object({
    patientId: zId,
    kind: z.enum(PAYMENT_KINDS),
    method: z.enum(PAYMENT_METHODS).default("CASH"),
    amount: z.number().int().positive().max(MAX_AMOUNT),
    paidAt: zPaidAt.optional(),
    procedureId: zOptionalText(64),
    appointmentId: zOptionalText(64),
    /** Put it towards this invoice first (matched by hand); otherwise the oldest open invoice is paid first. */
    invoiceId: zOptionalText(64),
    /** The instalment plan it pays towards (the patient's, or a family member's for the head): it covers the plan's instalments in order. */
    instalmentPlanId: zOptionalText(64),
    reference: zOptionalText(120),
    note: zOptionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "REFUND" && !v.note) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Say why the money is refunded" });
    if (v.invoiceId && v.kind !== "PAYMENT") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["invoiceId"], message: "Only a payment goes towards an invoice" });
    if (v.instalmentPlanId && v.kind === "CONSULTATION_FEE") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["instalmentPlanId"], message: "A consultation fee goes towards no instalment plan" });
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
  const created = await db.$transaction(async (tx) => {
    if (input.kind === "REFUND") {
      const { credit } = await patientCredit(tx, tenantId, input.patientId);
      if (input.amount > credit) {
        throw new FinanceError(409, "not_enough_credit", "a refund cannot exceed the patient's credit", {
          credit,
          message: credit > 0 ? `The patient's credit is ${credit.toLocaleString("en-US")} EGP: refund at most that.` : "The patient has no credit to refund: cancel the invoice it paid first.",
        });
      }
    }
    // Matched by hand: one of the patient's invoices or, for the head of a family, a member's.
    const invoice = input.invoiceId
      ? await tx.invoice.findFirst({
          where: { id: input.invoiceId, tenantId, patientId: { in: await payableBy(tx, tenantId, input.patientId) } },
          select: { id: true, status: true, total: true, number: true },
        })
      : null;
    if (input.invoiceId && !invoice) throw new TenantScopeError("invoice", input.invoiceId);
    // Towards an instalment plan: the patient's own, or a family member's when the head pays.
    const plan = input.instalmentPlanId ? await requirePlanFor(tx, tenantId, input.instalmentPlanId, await payableBy(tx, tenantId, input.patientId), input.kind) : null;
    if (invoice && invoice.status !== "ISSUED" && invoice.status !== "PART_PAID") {
      throw new FinanceError(409, "invalid_state", "the invoice has nothing to pay", { status: invoice.status, action: "paid", message: `Invoice ${invoice.number ?? ""} has nothing left to pay.` });
    }
    // Taken today: into the cashier's open shift, at its branch; entered late for an earlier day: into no shift.
    const { shiftId, clinicId } = await cashFor(tx, tenantId, actor.id, paidAt, () => visitClinic(tx, tenantId, input));
    const receipt = clinicId ? await takeNumber(tx, tenantId, clinicId, input.kind === "REFUND" ? "REFUND" : "RECEIPT") : null;
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
        clinicId,
        shiftId,
        receiptSequence: receipt?.sequence ?? null,
        receiptNumber: receipt?.number ?? null,
        instalmentPlanId: plan?.id ?? null,
        createdById: actor.id ?? null,
      },
      include: paymentInclude,
    });
    if (plan) await settlePlan(tx, tenantId, plan.id, paidAt);
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: input.patientId,
        kind: "PAYMENT",
        title: describe(payment),
        body: [procedureLabel ? `Towards ${procedureLabel}` : null, plan ? `Instalment plan: ${plan.title}` : null, input.reference ? `Ref ${input.reference}` : null, input.note ?? null].filter(Boolean).join(" · ") || null,
        refId: payment.id,
        occurredAt: paidAt,
      },
    });
    let allocated = 0;
    if (invoice) {
      // Matched by hand: this invoice first, up to what it still needs.
      const settled = await settledOn(tx, tenantId, invoice.id);
      const amount = Math.min(payment.amount, invoice.total - settled.paid - settled.writtenOff);
      if (amount > 0) {
        await tx.paymentAllocation.create({ data: { tenantId, paymentId: payment.id, invoiceId: invoice.id, amount, createdById: actor.id ?? null } });
        await refreshInvoiceStatus(tx, tenantId, invoice.id);
        allocated += amount;
      }
    }
    if ((CREDITING_KINDS as readonly string[]).includes(payment.kind)) allocated += await allocateCredit(tx, tenantId, payment.patientId, actor.id ?? null);
    return { payment, allocated };
  });
  const { payment } = created;

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
      instalmentPlanId: payment.instalmentPlanId,
      kind: payment.kind,
      method: payment.method,
      amount: payment.amount,
      paidAt: payment.paidAt.toISOString(),
      reference: payment.reference,
      receiptNumber: payment.receiptNumber,
      allocated: created.allocated,
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
    await assertDayOpen(tx, tenantId, before.clinicId, before.paidAt, "its money is not voided; record a refund instead.");
    const after = await tx.payment.update({ where: { id, tenantId }, data: { deletedAt: now }, include: paymentInclude });
    // What it paid on invoices is taken back; a voided refund gives the credit back. Either way, re-allocate.
    await releasePayment(tx, tenantId, id, before.patientId, actor.id ?? null);
    await allocateCredit(tx, tenantId, before.patientId, actor.id ?? null);
    // What it covered of an instalment plan is owed again.
    if (before.instalmentPlanId) await settlePlan(tx, tenantId, before.instalmentPlanId, now);
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
