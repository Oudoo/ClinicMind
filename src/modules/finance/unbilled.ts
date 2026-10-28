import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { KIND_LABEL, type AppointmentKind } from "@/modules/appointments/transitions";
import { postCharge, procedureLabel, stageShare, summarizeCharges } from "./charges";
import { FinanceError } from "./errors";

/**
 * Work done but not billed, one day at a time: visits that took place with
 * nothing to show for them in money (no procedure, no consultation fee and
 * no charge for that patient that day), and procedures done that day still
 * waiting to be signed or started. Reception goes through it before closing
 * the day; a visit that is free on purpose is charged nothing, with the
 * reason.
 */

type Actor = { id?: string | null; email?: string | null; ip?: string | null };

const zDateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const UnbilledQuery = z.object({ date: zDateKey.optional() });
export const NoChargeInput = z.object({ reason: zText(300).min(3, "Say why the visit is free") });

export interface UnbilledVisit {
  appointmentId: string;
  patientId: string;
  patientName: string;
  startsAt: string;
  kind: AppointmentKind;
  kindLabel: string;
  doctorName: string | null;
  treatmentName: string | null;
  /** A course of the patient's that is under way: the visit was probably its next session. */
  course: { procedureId: string; label: string; nextStage: number; stages: number; share: number } | null;
}

export interface UnsignedProcedure {
  procedureId: string;
  patientId: string;
  patientName: string;
  performedAt: string;
  label: string;
  doctorName: string | null;
  net: number;
  stages: number;
  /** Work done at once waits to be signed; staged work, to be started. */
  waitingFor: "signature" | "start";
}

export interface UnbilledDay {
  date: string;
  timezone: string;
  visits: UnbilledVisit[];
  procedures: UnsignedProcedure[];
}

/** The day's work not billed yet (today when no day is given). */
export async function listUnbilled(tenantId: string, rawQuery: unknown = {}, now: Date = new Date()): Promise<UnbilledDay> {
  const query = UnbilledQuery.parse(rawQuery);
  const timezone = await getTenantTimezone(tenantId);
  const date = query.date ?? dateKeyInTz(now, timezone);
  const from = fromDateKey(date, timezone);
  if (!from) throw new z.ZodError([{ code: "custom", path: ["date"], message: "Not a real date" }]);
  const to = fromDateKey(dateKeyInTz(new Date(from.getTime() + 36 * 3_600_000), timezone), timezone)!;
  const done = to.getTime() < now.getTime() ? to : now;

  const visits = await db.appointment.findMany({
    where: { tenantId, ...notDeleted, status: "COMPLETED", startsAt: { gte: from, lt: to } },
    select: {
      id: true,
      patientId: true,
      doctorId: true,
      kind: true,
      startsAt: true,
      treatmentId: true,
      patient: { select: { fullName: true } },
    },
    orderBy: { startsAt: "asc" },
  });
  const patientIds = [...new Set(visits.map((v) => v.patientId))];
  const visitIds = visits.map((v) => v.id);
  const sameDay = { gte: from, lt: to };

  const treatmentIds = [...new Set(visits.map((v) => v.treatmentId).filter((id): id is string => Boolean(id)))];
  const [treatments, procedures, fees, charges, courses, unsigned] = await Promise.all([
    treatmentIds.length ? db.treatment.findMany({ where: { tenantId, id: { in: treatmentIds } }, select: { id: true, name: true, consultationFee: true } }) : [],
    patientIds.length
      ? db.procedure.findMany({
          where: { tenantId, ...notDeleted, status: { not: "CANCELLED" }, OR: [{ appointmentId: { in: visitIds } }, { patientId: { in: patientIds }, performedAt: sameDay }] },
          select: { patientId: true, appointmentId: true },
        })
      : [],
    patientIds.length
      ? db.payment.findMany({
          where: { tenantId, ...notDeleted, kind: "CONSULTATION_FEE", OR: [{ appointmentId: { in: visitIds } }, { patientId: { in: patientIds }, paidAt: sameDay }] },
          select: { patientId: true, appointmentId: true },
        })
      : [],
    patientIds.length
      ? db.charge.findMany({
          where: { tenantId, OR: [{ appointmentId: { in: visitIds } }, { patientId: { in: patientIds }, chargedAt: sameDay }] },
          select: { patientId: true, appointmentId: true },
        })
      : [],
    patientIds.length
      ? db.procedure.findMany({
          where: { tenantId, ...notDeleted, status: "STARTED", patientId: { in: patientIds } },
          select: {
            id: true,
            patientId: true,
            stages: true,
            quantity: true,
            price: true,
            discount: true,
            priceItem: { select: { name: true } },
            treatment: { select: { name: true } },
            charges: { select: { amount: true, stage: true, reversalOfId: true } },
          },
          orderBy: { startedAt: "asc" },
        })
      : [],
    db.procedure.findMany({
      where: { tenantId, ...notDeleted, status: "PLANNED", performedAt: { gte: from, lt: done } },
      select: {
        id: true,
        patientId: true,
        doctorId: true,
        performedAt: true,
        price: true,
        discount: true,
        stages: true,
        quantity: true,
        patient: { select: { fullName: true } },
        priceItem: { select: { name: true } },
        treatment: { select: { name: true } },
      },
      orderBy: { performedAt: "asc" },
    }),
  ]);

  const billedVisit = new Set<string>();
  const billedPatient = new Set<string>();
  for (const row of [...procedures, ...fees, ...charges]) {
    if (row.appointmentId) billedVisit.add(row.appointmentId);
    billedPatient.add(row.patientId);
  }
  const doctorIds = [...new Set([...visits.map((v) => v.doctorId), ...unsigned.map((p) => p.doctorId)].filter((id): id is string => Boolean(id)))];
  const doctors = doctorIds.length ? await db.user.findMany({ where: { tenantId, id: { in: doctorIds } }, select: { id: true, fullName: true, email: true } }) : [];
  const doctorName = new Map(doctors.map((d) => [d.id, d.fullName ?? d.email]));
  const treatment = new Map(treatments.map((t) => [t.id, t]));

  return {
    date,
    timezone,
    visits: visits
      // A consultation the catalogue makes free has nothing to bill.
      .filter((v) => !(v.kind === "CONSULTATION" && v.treatmentId && (treatment.get(v.treatmentId)?.consultationFee ?? 0) === 0))
      .filter((v) => !billedVisit.has(v.id) && !billedPatient.has(v.patientId))
      .map((v) => {
        const course = courses.find((c) => c.patientId === v.patientId);
        const progress = course ? summarizeCharges(course.charges) : null;
        return {
          appointmentId: v.id,
          patientId: v.patientId,
          patientName: v.patient.fullName,
          startsAt: v.startsAt.toISOString(),
          kind: v.kind,
          kindLabel: KIND_LABEL[v.kind],
          doctorName: v.doctorId ? (doctorName.get(v.doctorId) ?? null) : null,
          treatmentName: v.treatmentId ? (treatment.get(v.treatmentId)?.name ?? null) : null,
          course:
            course && progress
              ? {
                  procedureId: course.id,
                  label: procedureLabel(course),
                  nextStage: progress.stagesDone + 1,
                  stages: course.stages,
                  share: stageShare(course.price - course.discount, course.stages, progress.stagesDone + 1),
                }
              : null,
        };
      }),
    procedures: unsigned.map((p) => ({
      procedureId: p.id,
      patientId: p.patientId,
      patientName: p.patient.fullName,
      performedAt: p.performedAt.toISOString(),
      label: procedureLabel(p),
      doctorName: p.doctorId ? (doctorName.get(p.doctorId) ?? null) : null,
      net: p.price - p.discount,
      stages: p.stages,
      waitingFor: p.stages > 1 ? "start" : "signature",
    })),
  };
}

