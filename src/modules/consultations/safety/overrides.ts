import { z } from "zod";
import type { Prisma, UserRole } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { can, RbacError } from "@/lib/auth/rbac";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { csvLine } from "@/modules/patients/export";
import { PERIOD_PRESETS, resolvePeriod, type ResolvedPeriod } from "@/modules/reporting/period";
import type { SafetyOverrideListResponse, SafetyOverrideRow, SafetySeverity } from "../types";
import { ruleLabel, SEVERITY_LABEL } from "./labels";

/**
 * The owner's review list of prescribing-safety overrides: every stop a
 * clinician signed through with a reason and every warning acknowledged.
 * The clinic owner sees all of them; a doctor sees their own; other roles
 * nothing.
 */

export type OverrideScope = { kind: "all" } | { kind: "own"; userId: string };

/** reports:read to see the list at all; audit:read (the owner) to see everyone's. */
export function overrideScope(actor: { role: UserRole; userId: string | null }): OverrideScope {
  if (!can(actor.role, "reports:read")) throw new RbacError(`Role ${actor.role} lacks permission reports:read`);
  if (can(actor.role, "audit:read")) return { kind: "all" };
  if (!actor.userId) throw new RbacError("Only a signed-in clinician can see their safety overrides");
  return { kind: "own", userId: actor.userId };
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const OverrideListQuery = z.object({
  doctorId: z.preprocess(blank, z.string().trim().min(1).max(64).optional()),
  severity: z.preprocess(blank, z.enum(["stop", "warn"]).optional()),
  period: z.preprocess(blank, z.enum(PERIOD_PRESETS).optional()),
  from: z.preprocess(blank, dateKey.optional()),
  to: z.preprocess(blank, dateKey.optional()),
});
export type OverrideListQuery = z.infer<typeof OverrideListQuery>;

/** Overrides are rare: the list looks back 90 days unless told otherwise. */
export const DEFAULT_OVERRIDE_PERIOD = "90d" as const;

async function filters(tenantId: string, scope: OverrideScope, query: OverrideListQuery) {
  const timezone = await getTenantTimezone(tenantId);
  const period = resolvePeriod({ period: query.period ?? DEFAULT_OVERRIDE_PERIOD, from: query.from, to: query.to }, timezone, new Date(), DEFAULT_OVERRIDE_PERIOD);
  // A doctor only ever sees their own; the owner may narrow to one doctor.
  const base: Prisma.SafetyOverrideWhereInput = {
    tenantId,
    createdAt: { gte: period.from, lt: period.to },
    ...(scope.kind === "own" ? { userId: scope.userId } : query.doctorId ? { userId: query.doctorId } : {}),
  };
  const where: Prisma.SafetyOverrideWhereInput = query.severity ? { ...base, severity: query.severity } : base;
  return { base, where, period, timezone };
}

const rowSelect = {
  id: true,
  createdAt: true,
  rule: true,
  severity: true,
  medication: true,
  message: true,
  reason: true,
  consultationId: true,
  patientId: true,
  user: { select: { id: true, fullName: true, email: true } },
} satisfies Prisma.SafetyOverrideSelect;

type Row = Prisma.SafetyOverrideGetPayload<{ select: typeof rowSelect }>;

async function toRows(tenantId: string, rows: Row[]): Promise<SafetyOverrideRow[]> {
  const ids = [...new Set(rows.map((r) => r.patientId))];
  const patients = ids.length
    ? await db.patient.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, fullName: true } })
    : [];
  const names = new Map(patients.map((p) => [p.id, p.fullName]));
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    rule: r.rule,
    severity: (r.severity === "stop" ? "stop" : "warn") as SafetySeverity,
    medication: r.medication,
    message: r.message,
    reason: r.reason,
    consultationId: r.consultationId,
    doctor: { id: r.user.id, fullName: r.user.fullName ?? r.user.email },
    patient: { id: r.patientId, fullName: names.get(r.patientId) ?? null },
  }));
}

