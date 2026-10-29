import type { Prisma, UserStatus } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";

/**
 * Tenant-ownership assertions for foreign keys supplied by a request.
 *
 * Every write that stores a client-supplied id (patientId, doctorId, clinicId…)
 * must prove the referenced row belongs to the acting tenant first; otherwise a
 * caller in tenant A could attach consultations, appointments or clinical
 * records to tenant B's patients (SEC-4). These helpers are the single place
 * that proof is made, and they accept a transaction client so the check can
 * run inside the same transaction as the write.
 */

type Client = Prisma.TransactionClient;

export type TenantScopedEntity =
  | "patient"
  | "user"
  | "clinic"
  | "appointment"
  | "treatment"
  | "lead"
  | "campaign"
  | "conversation"
  | "procedure"
  | "price_item"
  | "invoice"
  | "protocol"
  | "enrolment"
  | "intake_link"
  | "escalation"
  | "recall"
  | "recall_rule"
  | "evidence_source"
  | "ai_run";

/**
 * Thrown when a referenced row does not belong to the acting tenant (or does
 * not exist at all). Mapped to HTTP 404 so the response never reveals whether
 * the id exists in another tenant.
 */
export class TenantScopeError extends Error {
  readonly status = 404;
  constructor(
    readonly entity: TenantScopedEntity,
    readonly id: string,
  ) {
    super(`${entity} ${id} not found in tenant`);
    this.name = "TenantScopeError";
  }
}

/** The patient must exist, be unarchived and belong to `tenantId`. */
export async function requireTenantPatient(tenantId: string, patientId: string, client: Client = db) {
  const patient = await client.patient.findFirst({
    where: { id: patientId, tenantId, ...notDeleted },
    select: { id: true, tenantId: true },
  });
  if (!patient) throw new TenantScopeError("patient", patientId);
  return patient;
}

/**
 * The user must exist, be unarchived and belong to `tenantId`. By default any
 * status except DISABLED is accepted; pass `statuses` to narrow it (the embed
 * bridge requires ACTIVE).
 */
export async function requireTenantUser(
  tenantId: string,
  userId: string,
  opts: { statuses?: UserStatus[] } = {},
  client: Client = db,
) {
  const user = await client.user.findFirst({
    where: {
      id: userId,
      tenantId,
      ...notDeleted,
      status: opts.statuses ? { in: opts.statuses } : { not: "DISABLED" },
    },
    select: { id: true, tenantId: true, email: true, role: true, status: true },
  });
  if (!user) throw new TenantScopeError("user", userId);
  return user;
}

/** The clinic must exist, be unarchived and belong to `tenantId`. */
export async function requireTenantClinic(tenantId: string, clinicId: string, client: Client = db) {
  const clinic = await client.clinic.findFirst({
    where: { id: clinicId, tenantId, ...notDeleted },
    select: { id: true, tenantId: true },
  });
  if (!clinic) throw new TenantScopeError("clinic", clinicId);
  return clinic;
}
