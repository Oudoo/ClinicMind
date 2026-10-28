import type { SeedContext } from "./index";
import { ensureBranchCode, takeNumber } from "../../src/modules/finance/documents";
import { allocateCredit } from "../../src/modules/finance/allocations";
import { billableCharges, cancelInvoice, createDraft, issueInvoice } from "../../src/modules/finance/invoices";

/**
 * Receipts and invoices for the demo clinic, as if the clinic had always
 * worked this way:
 *
 * - every payment gets its receipt number (refunds a refund voucher number),
 *   in the order the money came in;
 * - each visit day's charges more than three days old are invoiced on that
 *   day, numbered in order, and the patients' payments are put towards their
 *   invoices oldest first (so most are paid, the seeded balances are
 *   part-paid, and course packages paid up front are credit);
 * - the last three days, and the courses under way, are left to invoice,
 *   with one draft waiting to be issued and one invoice cancelled with a
 *   credit note and issued again.
 */

const DAY = 86_400_000;

export async function seedInvoices(ctx: SeedContext): Promise<void> {
  const { db, tenantId, clinicId } = ctx;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? ctx.users[0]!;

  // Receipt numbers for the payments the earlier steps wrote in bulk, in the order the money came in.
  const code = await db.$transaction((tx) => ensureBranchCode(tx, tenantId, clinicId));
  await db.$executeRaw`UPDATE "payments" p SET "clinicId" = a."clinicId" FROM "appointments" a
    WHERE p."tenantId" = ${tenantId} AND a.id = p."appointmentId" AND p."clinicId" IS NULL AND a."clinicId" IS NOT NULL`;
  await db.$executeRaw`UPDATE "payments" SET "clinicId" = ${clinicId} WHERE "tenantId" = ${tenantId} AND "clinicId" IS NULL`;
  await db.$executeRaw`WITH numbered AS (
      SELECT p.id, (p.kind = 'REFUND') AS refund,
             row_number() OVER (PARTITION BY p."clinicId", (p.kind = 'REFUND') ORDER BY p."paidAt", p."createdAt", p.id) AS seq
      FROM "payments" p WHERE p."tenantId" = ${tenantId} AND p."receiptNumber" IS NULL
    )
    UPDATE "payments" p SET "receiptSequence" = n.seq,
      "receiptNumber" = ${code} || CASE WHEN n.refund THEN '-RF-' ELSE '-RC-' END || lpad(n.seq::text, 6, '0')
    FROM numbered n WHERE n.id = p.id`;
  await db.$executeRaw`INSERT INTO "document_sequences" ("tenantId", "clinicId", "kind", "next")
    SELECT "tenantId", "clinicId", CASE WHEN kind = 'REFUND' THEN 'REFUND' ELSE 'RECEIPT' END, max("receiptSequence") + 1
    FROM "payments" WHERE "tenantId" = ${tenantId} AND "receiptSequence" IS NOT NULL
    GROUP BY "tenantId", "clinicId", CASE WHEN kind = 'REFUND' THEN 'REFUND' ELSE 'RECEIPT' END
    ON CONFLICT ("tenantId", "clinicId", "kind") DO UPDATE SET "next" = GREATEST("document_sequences"."next", EXCLUDED."next")`;

  // Each visit day's charges, invoiced that day: oldest first, so the numbers run with the dates.
  const cutoff = new Date(ctx.today.getTime() - 3 * DAY);
  const charges = await db.charge.findMany({
    where: { tenantId, amount: { gt: 0 }, chargedAt: { lt: cutoff }, procedure: { stages: 1 } },
    select: { id: true, patientId: true, description: true, amount: true, chargedAt: true },
    orderBy: [{ chargedAt: "asc" }, { id: "asc" }],
  });
  const groups = new Map<string, typeof charges>();
  for (const c of charges) {
    const key = `${c.patientId}:${c.chargedAt.toISOString().slice(0, 10)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const patients = new Set<string>();
  let issued = 0;
  for (const group of groups.values()) {
    const day = group[0]!.chargedAt;
    const patientId = group[0]!.patientId;
    const language = ctx.patients.find((p) => p.id === patientId)?.language === "ar" ? "ar" : "en";
    await db.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          tenantId,
          clinicId,
          patientId,
          status: "DRAFT",
          language,
          total: group.reduce((s, c) => s + c.amount, 0),
          createdById: reception.id,
          createdAt: new Date(day.getTime() + 2 * 3_600_000),
          lines: { create: group.map((c, i) => ({ tenantId, chargeId: c.id, description: c.description, amount: c.amount, chargedAt: c.chargedAt, position: i + 1 })) },
        },
        select: { id: true, total: true },
      });
      const { sequence, number } = await takeNumber(tx, tenantId, clinicId, "INVOICE");
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: "ISSUED", sequence, number, issuedAt: new Date(day.getTime() + 2 * 3_600_000), issuedById: reception.id } });
    });
    patients.add(patientId);
    issued++;
  }
  for (const patientId of patients) await db.$transaction((tx) => allocateCredit(tx, tenantId, patientId, reception.id));

  // One invoice cancelled (the wrong treatment was billed) and issued again; one draft waiting.
  const actor = { id: owner.id, email: "owner@demo.clinic" };
  const recent = await db.invoice.findFirst({ where: { tenantId, status: "PAID" }, orderBy: { issuedAt: "desc" }, select: { id: true, patientId: true } });
  if (recent) {
    await cancelInvoice(tenantId, recent.id, { reason: "Billed under the wrong treatment; reissued" }, actor);
    const again = await createDraft(tenantId, { patientId: recent.patientId }, actor);
    await issueInvoice(tenantId, again.id, actor);
  }
  const waiting = await db.charge.findFirst({
    where: { tenantId, amount: { gt: 0 }, chargedAt: { gte: cutoff }, procedure: { stages: 1 } },
    orderBy: { chargedAt: "desc" },
    select: { patientId: true },
  });
  const drafted = waiting && (await db.$transaction((tx) => billableCharges(tx, tenantId, waiting.patientId))).length ? await createDraft(tenantId, { patientId: waiting.patientId }, { id: reception.id }) : null;

  const counts = await db.invoice.groupBy({ by: ["status"], where: { tenantId }, _count: true });
  console.log(`     invoices: ${issued} issued by visit day (${counts.map((c) => `${c._count} ${c.status.toLowerCase().replace("_", "-")}`).join(", ")})${drafted ? ", one draft" : ""}; receipts ${code}-RC-…`);
}
