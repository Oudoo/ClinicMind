import type { CheckIn, ConciergeTask, Escalation } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { getTenantTimezone } from "@/modules/appointments/service";
import type { CheckInDTO, EscalationDTO, TaskDTO } from "./dto";
import { dayLabel, stepHasHighRisk, type ProtocolStep } from "./protocols";
import type { TriageFlag } from "./triage";

/**
 * Pieces shared by the concierge services: the clinic's identity for patient
 * messages, name lookups for plain-column foreign keys (doctorId,
 * assignedToId…) and the row → DTO mappers.
 */
export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

export const SYSTEM_ACTOR: Actor = { id: null, email: "concierge@system" };

export interface ClinicInfo {
  name: string;
  phone: string | null;
  timezone: string;
}

/** Tenant name, the first clinic's phone (for the red-flag line) and the clinic clock. */
export async function getClinicInfo(tenantId: string): Promise<ClinicInfo> {
  const [tenant, clinic, timezone] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
    db.clinic.findFirst({ where: { tenantId, ...notDeleted }, orderBy: { createdAt: "asc" }, select: { phone: true } }),
    getTenantTimezone(tenantId),
  ]);
  return { name: tenant?.name ?? "The clinic", phone: clinic?.phone ?? null, timezone };
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

/** `userId → display name` for the ids given (any status, so history keeps its names). */
export async function userNames(tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
}

export async function patientNames(tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const rows = await db.patient.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, fullName: true } });
  return new Map(rows.map((p) => [p.id, p.fullName]));
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function flagsOf(value: unknown): TriageFlag[] {
  return Array.isArray(value) ? (value as TriageFlag[]) : [];
}

export function answersOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function toCheckInDTO(c: CheckIn): CheckInDTO {
  return {
    id: c.id,
    answers: answersOf(c.answers),
    satisfaction: c.satisfaction,
    freeText: c.freeText,
    photoIds: c.photoIds,
    triage: c.triage,
    flags: flagsOf(c.flags),
    source: c.source,
    submittedAt: c.submittedAt.toISOString(),
  };
}

export function toTaskDTO(task: ConciergeTask & { checkIn?: CheckIn | null }, steps: readonly ProtocolStep[]): TaskDTO {
  const step = steps[task.stepIndex];
  return {
    id: task.id,
    stepIndex: task.stepIndex,
    kind: task.kind,
    title: task.title,
    dayLabel: step ? dayLabel(step) : `Step ${task.stepIndex + 1}`,
    dueAt: task.dueAt.toISOString(),
    sentAt: iso(task.sentAt),
    answeredAt: iso(task.answeredAt),
    missedAt: iso(task.missedAt),
    status: task.status,
    attempts: task.attempts,
    lastError: task.lastError,
    hasHighRisk: step ? stepHasHighRisk(step) : false,
    questions: step?.questions ?? [],
    satisfaction: Boolean(step?.satisfaction),
    photos: step?.photos ?? [],
    body: step?.body ?? null,
    checkIn: task.checkIn ? toCheckInDTO(task.checkIn) : null,
  };
}

export interface NameMaps {
  users: Map<string, string>;
  patients: Map<string, string>;
}

export async function nameMapsFor(tenantId: string, escalations: readonly Escalation[]): Promise<NameMaps> {
  const [users, patients] = await Promise.all([
    userNames(
      tenantId,
      escalations.flatMap((e) => [e.assignedToId, e.acknowledgedById, e.resolvedById]),
    ),
    patientNames(tenantId, escalations.map((e) => e.patientId)),
  ]);
  return { users, patients };
}

export function toEscalationDTO(e: Escalation, names: NameMaps): EscalationDTO {
  const details = e.details && typeof e.details === "object" && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : null;
  return {
    id: e.id,
    kind: e.kind,
    level: e.level,
    status: e.status,
    summary: e.summary,
    details,
    flags: flagsOf(details?.flags),
    patientId: e.patientId,
    patientName: e.patientId ? (names.patients.get(e.patientId) ?? null) : null,
    enrolmentId: e.enrolmentId,
    checkInId: e.checkInId,
    assignedToId: e.assignedToId,
    assignedToName: e.assignedToId ? (names.users.get(e.assignedToId) ?? null) : null,
    outOfHours: e.outOfHours,
    createdAt: e.createdAt.toISOString(),
    dueAt: e.dueAt.toISOString(),
    acknowledgedAt: iso(e.acknowledgedAt),
    acknowledgedByName: e.acknowledgedById ? (names.users.get(e.acknowledgedById) ?? null) : null,
    resolvedAt: iso(e.resolvedAt),
    resolvedByName: e.resolvedById ? (names.users.get(e.resolvedById) ?? null) : null,
    resolution: e.resolution,
  };
}
