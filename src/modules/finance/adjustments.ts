import type { UserRole } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zOptionalText, zText } from "@/lib/validation";
import { postCharge } from "./charges";
import { refreshInvoiceStatus, settledOn } from "./allocations";
import { CONTRACT_DISCOUNT, DISCOUNT_REASONS, MAX_AMOUNT, WRITE_OFF_REASON_LABELS, WRITE_OFF_REASONS } from "./constants";
import { DISCOUNT_WORDS } from "./ledger-copy";
import { assertDiscountAllowed } from "./discounts";
import { FinanceError } from "./errors";
import { getInvoice, InvoiceNotFoundError, invoiceState, type InvoiceDTO } from "./invoices";
import { applyContractDiscounts } from "@/modules/insurance/claims";

/**
 * What takes money off what a patient owes, other than a payment:
 *
 * - a discount on a line of a draft invoice: a negative charge (the charge
 *   it takes off, the reason) put on the same draft, within the role's limit
 *   for that charge (all its discounts together); like every charge, never
 *   edited, and reversed with its procedure;
 * - a write-off of what is left on an issued invoice: the owner's decision,
 *   with a reason, settling the invoice without money; voided only with the
 *   invoice (cancelled by a credit note).
 */

type Actor = { id?: string | null; email?: string | null; ip?: string | null; role?: UserRole | null };

const zId = zText(64).min(1);
const zAmount = z.number().int().positive().max(MAX_AMOUNT);

export const LineDiscountInput = z
  .object({
    chargeId: zId,
    amount: zAmount,
    reason: z.enum(DISCOUNT_REASONS),
    note: zOptionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.reason === "OTHER" && !v.note) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Say why the discount is given" });
  });

export const WriteOffInput = z
  .object({
    /** All that is left to pay when not given. */
    amount: zAmount.optional(),
    reason: z.enum(WRITE_OFF_REASONS),
    note: zOptionalText(300),
  })
  .superRefine((v, ctx) => {
    if (v.reason === "OTHER" && !v.note) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Say why it is written off" });
  });

const amountIssue = (message: string) => new z.ZodError([{ code: "custom", path: ["amount"], message }]);

