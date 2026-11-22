import { Prisma, type Escalation, type TriageLevel } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zText } from "@/lib/validation";
import { notify, settleNotifications } from "@/modules/notifications/service";
import { getTenantTimezone } from "@/modules/appointments/service";
import type { EscalationDTO } from "./dto";
import { ConciergeError, ConciergeNotFoundError } from "./errors";
import { isWithinHours, readConciergeSettings, resolveAssignee, WATCH_ACK_MINUTES, type Assignment } from "./settings";
import { detailsOf, nameMapsFor, SYSTEM_ACTOR, toEscalationDTO, type Actor } from "./shared";
import type { TriageFlag } from "./triage";

/**
 * Escalations: something a named human must look at within a target time. A
 * high-risk or out-of-range check-in opens one, a missed high-risk check-in
 * opens one, and the board acknowledges and resolves them. The assignee comes
 * from the roster (in hours / out of hours on the clinic clock) and the target
 * from the settings: 15 minutes in hours, 30 out of hours for HIGH_RISK, four
 * hours for WATCH. Past the target, a HIGH_RISK one is told again to the
 * assignee, the backup and the owner, as soon as it is overdue and then every
 * 30 minutes until someone acknowledges it; a WATCH one (an out-of-range answer,
 * a missed check-in) reminds the assignee and the backup once, as a warning.
 * Each reminder replaces the person's earlier unread alert for the same case,
 * and acknowledging or resolving the case clears its alerts for everyone.
 */
export const RE_NOTIFY_EVERY_MS = 30 * 60_000;

/** How many overdue reminders an escalation gets: high risk until acknowledged, watch once. */
export const MAX_REMINDERS: Record<"WATCH" | "HIGH_RISK", number> = { WATCH: 1, HIGH_RISK: Number.POSITIVE_INFINITY };

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

/** Who and by when, decided before the row is written (reads only). */
export interface EscalationPlan {
  input: OpenEscalationInput;
  now: Date;
  outOfHours: boolean;
  assignment: Assignment;
  minutes: number;
  dueAt: Date;
}

const LEVEL_WORD: Record<TriageLevel, string> = { OK: "OK", WATCH: "Watch", HIGH_RISK: "High risk" };

type Client = Prisma.TransactionClient;

/** Resolve the roster and the target for an escalation opened `now`. */
export async function planEscalation(tenantId: string, input: OpenEscalationInput): Promise<EscalationPlan> {
  const now = input.now ?? new Date();
  const [settings, timezone] = await Promise.all([readConciergeSettings(tenantId), getTenantTimezone(tenantId)]);
  const outOfHours = !isWithinHours(now, timezone, settings.hours);
  const assignment = await resolveAssignee(tenantId, settings, outOfHours);
  const minutes = input.level === "HIGH_RISK" ? assignment.ackMinutes : WATCH_ACK_MINUTES;
  return { input, now, outOfHours, assignment, minutes, dueAt: new Date(now.getTime() + minutes * 60_000) };
}

/** Write the escalation and its timeline line (inside the caller's transaction). */
export async function insertEscalation(tx: Client, tenantId: string, plan: EscalationPlan): Promise<Escalation> {
  const { input, now, outOfHours, assignment, minutes, dueAt } = plan;
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
        reminders: 0,
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
}

/** After the commit: the audit row and the notifications (assignee, backup; the owner for high risk). */
export async function announceEscalation(tenantId: string, row: Escalation, plan: EscalationPlan): Promise<void> {
  const { input, outOfHours, assignment, minutes } = plan;
  const actor = input.actor ?? SYSTEM_ACTOR;
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.escalation.open",
    entity: "Escalation",
    entityId: row.id,
    after: { level: input.level, assignedToId: assignment.assignedToId, outOfHours, dueAt: row.dueAt, targetMinutes: minutes, summary: input.summary },
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
      entityId: row.id,
      userIds: recipients,
      // The owner hears about every high-risk reply; watch items stay with the roster.
      roles: input.level === "HIGH_RISK" ? ["CLINIC_OWNER"] : [],
      forceEmail: input.level === "HIGH_RISK",
    });
  } catch (err) {
    console.error("[concierge] escalation notification failed", err);
  }
}

/** Open an escalation, assign it per the roster and tell the assignee (and the owner for high risk). */
export async function openEscalation(tenantId: string, input: OpenEscalationInput): Promise<Escalation> {
  const plan = await planEscalation(tenantId, input);
  const row = await db.$transaction((tx) => insertEscalation(tx, tenantId, plan));
  await announceEscalation(tenantId, row, plan);
  return row;
}

// ── Reading ──────────────────────────────────────────────────────────────────

