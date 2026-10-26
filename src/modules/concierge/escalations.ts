import type { Escalation, Prisma, TriageLevel } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zText } from "@/lib/validation";
import { notify } from "@/modules/notifications/service";
import { getTenantTimezone } from "@/modules/appointments/service";
import type { EscalationDTO } from "./dto";
import { ConciergeError, ConciergeNotFoundError } from "./errors";
import { isWithinHours, readConciergeSettings, resolveAssignee, WATCH_ACK_MINUTES } from "./settings";
import { nameMapsFor, SYSTEM_ACTOR, toEscalationDTO, type Actor } from "./shared";
import type { TriageFlag } from "./triage";

/**
 * Escalations: something a named human must look at within a target time. A
 * high-risk or out-of-range check-in opens one, a missed high-risk check-in
 * opens one, and the board acknowledges and resolves them. The assignee comes
 * from the roster (in hours / out of hours on the clinic clock) and the target
 * from the settings: 15 minutes in hours, 30 out of hours for HIGH_RISK, four
 * hours for WATCH.
 */
export const RE_NOTIFY_EVERY_MS = 30 * 60_000;

export interface OpenEscalationInput {
  level: Extract<TriageLevel, "WATCH" | "HIGH_RISK">;
  summary: string;
  patientId: string;
  patientName: string;
  enrolmentId: string;
  checkInId?: string | null;
  flags?: TriageFlag[];
  details?: Record<string, unknown>;
  now?: Date;
  actor?: Actor;
}

const LEVEL_WORD: Record<TriageLevel, string> = { OK: "OK", WATCH: "Watch", HIGH_RISK: "High risk" };

