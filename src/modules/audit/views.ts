import { audit } from "@/lib/audit";
import { db } from "@/lib/db";

/** Opening the same record again within this window is one view, not many. */
export const RECORD_VIEW_WINDOW_MS = 10 * 60_000;

/**
 * Log that someone opened a patient's record (`patient.record.view`). The
 * page re-renders on every refresh and after every change, so a person's
 * repeat views of one record inside RECORD_VIEW_WINDOW_MS count once.
 */
export async function recordPatientView(input: {
  tenantId: string;
  patientId: string;
  actorId: string | null;
  actorEmail: string | null;
  ip: string | null;
  device: string | null;
}): Promise<void> {
  const since = new Date(Date.now() - RECORD_VIEW_WINDOW_MS);
  const recent = await db.auditLog.findFirst({
    where: {
      tenantId: input.tenantId,
      patientId: input.patientId,
      action: "patient.record.view",
      actorId: input.actorId,
      ...(input.actorId ? {} : { actorEmail: input.actorEmail }),
      createdAt: { gte: since },
    },
    select: { id: true },
  });
  if (recent) return;
  await audit({
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorEmail: input.actorEmail,
    action: "patient.record.view",
    entity: "Patient",
    entityId: input.patientId,
    patientId: input.patientId,
    ip: input.ip,
    device: input.device,
  });
}
