import { db } from "@/lib/db";

/**
 * Append-only audit logging. Every mutation that touches clinical or tenant data
 * funnels through here so the audit trail is immutable and complete (actor, time,
 * device, ip, before/after).
 */
export interface AuditInput {
  tenantId: string;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string; // e.g. "patient.update"
  entity: string; // e.g. "Patient"
  entityId?: string | null;
  /**
   * The patient whose record the action concerns. Optional: when omitted it is
   * taken from a Patient entity, a `patientId` in after/before, or the patient
   * of the row the entry names (see `resolveAuditPatientId`).
   */
  patientId?: string | null;
  ip?: string | null;
  device?: string | null;
  before?: unknown;
  after?: unknown;
}

function snapshotPatientId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as { patientId?: unknown }).patientId;
  return typeof id === "string" && id ? id : null;
}

type PatientLookup = (tenantId: string, id: string) => Promise<{ patientId: string | null } | null>;

/** Rows that belong to one patient, by the entity name audit entries use. */
const PATIENT_OF: Record<string, PatientLookup> = {
  Appointment: (tenantId, id) => db.appointment.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  AppointmentNote: (tenantId, id) => db.appointmentNote.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  Consultation: (tenantId, id) => db.consultation.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  Procedure: (tenantId, id) => db.procedure.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  Payment: (tenantId, id) => db.payment.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  Conversation: (tenantId, id) => db.conversation.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  IntakeSubmission: (tenantId, id) => db.intakeSubmission.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  ConciergeEnrolment: (tenantId, id) => db.conciergeEnrolment.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  Escalation: (tenantId, id) => db.escalation.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  MedicalHistory: (tenantId, id) => db.medicalHistory.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  Medication: (tenantId, id) => db.medication.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  Lead: (tenantId, id) => db.lead.findFirst({ where: { id, tenantId }, select: { patientId: true } }),
  ConciergeTask: async (tenantId, id) => {
    const task = await db.conciergeTask.findFirst({ where: { id, tenantId }, select: { enrolment: { select: { patientId: true } } } });
    return task ? { patientId: task.enrolment.patientId } : null;
  },
};

/**
 * The patient an entry concerns: given explicitly, the Patient entity itself,
 * a `patientId` in the after/before snapshot, or the patient of the row named
 * by entity + entityId. Null for entries about no patient (settings, users).
 */
export async function resolveAuditPatientId(input: AuditInput): Promise<string | null> {
  if (input.patientId !== undefined) return input.patientId;
  if (input.entity === "Patient") return input.entityId ?? null;
  const fromSnapshot = snapshotPatientId(input.after) ?? snapshotPatientId(input.before);
  if (fromSnapshot) return fromSnapshot;
  const lookup = input.entityId ? PATIENT_OF[input.entity] : undefined;
  if (!lookup || !input.entityId) return null;
  const row = await lookup(input.tenantId, input.entityId);
  return row?.patientId ?? null;
}

/** Write one entry. Returns its id, or null when writing failed (which never throws). */
export async function audit(input: AuditInput): Promise<string | null> {
  try {
    const patientId = await resolveAuditPatientId(input).catch(() => null);
    const row = await db.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        patientId,
        ip: input.ip ?? null,
        device: input.device ?? null,
        before: (input.before ?? undefined) as never,
        after: (input.after ?? undefined) as never,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    // Auditing must never break the primary operation, but failures are loud.
    console.error("[audit] failed to write audit log", err);
    return null;
  }
}
