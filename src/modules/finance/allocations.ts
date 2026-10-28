import type { Prisma } from "@prisma/client";

/**
 * Allocation: what a patient paid goes towards their issued invoices, oldest
 * first; what is not allocated is the patient's credit. Deposits are held as
 * credit: a deposit taken for a procedure only pays an invoice that bills
 * that procedure. Refunds come off the credit. An invoice's status follows
 * what is allocated to it (issued, part-paid, paid).
 *
 * Families: the head of a household pays for its members. A member's own
 * money pays their own invoices first; the head's money then pays what is
 * left across the family (the head's own invoices included), oldest first.
 * A member's money never pays the head's or another member's invoices.
 *
 * These helpers run inside the caller's transaction.
 */

type Tx = Prisma.TransactionClient;

/** Money in that goes towards invoices; a consultation fee pays for the visit itself. */
export const CREDITING_KINDS = ["DEPOSIT", "PAYMENT"] as const;

/** Issued and not paid in full. */
export const OPEN_INVOICE_STATUSES = ["ISSUED", "PART_PAID"] as const;

const total = (rows: readonly { amount: number }[]) => rows.reduce((s, r) => s + r.amount, 0);

export interface PatientCredit {
  /** Deposits and payments, not voided. */
  paidIn: number;
  refunded: number;
  /** Put towards invoices: the patient's own, and (a head's) the family's. */
  allocated: number;
  /** Left to go towards invoices, or to refund. */
  credit: number;
}

export async function patientCredit(tx: Tx, tenantId: string, patientId: string): Promise<PatientCredit> {
  const paidIn = (await tx.payment.aggregate({ where: { tenantId, patientId, deletedAt: null, kind: { in: [...CREDITING_KINDS] } }, _sum: { amount: true } }))._sum.amount ?? 0;
  const refunded = (await tx.payment.aggregate({ where: { tenantId, patientId, deletedAt: null, kind: "REFUND" }, _sum: { amount: true } }))._sum.amount ?? 0;
  const allocated = (await tx.paymentAllocation.aggregate({ where: { tenantId, payment: { patientId, deletedAt: null } }, _sum: { amount: true } }))._sum.amount ?? 0;
  return { paidIn, refunded, allocated, credit: paidIn - refunded - allocated };
}

export interface Household {
  headId: string;
  memberIds: string[];
}

/** The family a patient belongs to (as its head or a member), or null when they pay only for themselves. */
export async function householdOf(tx: Tx, tenantId: string, patientId: string): Promise<Household | null> {
  const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true, householdHeadId: true } });
  if (!patient) return null;
  const headId = patient.householdHeadId ?? patient.id;
  const members = await tx.patient.findMany({ where: { tenantId, householdHeadId: headId }, select: { id: true }, orderBy: { createdAt: "asc" } });
  return members.length ? { headId, memberIds: members.map((m) => m.id) } : null;
}

/** The patients whose invoices this patient's payments may go towards: their own, and a head's members'. */
export async function payableBy(tx: Tx, tenantId: string, patientId: string): Promise<string[]> {
  const members = await tx.patient.findMany({ where: { tenantId, householdHeadId: patientId }, select: { id: true } });
  return [patientId, ...members.map((m) => m.id)];
}

/** Set an issued invoice's status from what is allocated to it. */
export async function refreshInvoiceStatus(tx: Tx, tenantId: string, invoiceId: string): Promise<void> {
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, tenantId }, select: { status: true, total: true } });
  if (!invoice || (invoice.status !== "ISSUED" && invoice.status !== "PART_PAID" && invoice.status !== "PAID")) return;
  const paid = (await tx.paymentAllocation.aggregate({ where: { tenantId, invoiceId }, _sum: { amount: true } }))._sum.amount ?? 0;
  const status = paid >= invoice.total ? "PAID" : paid > 0 ? "PART_PAID" : "ISSUED";
  if (status !== invoice.status) await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
}

