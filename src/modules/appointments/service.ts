import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";

export const AppointmentInput = z.object({
  patientId: z.string(),
  doctorId: z.string().optional(),
  room: z.string().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().optional(),
  source: z.enum(["WHATSAPP", "VOICE", "SMS", "WEB_CHAT", "IN_PERSON"]).default("IN_PERSON"),
});
export type AppointmentInput = z.infer<typeof AppointmentInput>;

export async function listAppointments(
  tenantId: string,
  range: { from: Date; to: Date },
) {
  return db.appointment.findMany({
    where: { tenantId, ...notDeleted, startsAt: { gte: range.from, lte: range.to } },
    orderBy: { startsAt: "asc" },
    include: { patient: { select: { id: true, fullName: true } } },
  });
}

/** Detect overlapping appointments for the same doctor or room. */
export async function findConflicts(
  tenantId: string,
  input: { doctorId?: string; room?: string; startsAt: Date; endsAt: Date; excludeId?: string },
) {
  if (!input.doctorId && !input.room) return [];
  return db.appointment.findMany({
    where: {
      tenantId,
      ...notDeleted,
      id: input.excludeId ? { not: input.excludeId } : undefined,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      startsAt: { lt: input.endsAt },
      endsAt: { gt: input.startsAt },
      OR: [
        ...(input.doctorId ? [{ doctorId: input.doctorId }] : []),
        ...(input.room ? [{ room: input.room }] : []),
      ],
    },
    select: { id: true, startsAt: true, endsAt: true, doctorId: true, room: true },
  });
}

export async function createAppointment(
  tenantId: string,
  input: AppointmentInput,
  actor?: { id?: string; email?: string; ip?: string },
) {
  const data = AppointmentInput.parse(input);
  const startsAt = new Date(data.startsAt);
  const endsAt = new Date(data.endsAt);

  const conflicts = await findConflicts(tenantId, {
    doctorId: data.doctorId,
    room: data.room,
    startsAt,
    endsAt,
  });

  const appointment = await db.appointment.create({
    data: {
      tenantId,
      patientId: data.patientId,
      doctorId: data.doctorId,
      room: data.room,
      startsAt,
      endsAt,
      reason: data.reason,
      source: data.source,
      // Conflicting bookings land on the waitlist rather than double-booking.
      status: conflicts.length ? "WAITLISTED" : "SCHEDULED",
    },
  });

  await db.timelineEvent.create({
    data: {
      tenantId,
      patientId: data.patientId,
      kind: "APPOINTMENT",
      title: data.reason ? `Appointment — ${data.reason}` : "Appointment booked",
      refId: appointment.id,
      occurredAt: startsAt,
    },
  });

  await audit({
    tenantId,
    actorId: actor?.id,
    actorEmail: actor?.email,
    ip: actor?.ip,
    action: "appointment.create",
    entity: "Appointment",
    entityId: appointment.id,
    after: { startsAt, status: appointment.status },
  });

  return { appointment, conflicts };
}