export const EscalationListQuery = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "open"]).optional(),
  level: z.enum(["WATCH", "HIGH_RISK"]).optional(),
  enrolmentId: zText(64).optional(),
  assignedToId: zText(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type EscalationListQuery = z.input<typeof EscalationListQuery>;

export async function toEscalationDTOs(tenantId: string, rows: Escalation[]): Promise<EscalationDTO[]> {
  const names = await nameMapsFor(tenantId, rows);
  return rows.map((r) => toEscalationDTO(r, names));
}

/** Concierge escalations, most urgent target first; `status=open` means OPEN or ACKNOWLEDGED. */
export async function listEscalations(tenantId: string, rawQuery: EscalationListQuery = {}) {
  const query = EscalationListQuery.parse(rawQuery);
  const where: Prisma.EscalationWhereInput = {
    tenantId,
    kind: "CONCIERGE",
    ...(query.status === "open" ? { status: { in: ["OPEN", "ACKNOWLEDGED"] } } : query.status ? { status: query.status } : {}),
    ...(query.level ? { level: query.level } : {}),
    ...(query.enrolmentId ? { enrolmentId: query.enrolmentId } : {}),
    ...(query.assignedToId ? { assignedToId: query.assignedToId } : {}),
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
  // Only concierge escalations are handled here; lead follow-ups have their own screens.
  const row = await db.escalation.findFirst({ where: { id, tenantId, kind: "CONCIERGE" } });
  if (!row) throw new ConciergeNotFoundError("escalation", id);
  return row;
}

// ── Acknowledge / resolve ────────────────────────────────────────────────────

function minutesLate(dueAt: Date, at: Date): number {
  return Math.max(0, Math.round((at.getTime() - dueAt.getTime()) / 60_000));
}

export async function acknowledgeEscalation(tenantId: string, id: string, actor: Actor = {}, now = new Date()): Promise<EscalationDTO> {
  const before = await requireEscalation(tenantId, id);
  if (before.status !== "OPEN") throw new ConciergeError("invalid_state", `an escalation that is ${before.status} cannot be acknowledged`);
  const withinTarget = now.getTime() <= before.dueAt.getTime();
  const after = await db.$transaction(async (tx) => {
    // Two people pressing Acknowledge at once: the first one wins, the second gets a 409.
    const claimed = await tx.escalation.updateMany({
      where: { id, tenantId, status: "OPEN" },
      data: { status: "ACKNOWLEDGED", acknowledgedAt: now, acknowledgedById: actor.id ?? null },
    });
    if (!claimed.count) throw new ConciergeError("invalid_state", "someone acknowledged this escalation a moment ago");
    if (before.patientId) {
      const minutes = Math.round((now.getTime() - before.createdAt.getTime()) / 60_000);
      await tx.timelineEvent.create({
        data: {
          tenantId,
          patientId: before.patientId,
          kind: "ESCALATION",
          title: "Escalation acknowledged",
          body: `${before.summary} · after ${minutes} min${withinTarget ? ", within target" : `, ${minutesLate(before.dueAt, now)} min past the target`}`,
          refId: before.id,
          occurredAt: now,
        },
      });
    }
    return tx.escalation.findUniqueOrThrow({ where: { id } });
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
    after: { status: after.status, acknowledgedAt: now, withinTarget },
  });
  await settleEscalationAlerts(tenantId, id, now);
  const [dto] = await toEscalationDTOs(tenantId, [after]);
  return dto!;
}

export const ResolveInput = z.object({ resolution: zText(1000).min(1, "Say what was done") });

export async function resolveEscalation(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, now = new Date()): Promise<EscalationDTO> {
  const input = ResolveInput.parse(rawInput ?? {});
  const before = await requireEscalation(tenantId, id);
  if (before.status === "RESOLVED") throw new ConciergeError("invalid_state", "this escalation is already resolved");
  const after = await db.$transaction(async (tx) => {
    const claimed = await tx.escalation.updateMany({
      where: { id, tenantId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolvedById: actor.id ?? null,
        resolution: input.resolution,
        // Resolving an unacknowledged escalation acknowledges it at the same moment.
        ...(before.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedById: actor.id ?? null }),
      },
    });
    if (!claimed.count) throw new ConciergeError("invalid_state", "someone resolved this escalation a moment ago");
    if (before.patientId) {
      await tx.timelineEvent.create({
        data: {
          tenantId,
          patientId: before.patientId,
          kind: "ESCALATION",
          title: "Escalation resolved",
          body: input.resolution,
          refId: before.id,
          occurredAt: now,
        },
      });
    }
    return tx.escalation.findUniqueOrThrow({ where: { id } });
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
  await settleEscalationAlerts(tenantId, id, now);
  const [dto] = await toEscalationDTOs(tenantId, [after]);
  return dto!;
}

/** A person has the case: its alerts stop calling (never fails the acknowledgement). */
async function settleEscalationAlerts(tenantId: string, id: string, now: Date): Promise<void> {
  try {
    await settleNotifications(tenantId, { kind: "ESCALATION", entity: "Escalation", entityId: id }, now);
  } catch (err) {
    console.error("[concierge] clearing the escalation's alerts failed", err);
  }
}

// ── Overdue acknowledgements ─────────────────────────────────────────────────

const remindersOf = (details: Record<string, unknown> | null | undefined): number =>
  typeof details?.reminders === "number" ? details.reminders : 0;

/** Whether an OPEN, overdue escalation is owed a reminder `now`. */
export function reminderDue(e: Pick<Escalation, "level" | "details">, now: Date): boolean {
  const details = detailsOf(e.details);
  if (remindersOf(details) >= MAX_REMINDERS[e.level === "HIGH_RISK" ? "HIGH_RISK" : "WATCH"]) return false;
  const last = details?.lastReminderAt;
  const lastAt = typeof last === "string" ? Date.parse(last) : Number.NaN;
  return Number.isNaN(lastAt) || now.getTime() - lastAt >= RE_NOTIFY_EVERY_MS;
}

/**
 * OPEN escalations past their target. High risk: the assignee, the backup and
 * the owner are told again as soon as the target passes, then at most every 30
 * minutes (`details.lastReminderAt`) until someone acknowledges it, as a
 * critical alert. Watch: the assignee and the backup are reminded once, as a
 * warning. Returns how many escalations were re-notified.
 */
export async function notifyOverdueEscalations(tenantId: string, now = new Date()): Promise<number> {
  const overdue = { tenantId, kind: "CONCIERGE" as const, status: "OPEN" as const, dueAt: { lt: now } };
  // Two reads, so watch items already reminded never crowd high-risk ones out of the batch.
  const [high, watch] = await Promise.all([
    db.escalation.findMany({ where: { ...overdue, level: "HIGH_RISK" }, orderBy: { dueAt: "asc" }, take: 100 }),
    db.escalation.findMany({
      where: { ...overdue, level: "WATCH", details: { path: ["lastReminderAt"], equals: Prisma.AnyNull } },
      orderBy: { dueAt: "asc" },
      take: 100,
    }),
  ]);
  const due = [...high, ...watch].filter((e) => reminderDue(e, now));
  if (!due.length) return 0;
  const names = await nameMapsFor(tenantId, due);
  let notified = 0;
  for (const e of due) {
    const details = detailsOf(e.details) ?? {};
    // Claim this reminder first so two schedulers never send it twice.
    const claimed = await db.escalation.updateMany({
      where: { id: e.id, status: "OPEN", updatedAt: e.updatedAt },
      data: { details: { ...details, lastReminderAt: now.toISOString(), reminders: (typeof details.reminders === "number" ? details.reminders : 0) + 1 } as Prisma.InputJsonObject },
    });
    if (!claimed.count) continue;
    const backup = typeof details.backupUserId === "string" ? details.backupUserId : null;
    const overdueMinutes = minutesLate(e.dueAt, now);
    const patient = e.patientId ? (names.patients.get(e.patientId) ?? "a patient") : "a patient";
    const highRisk = e.level === "HIGH_RISK";
    try {
      await notify(tenantId, {
        kind: "ESCALATION",
        level: highRisk ? "CRITICAL" : "WARNING",
        title: `Still unacknowledged (${overdueMinutes} min overdue) · ${patient}: ${e.summary}`,
        body: highRisk
          ? "Nobody has acknowledged this high-risk escalation. Open the concierge board and take it."
          : "Nobody has acknowledged this watch escalation. Open the concierge board and take it; this is the only reminder.",
        href: e.enrolmentId ? `/dashboard/concierge/enrolments/${e.enrolmentId}` : "/dashboard/concierge",
        entity: "Escalation",
        entityId: e.id,
        userIds: [e.assignedToId, backup].filter((id): id is string => Boolean(id)),
        // The owner is pulled in for high risk only; a watch item stays with the roster.
        roles: highRisk ? ["CLINIC_OWNER"] : [],
        forceEmail: highRisk,
        supersede: true,
      });
      notified += 1;
    } catch (err) {
      console.error("[concierge] overdue notification failed", err);
    }
  }
  return notified;
}

/** Open concierge escalations, and how many are past their target (for the page's tab badge). */
export async function countOpenEscalations(tenantId: string, now = new Date()): Promise<{ open: number; overdue: number }> {
  const [open, overdue] = await Promise.all([
    db.escalation.count({ where: { tenantId, kind: "CONCIERGE", status: "OPEN" } }),
    db.escalation.count({ where: { tenantId, kind: "CONCIERGE", status: "OPEN", dueAt: { lt: now } } }),
  ]);
  return { open, overdue };
}
