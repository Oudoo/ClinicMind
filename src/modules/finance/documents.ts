import type { Prisma } from "@prisma/client";

/**
 * Document numbers: each branch numbers its invoices, credit notes, receipts,
 * refund vouchers, quotes, insurance claims and claim batches in sequences of
 * its own ("ZAM-INV-000042", "ZAM-QT-000007", "ZAM-CL-000003"). A number is
 * taken inside the transaction that issues the document: the sequence row is
 * locked until it commits, and rolled back with it, so a number is spent only
 * when the document exists. No gaps, no repeats.
 */

type Tx = Prisma.TransactionClient;

export const DOCUMENT_KINDS = ["INVOICE", "CREDIT_NOTE", "RECEIPT", "REFUND", "QUOTE", "CLAIM", "CLAIM_BATCH"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const PREFIX: Record<DocumentKind, string> = { INVOICE: "INV", CREDIT_NOTE: "CN", RECEIPT: "RC", REFUND: "RF", QUOTE: "QT", CLAIM: "CL", CLAIM_BATCH: "CB" };

/** "Aura Clinic — Zamalek" → "ZAM": the letters of the place after the dash, else of the name (as the migration does). */
export function deriveBranchCode(name: string): string {
  const place = name.split("—")[1]?.trim() || name;
  const letters = place.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
  return letters || "BR";
}

export function formatDocumentNumber(code: string, kind: DocumentKind, sequence: number): string {
  return `${code}-${PREFIX[kind]}-${String(sequence).padStart(6, "0")}`;
}

/** The branch's code, set from its name the first time it is needed (a repeat within the clinic gets a digit). */
export async function ensureBranchCode(tx: Tx, tenantId: string, clinicId: string): Promise<string> {
  const clinic = await tx.clinic.findFirst({ where: { id: clinicId, tenantId }, select: { code: true, name: true } });
  if (!clinic) throw new Error(`clinic ${clinicId} not found in tenant`);
  if (clinic.code) return clinic.code;
  const base = deriveBranchCode(clinic.name);
  const taken = new Set((await tx.clinic.findMany({ where: { tenantId, code: { not: null } }, select: { code: true } })).map((c) => c.code));
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}${n}`;
  await tx.clinic.update({ where: { id: clinicId }, data: { code } });
  return code;
}

/** Take the branch's next number of a kind, inside the caller's transaction. */
export async function takeNumber(tx: Tx, tenantId: string, clinicId: string, kind: DocumentKind): Promise<{ sequence: number; number: string }> {
  const code = await ensureBranchCode(tx, tenantId, clinicId);
  const rows = await tx.$queryRaw<{ taken: number }[]>`
    INSERT INTO "document_sequences" ("tenantId", "clinicId", "kind", "next")
    VALUES (${tenantId}, ${clinicId}, ${kind}, 2)
    ON CONFLICT ("tenantId", "clinicId", "kind") DO UPDATE SET "next" = "document_sequences"."next" + 1
    RETURNING "next" - 1 AS taken`;
  const sequence = Number(rows[0]!.taken);
  return { sequence, number: formatDocumentNumber(code, kind, sequence) };
}

/** The clinic's first location: where work and money land when nothing says otherwise. */
export async function defaultClinicId(tx: Tx, tenantId: string): Promise<string | null> {
  const clinic = await tx.clinic.findFirst({ where: { tenantId, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
  return clinic?.id ?? null;
}

/** The branch of a payment's visit: its appointment's, or its procedure's appointment's (null when it has none). */
export async function visitClinic(tx: Tx, tenantId: string, link: { appointmentId?: string | null; procedureId?: string | null }): Promise<string | null> {
  if (link.appointmentId) {
    const a = await tx.appointment.findFirst({ where: { id: link.appointmentId, tenantId }, select: { clinicId: true } });
    if (a?.clinicId) return a.clinicId;
  }
  if (link.procedureId) {
    const p = await tx.procedure.findFirst({ where: { id: link.procedureId, tenantId }, select: { appointmentId: true } });
    if (p?.appointmentId) {
      const a = await tx.appointment.findFirst({ where: { id: p.appointmentId, tenantId }, select: { clinicId: true } });
      if (a?.clinicId) return a.clinicId;
    }
  }
  return null;
}

/** The branch a payment was taken at: its visit's, its procedure's visit's, else the first location. */
export async function clinicForPayment(tx: Tx, tenantId: string, link: { appointmentId?: string | null; procedureId?: string | null }): Promise<string | null> {
  return (await visitClinic(tx, tenantId, link)) ?? defaultClinicId(tx, tenantId);
}

/**
 * Give payments their branch and receipt numbers (a refund, a refund voucher
 * number), in the order the money moved. For payments written in bulk (the
 * card-machine import, the demo seed); a single payment is numbered as it is
 * recorded.
 */
export async function numberPayments(tx: Tx, tenantId: string, paymentIds: readonly string[]): Promise<number> {
  if (!paymentIds.length) return 0;
  const rows = await tx.payment.findMany({
    where: { tenantId, id: { in: [...paymentIds] }, receiptNumber: null },
    select: { id: true, kind: true, clinicId: true, appointmentId: true, procedureId: true },
    orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  for (const p of rows) {
    const clinicId = p.clinicId ?? (await clinicForPayment(tx, tenantId, p));
    if (!clinicId) continue;
    const { sequence, number } = await takeNumber(tx, tenantId, clinicId, p.kind === "REFUND" ? "REFUND" : "RECEIPT");
    await tx.payment.update({ where: { id: p.id }, data: { clinicId, receiptSequence: sequence, receiptNumber: number } });
  }
  return rows.length;
}
