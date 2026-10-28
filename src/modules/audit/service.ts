import type { Prisma, UserRole } from "@prisma/client";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { dateKeyInTz, formatDateInTz, formatTimeInTz, fromDateKey } from "@/lib/time";
import { csvCell } from "@/modules/patients/export";
import {
  actionFilter,
  changedFields,
  describeAction,
  displayValue,
  fieldLabel,
  type AuditQuery,
  type FieldChange,
} from "@/modules/audit/query";

export const AUDIT_PAGE_SIZE = 50;
/** One export file at most; narrow the filters for more. */
export const AUDIT_EXPORT_LIMIT = 100_000;
const EXPORT_BATCH = 1_000;

export interface AuditActor {
  id: string | null;
  name: string;
  email: string | null;
  role: UserRole | null;
}

export interface AuditRow {
  id: string;
  createdAt: Date;
  action: string;
  label: string;
  entity: string;
  entityId: string | null;
  actor: AuditActor;
  patient: { id: string; fullName: string; archived: boolean } | null;
  /** The team member an entry is about (sign-ins, invitations, clinician marks). */
  subject: string | null;
  ip: string | null;
  device: string | null;
  changes: FieldChange[];
  before: unknown;
  after: unknown;
}

/** The Prisma filter for a query on one clinic's log (`timezone` reads the from/to days). */
export function auditWhere(tenantId: string, query: AuditQuery, timezone: string): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [{ tenantId }];
  if (query.actor === "system") and.push({ actorId: null });
  else if (query.actor) and.push({ actorId: query.actor });
  if (query.patient) and.push({ patientId: query.patient });
  if (query.action) {
    const f = actionFilter(query.action);
    and.push("exact" in f ? { action: f.exact } : { OR: f.prefixes.map((p) => ({ action: { startsWith: `${p}.` } })) });
  }
  const from = query.from ? fromDateKey(query.from, timezone) : null;
  const toStart = query.to ? fromDateKey(query.to, timezone) : null;
  // The day after `to`, at local midnight: an exclusive upper bound that survives DST.
  const toEnd = toStart && query.to ? fromDateKey(nextDayKey(query.to), timezone) : null;
  if (from || toEnd) and.push({ createdAt: { ...(from ? { gte: from } : {}), ...(toEnd ? { lt: toEnd } : {}) } });
  if (query.q) {
    const q = query.q;
    and.push({
      OR: [
        { action: { contains: q, mode: "insensitive" } },
        { entity: { contains: q, mode: "insensitive" } },
        { entityId: q },
        { patientId: q },
        { actorEmail: { contains: q, mode: "insensitive" } },
        { ip: q },
      ],
    });
  }
  return { AND: and };
}

function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

type LogRow = Prisma.AuditLogGetPayload<object>;

async function decorate(tenantId: string, rows: LogRow[]): Promise<AuditRow[]> {
  const actorIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.actorId, r.entity === "User" ? r.entityId : null])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const patientIds = [...new Set(rows.map((r) => r.patientId).filter((id): id is string => Boolean(id)))];
  const [users, patients] = await Promise.all([
    actorIds.length
      ? db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true, email: true, role: true } })
      : Promise.resolve([]),
    patientIds.length
      ? db.patient.findMany({ where: { id: { in: patientIds }, tenantId }, select: { id: true, fullName: true, deletedAt: true } })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const patientById = new Map(patients.map((p) => [p.id, p]));
  return rows.map((r) => {
    const user = r.actorId ? userById.get(r.actorId) : undefined;
    const patient = r.patientId ? patientById.get(r.patientId) : undefined;
    return {
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      label: describeAction(r.action),
      entity: r.entity,
      entityId: r.entityId,
      actor: r.actorId
        ? {
            id: r.actorId,
            name: user?.fullName ?? r.actorEmail ?? "Former team member",
            email: user?.email ?? r.actorEmail,
            role: user?.role ?? null,
          }
        : { id: null, name: "ClinicMind (automatic)", email: null, role: null },
      patient: patient ? { id: patient.id, fullName: patient.fullName, archived: Boolean(patient.deletedAt) } : null,
      subject: r.entity === "User" && r.entityId ? (userById.get(r.entityId)?.fullName ?? null) : null,
      ip: r.ip,
      device: r.device,
      changes: changedFields(r.before, r.after),
      before: r.before,
      after: r.after,
    };
  });
}

/** One page of the log, newest first; a page past the end shows the last page. */
export async function listAuditLogs(
  tenantId: string,
  query: AuditQuery,
  timezone: string,
  pageSize = AUDIT_PAGE_SIZE,
): Promise<{ rows: AuditRow[]; total: number; page: number; pageSize: number }> {
  const where = auditWhere(tenantId, query, timezone);
  const total = await db.auditLog.count({ where });
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, query.page ?? 1), lastPage);
  const rows = await db.auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { rows: await decorate(tenantId, rows), total, page, pageSize };
}

/**
 * People to filter by: the clinic's team (including disabled accounts, whose
 * past actions stay in the log), anyone else who appears in the log (the
 * platform administrator), and automated entries.
 */
