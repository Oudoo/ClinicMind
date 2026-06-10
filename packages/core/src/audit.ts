import { db, auditLogs } from "@growengine/db";

/**
 * Enterprise Audit Trail helper — call from every mutating server action
 * and route handler.
 */
export interface AuditInput {
  tenantId: string;
  actorId?: string | null;
  actorType?: "user" | "system" | "api_key" | "worker";
  action: string;
  entityType?: string;
  entityId?: string;
  changes?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

export async function audit(input: AuditInput) {
  await db.insert(auditLogs).values({
    tenantId: input.tenantId,
    actorId: input.actorId ?? null,
    actorType: input.actorType ?? "user",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    changes: input.changes ?? {},
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });
}
