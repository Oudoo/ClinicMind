import type { SeedContext } from "./index";
import { takeNumber } from "../../src/modules/finance/documents";
import { allocateCredit } from "../../src/modules/finance/allocations";

/**
 * A family account for the demo clinic: Hany Nabil pays for his children,
 * Nesma and Sherif Hany. Yesterday he transferred part of what is still due
 * on Sherif's hair transplant, so his account shows the payment and what he
 * paid for Sherif, and Sherif's shows what his father paid. Sherif comes
 * back today for his transplant review: the desk sees what is still owed
 * when he checks in.
 */

const DAY = 86_400_000;
const MIN = 60_000;
const HEAD = "Hany Nabil";
const MEMBERS = ["Nesma Hany", "Sherif Hany"];

export async function seedHouseholds(ctx: SeedContext): Promise<void> {
  const { db, tenantId, clinicId } = ctx;
  const head = ctx.patients.find((p) => p.fullName === HEAD);
  const members = MEMBERS.map((name) => ctx.patients.find((p) => p.fullName === name)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  if (!head || !members.length) {
    console.log("     family accounts: the demo family is not in this data set; none made");
    return;
  }
  for (const m of members) await db.patient.update({ where: { id: m.id }, data: { householdHeadId: head.id, householdRelation: "CHILD" } });

  // What the children still owe on their invoices; the father pays part of it by bank transfer.
  const open = await db.invoice.findMany({
    where: { tenantId, patientId: { in: members.map((m) => m.id) }, status: { in: ["ISSUED", "PART_PAID"] } },
    select: { total: true, allocations: { select: { amount: true } } },
  });
  const due = open.reduce((s, i) => s + i.total - i.allocations.reduce((a, x) => a + x.amount, 0), 0);
  const amount = Math.min(15_000, Math.floor(due / 100) * 100);
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  let paid = 0;
  if (amount > 0) {
    const paidAt = new Date(ctx.today.getTime() - DAY + 11.5 * 3_600_000);
    await db.$transaction(async (tx) => {
      const receipt = await takeNumber(tx, tenantId, clinicId, "RECEIPT");
      await tx.payment.create({
        data: {
          tenantId,
          patientId: head.id,
          kind: "PAYMENT",
          method: "BANK_TRANSFER",
          amount,
          paidAt,
          reference: "CIB transfer 4471",
          note: "For the children's treatment",
          clinicId,
          receiptSequence: receipt.sequence,
          receiptNumber: receipt.number,
          createdById: reception.id,
          createdAt: paidAt,
        },
      });
      paid = await allocateCredit(tx, tenantId, head.id, reception.id);
    });
  }
  // Sherif's transplant review today, in the latest free slot of his doctor's day (the clinic is closed on Fridays).
  const sherif = members.find((m) => m.fullName === "Sherif Hany");
  const day = ctx.calendarDay(0);
  let review: Date | null = null;
  if (sherif && day.weekday !== 5) {
    const doctor = ctx.users.find((u) => u.kind === sherif.doctorKind && u.role === "DOCTOR") ?? ctx.users.find((u) => u.kind === sherif.doctorKind);
    const taken = await db.appointment.findMany({
      where: { tenantId, deletedAt: null, status: { notIn: ["CANCELLED", "NO_SHOW"] }, startsAt: { gte: ctx.zoned(day.y, day.m, day.d, 0, 0), lt: ctx.zoned(day.y, day.m, day.d, 23, 59) }, OR: [{ doctorId: doctor?.id }, { patientId: sherif.id }] },
      select: { startsAt: true, endsAt: true },
    });
    const free = (start: Date) => !taken.some((t) => t.startsAt.getTime() < start.getTime() + 20 * MIN && t.endsAt.getTime() > start.getTime());
    review = Array.from({ length: 19 }, (_, i) => 19.5 - i * 0.5).map((h) => ctx.zoned(day.y, day.m, day.d, Math.floor(h), (h % 1) * 60)).find(free) ?? null;
    if (doctor && review) {
      const treatment = await db.treatment.findFirst({ where: { tenantId, key: "hair-transplant" }, select: { id: true } });
      await db.appointment.create({
        data: {
          tenantId,
          clinicId,
          patientId: sherif.id,
          doctorId: doctor.id,
          treatmentId: treatment?.id ?? null,
          startsAt: review,
          endsAt: new Date(review.getTime() + 20 * MIN),
          kind: "FOLLOW_UP",
          status: "CONFIRMED",
          confirmedAt: new Date(ctx.today.getTime() - DAY),
          reason: "Hair transplant review",
          createdById: reception.id,
        },
      });
    }
  }
  console.log(
    `     family accounts: ${HEAD} pays for ${members.map((m) => m.fullName).join(" and ")}${paid ? `; paid ${paid.toLocaleString("en-US")} EGP towards their invoices` : ""}${review ? "; Sherif's review is booked today" : ""}`,
  );
}