export async function listAuditPeople(tenantId: string): Promise<{ value: string; label: string }[]> {
  const team = await db.user.findMany({
    where: { tenantId },
    orderBy: [{ fullName: "asc" }],
    select: { id: true, fullName: true, email: true, deletedAt: true, status: true },
  });
  const others = await db.auditLog.groupBy({
    by: ["actorId", "actorEmail"],
    where: { tenantId, actorId: { not: null, notIn: team.map((u) => u.id) } },
    orderBy: { actorEmail: "asc" },
    take: 50,
  });
  return [
    ...team.map((u) => ({
      value: u.id,
      label: `${u.fullName}${u.deletedAt || u.status === "DISABLED" ? " (former)" : ""}`,
    })),
    ...others
      .filter((o): o is typeof o & { actorId: string } => Boolean(o.actorId))
      .map((o) => ({ value: o.actorId, label: `${o.actorEmail ?? "Unknown"} (platform)` })),
    { value: "system", label: "ClinicMind (automatic)" },
  ];
}

export const AUDIT_CSV_COLUMNS = [
  "Time (UTC)",
  "Date",
  "Time",
  "Person",
  "E-mail",
  "Action",
  "Action code",
  "Record",
  "Record ID",
  "Patient",
  "Patient ID",
  "IP",
  "Device",
  "Changes",
  "Before",
  "After",
] as const;

function changesCell(changes: FieldChange[]): string {
  return changes.map((c) => `${fieldLabel(c.field)}: ${c.from ?? "—"} → ${c.to ?? "—"}`).join("; ");
}

function snapshotCell(value: unknown): string {
  return value === null || value === undefined ? "" : (displayValue(value, 4_000) ?? "");
}

export function auditCsvRow(row: AuditRow, timezone: string): string {
  return [
    row.createdAt.toISOString(),
    formatDateInTz(row.createdAt, timezone, { year: "numeric", month: "2-digit", day: "2-digit" }),
    formatTimeInTz(row.createdAt, timezone),
    row.actor.name,
    row.actor.email,
    row.label,
    row.action,
    row.subject ? `${row.entity}: ${row.subject}` : row.entity,
    row.entityId,
    row.patient?.fullName ?? "",
    row.patient?.id ?? "",
    row.ip,
    row.device,
    changesCell(row.changes),
    snapshotCell(row.before),
    snapshotCell(row.after),
  ]
    .map((v) => csvCell(v ?? ""))
    .join(",");
}

const BOM = "﻿";

/**
 * The filtered log as a CSV stream (newest first, at most AUDIT_EXPORT_LIMIT
 * rows), read in batches so a large export never sits in memory. The file is
 * pinned to the entries that existed when it was requested: entries written
 * while it downloads (including the export's own entry) never push older ones
 * out of it. The export is itself audited, with the filters and the row count,
 * before the first byte leaves.
 */
export async function exportAuditCsv(
  tenantId: string,
  query: AuditQuery,
  timezone: string,
  actor: { id: string | null; email: string | null; ip: string | null },
): Promise<{ stream: ReadableStream<Uint8Array>; filename: string; rows: number; truncated: boolean }> {
  const filtered = auditWhere(tenantId, query, timezone);
  const order: Prisma.AuditLogOrderByWithRelationInput[] = [{ createdAt: "desc" }, { id: "desc" }];
  const top = await db.auditLog.findFirst({ where: filtered, orderBy: order, select: { id: true, createdAt: true } });
  // Everything at or after the newest matching entry, in the export's order.
  const where: Prisma.AuditLogWhereInput = top
    ? { AND: [filtered, { OR: [{ createdAt: { lt: top.createdAt } }, { createdAt: top.createdAt, id: { lte: top.id } }] }] }
    : filtered;
  const total = top ? await db.auditLog.count({ where }) : 0;
  const rows = Math.min(total, AUDIT_EXPORT_LIMIT);
  const ownEntry = await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "audit.export",
    entity: "AuditLog",
    patientId: null,
    after: { filters: { ...query, page: undefined }, rows, truncated: total > rows },
  });
  const batchWhere: Prisma.AuditLogWhereInput = ownEntry ? { AND: [where, { NOT: { id: ownEntry } }] } : where;

  const encoder = new TextEncoder();
  let cursor: string | null = null;
  let sent = 0;
  let headerSent = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(BOM + AUDIT_CSV_COLUMNS.map((c) => csvCell(c)).join(",") + "\r\n"));
          return;
        }
        if (sent >= rows) {
          controller.close();
          return;
        }
        const batch: LogRow[] = await db.auditLog.findMany({
          where: batchWhere,
          orderBy: order,
          take: Math.min(EXPORT_BATCH, rows - sent),
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (!batch.length) {
          controller.close();
          return;
        }
        cursor = batch[batch.length - 1]!.id;
        sent += batch.length;
        const decorated = await decorate(tenantId, batch);
        controller.enqueue(encoder.encode(decorated.map((r) => auditCsvRow(r, timezone)).join("\r\n") + "\r\n"));
      } catch (err) {
        controller.error(err);
      }
    },
  });
  const stamp = dateKeyInTz(new Date(), timezone);
  return { stream, filename: `audit-log-${stamp}.csv`, rows, truncated: total > rows };
}