/** Put one payer's credit towards the open invoices of the patients given, oldest invoice and oldest money first. */
async function allocateFrom(tx: Tx, tenantId: string, payerId: string, patientIds: string[], actorId: string | null): Promise<number> {
  let available = (await patientCredit(tx, tenantId, payerId)).credit;
  if (available <= 0) return 0;
  const invoices = await tx.invoice.findMany({
    where: { tenantId, patientId: { in: patientIds }, status: { in: [...OPEN_INVOICE_STATUSES] } },
    orderBy: [{ issuedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, total: true, allocations: { select: { amount: true } }, lines: { select: { charge: { select: { procedureId: true } } } } },
  });
  if (!invoices.length) return 0;
  const payments = await tx.payment.findMany({
    where: { tenantId, patientId: payerId, deletedAt: null, kind: { in: [...CREDITING_KINDS] } },
    orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, amount: true, procedureId: true, allocations: { select: { amount: true } } },
  });
  const left = new Map(payments.map((p) => [p.id, p.amount - total(p.allocations)]));
  let allocated = 0;
  for (const invoice of invoices) {
    let due = invoice.total - total(invoice.allocations);
    const billed = new Set(invoice.lines.map((l) => l.charge.procedureId).filter((id): id is string => Boolean(id)));
    for (const p of payments) {
      if (due <= 0 || available <= 0) break;
      // A deposit for a procedure waits for the invoice that bills it.
      if (p.kind === "DEPOSIT" && p.procedureId && !billed.has(p.procedureId)) continue;
      const free = left.get(p.id) ?? 0;
      if (free <= 0) continue;
      const amount = Math.min(free, due, available);
      await tx.paymentAllocation.create({ data: { tenantId, paymentId: p.id, invoiceId: invoice.id, amount, createdById: actorId } });
      left.set(p.id, free - amount);
      due -= amount;
      available -= amount;
      allocated += amount;
    }
    await refreshInvoiceStatus(tx, tenantId, invoice.id);
    if (available <= 0) break;
  }
  return allocated;
}

/**
 * Put credit towards open invoices: the patient's own, or, when they belong
 * to a family, each member's own money to their own invoices and then the
 * head's money to what is left across the family. Returns what was allocated.
 */
export async function allocateCredit(tx: Tx, tenantId: string, patientId: string, actorId: string | null = null): Promise<number> {
  const family = await householdOf(tx, tenantId, patientId);
  if (!family) return allocateFrom(tx, tenantId, patientId, [patientId], actorId);
  let allocated = 0;
  for (const id of family.memberIds) allocated += await allocateFrom(tx, tenantId, id, [id], actorId);
  allocated += await allocateFrom(tx, tenantId, family.headId, [family.headId, ...family.memberIds], actorId);
  return allocated;
}

/** Re-allocate for every family the patients given belong to, once each. */
export async function allocateFor(tx: Tx, tenantId: string, patientIds: Iterable<string>, actorId: string | null = null): Promise<number> {
  const done = new Set<string>();
  let allocated = 0;
  for (const id of patientIds) {
    if (done.has(id)) continue;
    const family = await householdOf(tx, tenantId, id);
    for (const member of family ? [family.headId, ...family.memberIds] : [id]) done.add(member);
    allocated += await allocateCredit(tx, tenantId, id, actorId);
  }
  return allocated;
}

/**
 * Take back what a payment had put towards invoices (it was voided), then
 * re-allocate the credit left: the payer's, and that of the patients whose
 * invoices it had paid (a head pays for the family).
 */
export async function releasePayment(tx: Tx, tenantId: string, paymentId: string, patientId: string, actorId: string | null = null): Promise<void> {
  const rows = await tx.paymentAllocation.findMany({ where: { tenantId, paymentId }, select: { invoiceId: true, invoice: { select: { patientId: true } } } });
  if (!rows.length) return;
  await tx.paymentAllocation.deleteMany({ where: { tenantId, paymentId } });
  for (const invoiceId of new Set(rows.map((r) => r.invoiceId))) await refreshInvoiceStatus(tx, tenantId, invoiceId);
  await allocateFor(tx, tenantId, [patientId, ...rows.map((r) => r.invoice.patientId)], actorId);
}
