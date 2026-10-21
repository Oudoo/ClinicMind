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
  ip?: string | null;
  device?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function audit(input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorId: input.actorId ?? null,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        ip: input.ip ?? null,
        device: input.device ?? null,
        before: (input.before ?? undefined) as never,
        after: (input.after ?? undefined) as never,
      },
    });
  } catch (err) {
    // Auditing must never break the primary operation, but failures are loud.
    console.error("[audit] failed to write audit log", err);
  }
}
