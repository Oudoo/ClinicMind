import type { SeedContext } from "./index";
import { discountDraftLine } from "../../src/modules/finance/adjustments";
import { refreshInvoiceStatus } from "../../src/modules/finance/allocations";

/**
 * Discounts and write-offs in the demo clinic: the uninsured patient's draft
 * waiting to be issued has 10% off its first line for a returning patient
 * (within reception's limit), and the owner wrote off the smallest balance
 * left on an old invoice as too small to chase.
 */

const DAY = 86_400_000;

export async function seedAdjustments(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  const owner = ctx.users.find((u) => u.role === "CLINIC_OWNER") ?? ctx.users[0]!;
  const made: string[] = [];

  // 10% off the uninsured patient's draft's first line: a returning patient.
  const draft = await db.invoice.findFirst({
    where: { tenantId, status: "DRAFT", patient: { coverages: { none: {} } } },
    select: { id: true, lines: { where: { amount: { gt: 0 } }, orderBy: { position: "asc" }, take: 1, select: { chargeId: true, amount: true } } },
  });
  const line = draft?.lines[0];
  if (draft && line && line.amount >= 500) {
    const amount = Math.floor(line.amount / 10 / 50) * 50;
    await discountDraftLine(tenantId, draft.id, { chargeId: line.chargeId, amount, reason: "LOYALTY", note: "Fifth visit this year" }, { id: reception.id });
    made.push(`${amount.toLocaleString("en-US")} EGP off a draft line`);
  }

  // The smallest balance left on an older invoice, written off by the owner (outside the demo family).
  const cutoff = new Date(ctx.today.getTime() - 21 * DAY);
  const open = await db.invoice.findMany({
    where: { tenantId, status: "PART_PAID", issuedAt: { lt: cutoff }, patient: { householdHeadId: null, householdMembers: { none: {} } } },
    select: { id: true, number: true, total: true, patientId: true, issuedAt: true, allocations: { select: { amount: true } } },
  });
  const smallest = open.map((i) => ({ ...i, due: i.total - i.allocations.reduce((s, a) => s + a.amount, 0) })).sort((a, b) => a.due - b.due)[0];
  if (smallest && smallest.due > 0) {
    const writtenOffAt = new Date(Math.min(ctx.today.getTime() - 2 * DAY, smallest.issuedAt!.getTime() + 45 * DAY));
    const reason = smallest.due <= 1_000 ? "SMALL_BALANCE" : "BAD_DEBT";
    await db.$transaction(async (tx) => {
      await tx.writeOff.create({
        data: { tenantId, patientId: smallest.patientId, invoiceId: smallest.id, amount: smallest.due, reason, note: "No answer to three reminders", writtenOffAt, createdById: owner.id, createdAt: writtenOffAt },
      });
      await refreshInvoiceStatus(tx, tenantId, smallest.id);
      await tx.timelineEvent.create({
        data: { tenantId, patientId: smallest.patientId, kind: "PAYMENT", title: `Written off: ${smallest.due.toLocaleString("en-US")} EGP on invoice ${smallest.number}`, body: "No answer to three reminders", refId: smallest.id, occurredAt: writtenOffAt },
      });
    });
    made.push(`${smallest.due.toLocaleString("en-US")} EGP written off on ${smallest.number}`);
  }
  console.log(`     adjustments: ${made.join("; ") || "none"}`);
}
