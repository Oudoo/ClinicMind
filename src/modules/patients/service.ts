import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { z } from "zod";

export const PatientInput = z.object({
  fullName: z.string().min(1),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]).default("UNDISCLOSED"),
  dateOfBirth: z.string().datetime().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional(),
  emergencyContact: z.string().optional(),
});
export type PatientInput = z.infer<typeof PatientInput>;

export async function listPatients(tenantId: string, search?: string) {
  return db.patient.findMany({
    where: {
      tenantId,
      ...notDeleted,
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: "insensitive" } },
              { phone: { contains: search } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      medicalHistory: true,
      _count: { select: { appointments: true, visits: true } },
    },
  });
}

export async function getPatient(tenantId: string, id: string) {
  return db.patient.findFirst({
    where: { id, tenantId, ...notDeleted },
    include: {
      medicalHistory: true,
      medications: { where: { active: true } },
      timeline: { orderBy: { occurredAt: "desc" }, take: 50 },
    },
  });
}

export async function createPatient(
  tenantId: string,
  input: PatientInput,
  actor?: { id?: string; email?: string; ip?: string },
) {
  const data = PatientInput.parse(input);
  const patient = await db.patient.create({
    data: {
      tenantId,
      fullName: data.fullName,
      gender: data.gender,
      dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
      phone: data.phone,
      whatsapp: data.whatsapp,
      email: data.email,
      emergencyContact: data.emergencyContact,
      medicalHistory: { create: {} },
    },
  });
  await audit({
    tenantId,
    actorId: actor?.id,
    actorEmail: actor?.email,
    ip: actor?.ip,
    action: "patient.create",
    entity: "Patient",
    entityId: patient.id,
    after: { fullName: patient.fullName },
  });
  return patient;
}