/**
 * A visit that took place and is free on purpose: charge it nothing, with
 * the reason, so it leaves the not-billed list and the reason stays on the
 * patient's account.
 */
export async function chargeVisitNothing(tenantId: string, appointmentId: string, rawInput: unknown, actor: Actor = {}) {
  const input = NoChargeInput.parse(rawInput);
  const visit = await db.appointment.findFirst({
    where: { id: appointmentId, tenantId, ...notDeleted },
    select: { id: true, patientId: true, doctorId: true, clinicId: true, kind: true, status: true, startsAt: true },
  });
  if (!visit) throw new TenantScopeError("appointment", appointmentId);
  if (visit.status !== "COMPLETED") {
    throw new FinanceError(409, "not_done", "only a visit that took place is charged", { message: "Only a visit that took place can be charged, even nothing." });
  }
  const charge = await db.$transaction(async (tx) => {
    const [procedure, fee, earlier] = await Promise.all([
      tx.procedure.findFirst({ where: { tenantId, appointmentId, status: { not: "CANCELLED" }, ...notDeleted }, select: { id: true } }),
      tx.payment.findFirst({ where: { tenantId, appointmentId, kind: "CONSULTATION_FEE", ...notDeleted }, select: { id: true } }),
      tx.charge.findFirst({ where: { tenantId, appointmentId }, select: { id: true } }),
    ]);
    if (procedure || fee || earlier) {
      throw new FinanceError(409, "already_billed", "the visit is billed already", { message: "This visit is billed already." });
    }
    return postCharge(tx, {
      tenantId,
      patientId: visit.patientId,
      appointmentId,
      amount: 0,
      description: `${KIND_LABEL[visit.kind]} · no charge: ${input.reason}`,
      chargedAt: visit.startsAt,
      doctorId: visit.doctorId,
      clinicId: visit.clinicId,
      createdById: actor.id ?? null,
    });
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "appointment.no_charge",
    entity: "Appointment",
    entityId: appointmentId,
    after: { chargeId: charge.id, amount: 0, reason: input.reason },
  });
  return { charge: { id: charge.id, amount: charge.amount, description: charge.description, chargedAt: charge.chargedAt.toISOString() } };
}