/** Discount a line of a draft invoice, within the actor's limit. Returns the draft as it now reads. */
export async function discountDraftLine(tenantId: string, invoiceId: string, rawInput: unknown, actor: Actor = {}): Promise<InvoiceDTO> {
  const input = LineDiscountInput.parse(rawInput);
  const given = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, status: true, total: true } });
    if (!invoice) throw new InvoiceNotFoundError(invoiceId);
    if (invoice.status !== "DRAFT") throw invoiceState(invoice.status, "discounted", "An issued invoice never changes: cancel it with a credit note and issue a new one.");
    const line = await tx.invoiceLine.findFirst({
      where: { tenantId, invoiceId, chargeId: input.chargeId },
      select: {
        charge: {
          select: { id: true, patientId: true, procedureId: true, appointmentId: true, amount: true, description: true, doctorId: true, clinicId: true, reversalOfId: true, discountOfId: true },
        },
      },
    });
    if (!line) throw new FinanceError(404, "not_found", `charge ${input.chargeId} is not on this draft`, { entity: "charge" });
    const charge = line.charge;
    if (charge.amount <= 0 || charge.reversalOfId || charge.discountOfId) {
      throw new FinanceError(409, "not_discountable", "only a charge for work done is discounted", { message: "Only a charge for work done can be discounted." });
    }
    // All the discounts on this charge together stay within the charge; the desk's (not a contract's) within the role's limit for it.
    const discounts = await tx.charge.findMany({ where: { tenantId, discountOfId: charge.id, reversedBy: { is: null } }, select: { amount: true, reason: true } });
    const before = -discounts.reduce((s, d) => s + d.amount, 0);
    const given = -discounts.filter((d) => d.reason !== CONTRACT_DISCOUNT).reduce((s, d) => s + d.amount, 0);
    if (before + input.amount > charge.amount) {
      throw amountIssue(before ? `At most ${(charge.amount - before).toLocaleString("en-US")} EGP more can come off this line` : "A discount cannot be more than the line");
    }
    await assertDiscountAllowed(tenantId, actor.role, charge.amount, given + input.amount, tx);
    const lines = await tx.invoiceLine.findMany({ where: { tenantId, invoiceId }, select: { amount: true, position: true } });
    const total = lines.reduce((s, l) => s + l.amount, 0) - input.amount;
    if (total <= 0) {
      throw amountIssue("Nothing would be left to bill on this invoice");
    }
    const discount = await postCharge(tx, {
      tenantId,
      patientId: charge.patientId,
      procedureId: charge.procedureId,
      appointmentId: charge.appointmentId,
      amount: -input.amount,
      description: `Discount (${DISCOUNT_WORDS.en[input.reason]}): ${charge.description}`,
      chargedAt: new Date(),
      doctorId: charge.doctorId,
      clinicId: charge.clinicId,
      createdById: actor.id ?? null,
      discountOfId: charge.id,
      reason: input.reason,
    });
    await tx.invoiceLine.create({
      data: { tenantId, invoiceId, chargeId: discount.id, description: discount.description, amount: discount.amount, chargedAt: discount.chargedAt, position: Math.max(0, ...lines.map((l) => l.position)) + 1 },
    });
    await tx.invoice.update({ where: { id: invoiceId }, data: { total } });
    // An insured patient's contract discount is taken off what the desk's discount leaves.
    const after = await applyContractDiscounts(tx, tenantId, invoiceId, actor.id ?? null, new Date());
    return { chargeId: discount.id, of: charge.id, amount: input.amount, reason: input.reason, note: input.note ?? null, total: after };
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "invoice.discount", entity: "Invoice", entityId: invoiceId, after: given });
  return getInvoice(tenantId, invoiceId);
}

/** Write off what is left (or part of it) on an issued invoice: the owner's decision, with the reason. */
export async function writeOffInvoice(tenantId: string, invoiceId: string, rawInput: unknown, actor: Actor = {}): Promise<InvoiceDTO> {
  const input = WriteOffInput.parse(rawInput);
  const now = new Date();
  const done = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "invoices" WHERE id = ${invoiceId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { id: true, status: true, total: true, number: true, patientId: true } });
    if (!invoice) throw new InvoiceNotFoundError(invoiceId);
    if (invoice.status !== "ISSUED" && invoice.status !== "PART_PAID") {
      throw invoiceState(invoice.status, "written off", invoice.status === "DRAFT" ? "Issue the invoice first: a draft is not owed yet." : invoice.status === "PAID" ? "Nothing is left to pay on this invoice." : "A cancelled invoice is not owed.");
    }
    const settled = await settledOn(tx, tenantId, invoiceId);
    const left = invoice.total - settled.paid - settled.writtenOff - settled.claimed;
    const amount = input.amount ?? left;
    if (amount > left) throw amountIssue(`At most ${left.toLocaleString("en-US")} EGP is left to pay on it`);
    await tx.writeOff.create({
      data: { tenantId, patientId: invoice.patientId, invoiceId, amount, reason: input.reason, note: input.note ?? null, writtenOffAt: now, createdById: actor.id ?? null },
    });
    await refreshInvoiceStatus(tx, tenantId, invoiceId);
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: invoice.patientId,
        kind: "PAYMENT",
        title: `Written off: ${amount.toLocaleString("en-US")} EGP on invoice ${invoice.number ?? ""}`,
        body: [WRITE_OFF_REASON_LABELS[input.reason], input.note].filter(Boolean).join(" · "),
        refId: invoiceId,
        occurredAt: now,
      },
    });
    return { number: invoice.number, amount, left: left - amount, reason: input.reason, note: input.note ?? null };
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "invoice.write_off", entity: "Invoice", entityId: invoiceId, after: done });
  return getInvoice(tenantId, invoiceId);
}
