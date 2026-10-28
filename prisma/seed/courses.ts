import type { Prisma } from "@prisma/client";
import type { SeedContext } from "./index";
import { stageShare } from "../../src/modules/finance/charges";

/**
 * Two courses under way, charged session by session: a full-body laser
 * course paid in full up front (so the patient is paid ahead) with three of
 * six sessions done, and a PRP course on a deposit with two of five done.
 * The PRP patient was seen again at a visit nothing is billed for yet (today
 * when a slot has passed, else within the last three days), so the
 * not-billed list offers "Session 3 done" for it.
 */

const MIN = 60_000;

export async function seedCourses(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const items = await db.priceItem.findMany({
    where: { tenantId, code: { in: ["LHR-BODY-6", "PRP-HAIR-5"] } },
    select: { id: true, code: true, name: true, sessions: true, treatmentId: true, prices: { where: { clinicId: null }, orderBy: { effectiveFrom: "desc" }, select: { amount: true, effectiveFrom: true } } },
  });
  const byCode = new Map(items.map((i) => [i.code, i]));
  const reception = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  const doctorOf = (kind: "derm" | "hair") => ctx.users.find((u) => u.kind === kind && u.role === "DOCTOR") ?? ctx.users.find((u) => u.kind === kind)!;
  const busy = new Set((await db.procedure.findMany({ where: { tenantId, status: { in: ["PLANNED", "STARTED"] } }, select: { patientId: true } })).map((p) => p.patientId));
  const patientFor = (tag: string) => ctx.patients.find((p) => p.tag === tag && !busy.has(p.id));
  const at = (offsetDays: number, hour: number) => {
    const d = ctx.calendarDay(offsetDays);
    return ctx.zoned(d.y, d.m, d.d, Math.floor(hour), Math.round((hour % 1) * 60));
  };

  const plans = [
    { code: "LHR-BODY-6", tag: "laser", kind: "derm" as const, startDay: -35, sessionDays: [-35, -21, -7], paid: { kind: "PAYMENT" as const, method: "CARD" as const, full: true } },
    { code: "PRP-HAIR-5", tag: "hair-loss", kind: "hair" as const, startDay: -28, sessionDays: [-28, -14], paid: { kind: "DEPOSIT" as const, method: "CASH" as const, full: false } },
  ];
  const made: string[] = [];
  for (const plan of plans) {
    const item = byCode.get(plan.code);
    const patient = patientFor(plan.tag);
    if (!item || !patient || !item.sessions) continue;
    busy.add(patient.id);
    const doctor = doctorOf(plan.kind);
    const startedAt = at(plan.startDay, 0);
    const price = item.prices.find((p) => p.effectiveFrom <= startedAt)?.amount ?? item.prices[0]?.amount ?? 0;
    const stages = item.sessions;
    const procedure = await db.procedure.create({
      data: {
        tenantId,
        patientId: patient.id,
        treatmentId: item.treatmentId,
        priceItemId: item.id,
        quantity: 1,
        stages,
        doctorId: doctor.id,
        performedAt: at(plan.startDay, 10),
        price,
        discount: 0,
        status: "STARTED",
        startedAt,
        startedById: reception.id,
        notes: `${stages}-session course`,
        createdById: reception.id,
        createdAt: at(plan.startDay - 3, 12),
      },
      select: { id: true },
    });
    const charges: Prisma.ChargeCreateManyInput[] = plan.sessionDays.map((day, i) => ({
      tenantId,
      patientId: patient.id,
      procedureId: procedure.id,
      stage: i + 1,
      amount: stageShare(price, stages, i + 1),
      description: `${item.name} · session ${i + 1} of ${stages}`,
      chargedAt: at(day, 10.5),
      doctorId: doctor.id,
      clinicId: ctx.clinicId,
      createdById: doctor.id,
      createdAt: at(day, 11),
    }));
    await db.charge.createMany({ data: charges });
    const paidAt = at(plan.startDay, 9.75);
    const amount = plan.paid.full ? price : stageShare(price, stages, 1);
    const payment = await db.payment.create({
      data: { tenantId, patientId: patient.id, procedureId: procedure.id, kind: plan.paid.kind, method: plan.paid.method, amount, paidAt, reference: `RCPT-${7000 + made.length}`, createdById: reception.id, createdAt: paidAt },
      select: { id: true },
    });
    await db.timelineEvent.createMany({
      data: [
        { tenantId, patientId: patient.id, kind: "PROCEDURE", title: `${item.name} started`, body: `${stages} sessions, charged as each is done`, refId: procedure.id, occurredAt: startedAt },
        ...plan.sessionDays.map((day, i) => ({
          tenantId,
          patientId: patient.id,
          kind: "PROCEDURE" as const,
          title: `${item.name}: session ${i + 1} of ${stages} done`,
          body: `${stageShare(price, stages, i + 1).toLocaleString("en-US")} EGP`,
          refId: procedure.id,
          occurredAt: at(day, 10.5),
        })),
        { tenantId, patientId: patient.id, kind: "PAYMENT", title: `${plan.paid.kind === "DEPOSIT" ? "Deposit" : "Payment"} — ${amount.toLocaleString("en-US")} EGP (${plan.paid.method.toLowerCase()})`, body: `Towards ${item.name}`, refId: payment.id, occurredAt: paidAt },
      ],
    });
    made.push(`${item.code} for ${patient.fullName} (${plan.sessionDays.length} of ${stages} done)`);

    // The PRP patient came back for the next session: a visit with nothing billed yet.
    if (plan.code === "PRP-HAIR-5") {
      const now = ctx.today.getTime();
      const taken = await db.appointment.findMany({
        where: { tenantId, doctorId: doctor.id, deletedAt: null, startsAt: { gte: at(-3, 0), lt: at(1, 0) } },
        select: { startsAt: true, endsAt: true },
      });
      // On a day nothing else is billed for the patient: anything billed that day would clear the visit.
      const window = { gte: at(-3, 0), lt: at(1, 0) };
      const billed = [
        ...(await db.procedure.findMany({ where: { tenantId, patientId: patient.id, status: { not: "CANCELLED" }, performedAt: window }, select: { performedAt: true } })).map((x) => x.performedAt),
        ...(await db.payment.findMany({ where: { tenantId, patientId: patient.id, kind: "CONSULTATION_FEE", paidAt: window }, select: { paidAt: true } })).map((x) => x.paidAt),
        ...(await db.charge.findMany({ where: { tenantId, patientId: patient.id, chargedAt: window }, select: { chargedAt: true } })).map((x) => x.chargedAt),
      ];
      const quiet = (day: number) => !billed.some((t) => t >= at(day, 0) && t < at(day + 1, 0));
      const free = (start: Date) => start.getTime() + 30 * MIN <= now && !taken.some((t) => t.startsAt.getTime() < start.getTime() + 30 * MIN && t.endsAt.getTime() > start.getTime());
      const slot = [0, -1, -2, -3].filter(quiet).flatMap((day) => [17, 16, 15, 14, 13, 12, 11, 10, 9].map((h) => at(day, h))).find(free);
      if (slot) {
        await db.appointment.create({
          data: {
            tenantId,
            clinicId: ctx.clinicId,
            patientId: patient.id,
            doctorId: doctor.id,
            treatmentId: item.treatmentId,
            startsAt: slot,
            endsAt: new Date(slot.getTime() + 30 * MIN),
            kind: "FOLLOW_UP",
            status: "COMPLETED",
            reason: `PRP session ${plan.sessionDays.length + 1} of ${stages}`,
            createdById: reception.id,
          },
        });
      }
    }
  }
  console.log(`     courses: ${made.join("; ") || "none (price list or patients missing)"}.`);
}