/** Open an escalation, assign it per the roster and tell the assignee and the owner. */
export async function openEscalation(tenantId: string, input: OpenEscalationInput): Promise<Escalation> {
  const now = input.now ?? new Date();
  const [settings, timezone] = await Promise.all([readConciergeSettings(tenantId), getTenantTimezone(tenantId)]);
  const outOfHours = !isWithinHours(now, timezone, settings.hours);
  const assignment = await resolveAssignee(tenantId, settings, outOfHours);
  const minutes = input.level === "HIGH_RISK" ? assignment.ackMinutes : WATCH_ACK_MINUTES;
  const dueAt = new Date(now.getTime() + minutes * 60_000);

  const escalation = await db.$transaction(async (tx) => {
    const row = await tx.escalation.create({
      data: {
        tenantId,
        kind: "CONCIERGE",
        level: input.level,
        status: "OPEN",
        enrolmentId: input.enrolmentId,
        checkInId: input.checkInId ?? null,
        patientId: input.patientId,
        summary: input.summary,
        details: {
          ...(input.details ?? {}),
          flags: input.flags ?? [],
          targetMinutes: minutes,
          backupUserId: assignment.backupId,
        } as unknown as Prisma.InputJsonObject,
        assignedToId: assignment.assignedToId,
        outOfHours,
        dueAt,
        createdAt: now,
      },
    });
    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: input.patientId,
        kind: "ESCALATION",
        title: `${LEVEL_WORD[input.level]} escalation opened`,
        body: `${input.summary} · ${outOfHours ? "out of hours" : "in hours"}, target ${minutes} min`,
        refId: row.id,
        occurredAt: now,
      },
    });
    return row;
  });

  const actor = input.actor ?? SYSTEM_ACTOR;
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.escalation.open",
    entity: "Escalation",
    entityId: escalation.id,
    after: { level: input.level, assignedToId: assignment.assignedToId, outOfHours, dueAt, summary: input.summary },
  });

  const recipients = [assignment.assignedToId, assignment.backupId].filter((id): id is string => Boolean(id));
  try {
    await notify(tenantId, {
      kind: "ESCALATION",
      level: input.level === "HIGH_RISK" ? "CRITICAL" : "WARNING",
      title: `${LEVEL_WORD[input.level]} · ${input.patientName}: ${input.summary}`,
      body: `${outOfHours ? "Out of hours" : "In hours"} · acknowledge within ${minutes} minutes.`,
      href: `/dashboard/concierge/enrolments/${input.enrolmentId}`,
      entity: "Escalation",
      entityId: escalation.id,
      userIds: recipients,
      roles: ["CLINIC_OWNER"],
      forceEmail: input.level === "HIGH_RISK",
    });
  } catch (err) {
    console.error("[concierge] escalation notification failed", err);
  }
  return escalation;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export const EscalationListQuery = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "open"]).optional(),
  level: z.enum(["WATCH", "HIGH_RISK"]).optional(),
  enrolmentId: zText(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type EscalationListQuery = z.infer<typeof EscalationListQuery>;

export async function toEscalationDTOs(tenantId: string, rows: Escalation[]): Promise<EscalationDTO[]> {
  const names = await nameMapsFor(tenantId, rows);
  return rows.map((r) => toEscalationDTO(r, names));
}

/** Concierge escalations, newest due first; `status=open` means OPEN or ACKNOWLEDGED. */
export async function listEscalations(tenantId: string, query: EscalationListQuery) {
  const where: Prisma.EscalationWhereInput = {
    tenantId,
    kind: "CONCIERGE",
    ...(query.status === "open" ? { status: { in: ["OPEN", "ACKNOWLEDGED"] } } : query.status ? { status: query.status } : {}),
    ...(query.level ? { level: query.level } : {}),
    ...(query.enrolmentId ? { enrolmentId: query.enrolmentId } : {}),
  };
  const [rows, total] = await db.$transaction([
    db.escalation.findMany({
      where,
      orderBy: query.status === "RESOLVED" ? [{ resolvedAt: "desc" }] : [{ dueAt: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    db.escalation.count({ where }),
  ]);
  return { escalations: await toEscalationDTOs(tenantId, rows), total, page: query.page, pageSize: query.pageSize };
}

async function requireEscalation(tenantId: string, id: string) {
  const row = await db.escalation.findFirst({ where: { id, tenantId } });
  if (!row) throw new ConciergeNotFoundError("escalation", id);
  return row;
}

// ── Acknowledge / resolve ────────────────────────────────────────────────────

export async function acknowledgeEscalation(tenantId: string, id: string, actor: Actor = {}, now = new Date()): Promise<EscalationDTO> {
  const before = await requireEscalation(tenantId, id);
  if (before.status !== "OPEN") throw new ConciergeError("invalid_state", `an escalation that is ${before.status} cannot be acknowledged`);
  const after = await db.escalation.update({
    where: { id },
    data: { status: "ACKNOWLEDGED", acknowledgedAt: now, acknowledgedById: actor.id ?? null },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.escalation.acknowledge",
    entity: "Escalation",
    entityId: id,
    before: { status: before.status },
    after: { status: after.status, acknowledgedAt: now, withinTarget: now.getTime() <= before.dueAt.getTime() },
  });
  const [dto] = await toEscalationDTOs(tenantId, [after]);
  return dto!;
}

export const ResolveInput = z.object({ resolution: zText(1000).min(1, "Say what was done") });

export async function resolveEscalation(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, now = new Date()): Promise<EscalationDTO> {
  const input = ResolveInput.parse(rawInput);
  const before = await requireEscalation(tenantId, id);
  if (before.status === "RESOLVED") throw new ConciergeError("invalid_state", "this escalation is already resolved");
  const after = await db.$transaction(async (tx) => {
    const row = await tx.escalation.update({
      where: { id },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolvedById: actor.id ?? null,
        resolution: input.resolution,
        // Resolving an unacknowledged escalation acknowledges it at the same moment.
        ...(before.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedById: actor.id ?? null }),
      },
    });
    if (row.patientId) {
      await tx.timelineEvent.create({
        data: {
          tenantId,
          patientId: row.patientId,
          kind: "ESCALATION",
          title: "Escalation resolved",
          body: input.resolution,
          refId: row.id,
          occurredAt: now,
        },
      });
    }
    return row;
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.escalation.resolve",
    entity: "Escalation",
    entityId: id,
    before: { status: before.status },
    after: { status: after.status, resolution: input.resolution },
  });
  const [dto] = await toEscalationDTOs(tenantId, [after]);
  return dto!;
}

// ── Overdue acknowledgements ─────────────────────────────────────────────────

/**
 * OPEN escalations past their target: tell the assignee again, plus the owner,
 * at most once per 30 minutes (`updatedAt` is the stamp of the last reminder).
 */
export async function notifyOverdueEscalations(tenantId: string, now = new Date()): Promise<number> {
  const stale = new Date(now.getTime() - RE_NOTIFY_EVERY_MS);
  const rows = await db.escalation.findMany({
    where: { tenantId, kind: "CONCIERGE", status: "OPEN", dueAt: { lt: now }, updatedAt: { lte: stale } },
    orderBy: { dueAt: "asc" },
    take: 50,
  });
  if (!rows.length) return 0;
  const names = await nameMapsFor(tenantId, rows);
  for (const e of rows) {
    const details = e.details && typeof e.details === "object" && !Array.isArray(e.details) ? (e.details as Record<string, unknown>) : {};
    const backup = typeof details.backupUserId === "string" ? details.backupUserId : null;
    const overdueMinutes = Math.round((now.getTime() - e.dueAt.getTime()) / 60_000);
    const patient = e.patientId ? (names.patients.get(e.patientId) ?? "a patient") : "a patient";
    try {
      await notify(tenantId, {
        kind: "ESCALATION",
        level: "CRITICAL",
        title: `Still unacknowledged (${overdueMinutes} min overdue) · ${patient}: ${e.summary}`,
        body: `Nobody has acknowledged this ${e.level === "HIGH_RISK" ? "high-risk" : "watch"} escalation. Open the concierge board and take it.`,
        href: e.enrolmentId ? `/dashboard/concierge/enrolments/${e.enrolmentId}` : "/dashboard/concierge",
        entity: "Escalation",
        entityId: e.id,
        userIds: [e.assignedToId, backup].filter((id): id is string => Boolean(id)),
        roles: ["CLINIC_OWNER"],
        forceEmail: true,
      });
    } catch (err) {
      console.error("[concierge] overdue notification failed", err);
    }
    await db.escalation.update({ where: { id: e.id }, data: { updatedAt: now } });
  }
  return rows.length;
}