export async function listSafetyOverrides(
  tenantId: string,
  scope: OverrideScope,
  query: OverrideListQuery,
  paging: { page: number; pageSize: number },
): Promise<SafetyOverrideListResponse & { period: ResolvedPeriod; timezone: string; counts: { stop: number; warn: number } }> {
  const { base, where, period, timezone } = await filters(tenantId, scope, query);
  const [total, rows, bySeverity] = await Promise.all([
    db.safetyOverride.count({ where }),
    db.safetyOverride.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (paging.page - 1) * paging.pageSize,
      take: paging.pageSize,
      select: rowSelect,
    }),
    db.safetyOverride.groupBy({ by: ["severity"], where: base, _count: { _all: true } }),
  ]);
  const count = (s: string) => bySeverity.find((g) => g.severity === s)?._count._all ?? 0;
  return {
    overrides: await toRows(tenantId, rows),
    total,
    page: paging.page,
    pageSize: paging.pageSize,
    scope: scope.kind,
    period,
    timezone,
    counts: { stop: count("stop"), warn: count("warn") },
  };
}

/** Clinicians who have overrides, for the owner's doctor filter. */
export async function listOverrideDoctors(tenantId: string): Promise<{ id: string; fullName: string }[]> {
  const groups = await db.safetyOverride.groupBy({ by: ["userId"], where: { tenantId } });
  if (!groups.length) return [];
  const users = await db.user.findMany({
    where: { tenantId, id: { in: groups.map((g) => g.userId) } },
    orderBy: [{ fullName: "asc" }, { email: "asc" }],
    select: { id: true, fullName: true, email: true },
  });
  return users.map((u) => ({ id: u.id, fullName: u.fullName ?? u.email }));
}

export const EXPORT_LIMIT = 5000;
export const OVERRIDE_CSV_COLUMNS = ["Date", "Time", "Doctor", "Patient", "Medication", "Rule", "Severity", "Finding", "Reason", "Consultation"] as const;

/** The filtered list as CSV (UTF-8 with BOM for Excel, formula-safe cells), audited. */
export async function exportSafetyOverridesCsv(
  tenantId: string,
  scope: OverrideScope,
  query: OverrideListQuery,
  actor: { userId: string | null; email: string | null; ip?: string | null },
): Promise<{ csv: string; filename: string; rows: number; truncated: boolean }> {
  const { where, period, timezone } = await filters(tenantId, scope, query);
  const [total, raw] = await Promise.all([
    db.safetyOverride.count({ where }),
    db.safetyOverride.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: EXPORT_LIMIT, select: rowSelect }),
  ]);
  const rows = await toRows(tenantId, raw);
  const lines = [
    csvLine(OVERRIDE_CSV_COLUMNS),
    ...rows.map((r) => {
      const at = new Date(r.createdAt);
      return csvLine([
        formatDateInTz(at, timezone, { year: "numeric", month: "2-digit", day: "2-digit" }),
        formatTimeInTz(at, timezone),
        r.doctor.fullName,
        r.patient.fullName,
        r.medication,
        ruleLabel(r.rule),
        SEVERITY_LABEL[r.severity],
        r.message,
        r.reason,
        r.consultationId,
      ]);
    }),
  ];
  await audit({
    tenantId,
    actorId: actor.userId,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "safety_override.export",
    entity: "SafetyOverride",
    after: { scope: scope.kind, filters: { ...query, from: period.fromKey, to: period.toKey }, rows: rows.length, total, format: "csv" },
  });
  return {
    csv: `﻿${lines.join("\r\n")}\r\n`,
    filename: `safety-overrides-${period.fromKey}-to-${period.toKey}.csv`,
    rows: rows.length,
    truncated: total > rows.length,
  };
}

/** Stops overridden in the last 28 days within the scope, for the badge on the consultations page. */
export async function countRecentOverrides(tenantId: string, scope: OverrideScope, now: Date = new Date()): Promise<number> {
  return db.safetyOverride.count({
    where: {
      tenantId,
      severity: "stop",
      createdAt: { gte: new Date(now.getTime() - 28 * 86_400_000) },
      ...(scope.kind === "own" ? { userId: scope.userId } : {}),
    },
  });
}
