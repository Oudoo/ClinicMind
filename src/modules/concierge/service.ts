import { Prisma, type CheckIn, type ConciergeEnrolment, type ConciergeTask, type Escalation, type Protocol } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { addDays, endOfDayInTz, startOfDayInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listTreatments, requireTenantTreatment } from "@/modules/treatments/service";
import type {
  BoardCheckInDTO,
  BoardDTO,
  BoardTaskDTO,
  EnrolmentDetailDTO,
  EnrolmentListDTO,
  EnrolmentStatus,
  EnrolmentSummaryDTO,
  EscalationDTO,
  ProtocolDTO,
  TreatmentProtocolsDTO,
} from "./dto";
import { ConciergeError, ConciergeNotFoundError } from "./errors";
import { toEscalationDTOs } from "./escalations";
import {
  DEFAULT_PROTOCOLS,
  dayLabel,
  parseSteps,
  pickLanguage,
  protocolLengthDays,
  stepHasHighRisk,
  zSteps,
  type ProtocolStep,
} from "./protocols";
import { isWithinHours, readConciergeSettings, resolveRoster } from "./settings";
import { stepTitle } from "./labels";
import { flagsOf, iso, nameMapsFor, toEscalationDTO, toTaskDTO, userNames, type Actor } from "./shared";

/**
 * Post-treatment concierge (Module 5). The finance module calls
 * `enrolOnSignedProcedure` the moment a doctor signs a procedure; the concierge
 * module owns everything after that (protocols, tasks, check-ins, triage,
 * escalations). This file is the contract between the two, plus the enrolment
 * lifecycle, protocol versions, the board and the patient card.
 */
export type EnrolActor = Actor;

export interface EnrolmentSummary {
  enrolmentId: string;
  protocolId: string;
  tasks: number;
}

type Client = Prisma.TransactionClient;

/** Check-ins and photo requests never go out before this hour on the clinic clock. */
export const EARLIEST_CHECK_IN_HOUR = 10;

const DAY_MS = 86_400_000;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// ── Default protocols ────────────────────────────────────────────────────────

/**
 * Create version 1 (ACTIVE) of the default protocol for every treatment of
 * the tenant that has no protocol yet. Idempotent (two callers racing on the
 * first sign-off both succeed); used on first enrolment and by the seed.
 * Returns how many were created.
 */
export async function ensureDefaultProtocols(tenantId: string, client: Client = db): Promise<number> {
  const treatments = await listTreatments(tenantId, {}, client);
  const existing = await client.protocol.groupBy({ by: ["treatmentId"], where: { tenantId } });
  const covered = new Set(existing.map((e) => e.treatmentId));
  let created = 0;
  for (const def of DEFAULT_PROTOCOLS) {
    const treatment = treatments.find((t) => t.key === def.treatmentKey);
    if (!treatment || covered.has(treatment.id)) continue;
    try {
      await client.protocol.create({
        data: {
          tenantId,
          treatmentId: treatment.id,
          name: def.name,
          version: 1,
          status: "ACTIVE",
          steps: def.steps as unknown as Prisma.InputJsonValue,
          notes: "Default protocol",
          approvedAt: new Date(),
        },
      });
      created += 1;
    } catch (err) {
      // Another request created version 1 a moment ago: that one stands.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return created;
}

// ── Scheduling ───────────────────────────────────────────────────────────────

export interface PlannedTask {
  stepIndex: number;
  kind: ProtocolStep["kind"];
  title: string;
  dueAt: Date;
}

/**
 * When each step goes out, on the clinic clock: the whole days of
 * `offsetHours` are calendar days (so "day 7" keeps the time of the procedure
 * across a daylight-saving change), the remaining hours are added as elapsed
 * time. Check-ins and photo requests that would land before 10:00 move to
 * 10:00 the same day; instructions keep the computed time.
 */
export function planTasks(steps: readonly ProtocolStep[], performedAt: Date, timeZone: string): PlannedTask[] {
  return steps.map((step, stepIndex) => {
    const days = Math.floor(step.offsetHours / 24);
    const hours = step.offsetHours - days * 24;
    let dueAt = new Date(addDays(performedAt, days, timeZone).getTime() + hours * 3_600_000);
    if (step.kind !== "INSTRUCTION") {
      const p = zonedParts(dueAt, timeZone);
      if (p.hour < EARLIEST_CHECK_IN_HOUR) {
        dueAt = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: EARLIEST_CHECK_IN_HOUR }, timeZone);
      }
    }
    return { stepIndex, kind: step.kind, title: step.title, dueAt };
  });
}

/** Day N of the follow-up on the clinic clock: 0 on the procedure day, 1 the next calendar day… */
export function clinicDayNumber(startedAt: Date, now: Date, timeZone: string): number {
  const a = zonedParts(startedAt, timeZone);
  const b = zonedParts(now, timeZone);
  const diff = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
  return Math.max(0, diff);
}

// ── Enrolment (the finance contract) ─────────────────────────────────────────

async function activeProtocolFor(tenantId: string, treatmentId: string) {
  return db.protocol.findFirst({ where: { tenantId, treatmentId, status: "ACTIVE" }, orderBy: { version: "desc" } });
}

/**
 * Enrol the patient of a signed procedure in the active protocol of its
 * treatment. Returns null when there is nothing to do (the procedure is not
 * SIGNED, the patient is archived, or the treatment has no active protocol)
 * and never throws for a missing protocol; a thrown error means the sign-off
 * should still succeed, so callers catch and log. Calling it twice for the
 * same procedure returns the existing enrolment.
 */
export async function enrolOnSignedProcedure(
  tenantId: string,
  procedureId: string,
  actor: EnrolActor = {},
): Promise<EnrolmentSummary | null> {
  const procedure = await db.procedure.findFirst({
    where: { id: procedureId, tenantId, ...notDeleted },
    include: {
      patient: { select: { id: true, fullName: true, language: true, deletedAt: true } },
      treatment: { select: { id: true, key: true, name: true } },
      enrolment: { select: { id: true, protocolId: true, _count: { select: { tasks: true } } } },
    },
  });
  if (!procedure) throw new ConciergeNotFoundError("procedure", procedureId);
  if (procedure.enrolment) {
    return { enrolmentId: procedure.enrolment.id, protocolId: procedure.enrolment.protocolId, tasks: procedure.enrolment._count.tasks };
  }
  if (procedure.status !== "SIGNED" || procedure.patient.deletedAt) return null;

  let protocol = await activeProtocolFor(tenantId, procedure.treatmentId);
  if (!protocol) {
    // A tenant that never set protocols up gets the defaults the first time a procedure is signed.
    await ensureDefaultProtocols(tenantId);
    protocol = await activeProtocolFor(tenantId, procedure.treatmentId);
  }
  if (!protocol) return null;
  const steps = parseSteps(protocol.steps);
  if (!steps.length) return null;

  const timezone = await getTenantTimezone(tenantId);
  const plan = planTasks(steps, procedure.performedAt, timezone);
  const now = new Date();
  const language = pickLanguage(procedure.patient.language);
  const protocolId = protocol.id;
  const protocolLabel = `${protocol.name} v${protocol.version}`;

  let enrolmentId: string;
  try {
    enrolmentId = await db.$transaction(async (tx) => {
      const enrolment = await tx.conciergeEnrolment.create({
        data: {
          tenantId,
          patientId: procedure.patientId,
          procedureId: procedure.id,
          protocolId,
          status: "ACTIVE",
          channel: "WHATSAPP",
          language,
          startedAt: procedure.performedAt,
        },
        select: { id: true },
      });
      await tx.conciergeTask.createMany({
        data: plan.map((t) => ({
          tenantId,
          enrolmentId: enrolment.id,
          stepIndex: t.stepIndex,
          kind: t.kind,
          title: t.title,
          dueAt: t.dueAt,
          status: "PENDING",
        })),
      });
      await tx.timelineEvent.create({
        data: {
          tenantId,
          patientId: procedure.patientId,
          kind: "CHECK_IN",
          title: `Enrolled in ${protocolLabel}`,
          body: `${procedure.treatment.name}: ${plan.length} steps over ${protocolLengthDays(steps)} days, messages in ${language === "ar" ? "Arabic" : "English"} on WhatsApp.`,
          refId: enrolment.id,
          occurredAt: now,
        },
      });
      return enrolment.id;
    });
  } catch (err) {
    // Two sign-offs racing on the same procedure: the unique procedureId keeps one enrolment.
    if (isUniqueViolation(err)) {
      const existing = await db.conciergeEnrolment.findFirst({
        where: { tenantId, procedureId: procedure.id },
        select: { id: true, protocolId: true, _count: { select: { tasks: true } } },
      });
      if (existing) return { enrolmentId: existing.id, protocolId: existing.protocolId, tasks: existing._count.tasks };
    }
    throw err;
  }

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.enrol",
    entity: "ConciergeEnrolment",
    entityId: enrolmentId,
    after: { procedureId: procedure.id, patientId: procedure.patientId, protocolId, protocol: protocolLabel, tasks: plan.length, language },
  });
  return { enrolmentId, protocolId, tasks: plan.length };
}

// ── Enrolment reads ──────────────────────────────────────────────────────────

const enrolmentInclude = {
  patient: { select: { id: true, fullName: true, phone: true, whatsapp: true, language: true } },
  protocol: { select: { id: true, name: true, version: true, steps: true, treatment: { select: { id: true, key: true, name: true } } } },
  procedure: { select: { id: true, performedAt: true, doctorId: true } },
  tasks: { orderBy: [{ stepIndex: "asc" as const }], include: { checkIn: true } },
  escalations: { orderBy: { createdAt: "desc" as const } },
} satisfies Prisma.ConciergeEnrolmentInclude;

type EnrolmentRow = Prisma.ConciergeEnrolmentGetPayload<{ include: typeof enrolmentInclude }>;

const DONE_STATUSES = new Set(["ANSWERED", "MISSED", "SKIPPED"]);

export function isTaskDone(task: Pick<ConciergeTask, "status" | "kind">): boolean {
  return DONE_STATUSES.has(task.status) || (task.kind === "INSTRUCTION" && task.status === "SENT");
}

const stepsCache = new WeakMap<object, ProtocolStep[]>();
function stepsOf(protocol: { steps: unknown }): ProtocolStep[] {
  const key = protocol as object;
  let steps = stepsCache.get(key);
  if (!steps) {
    steps = parseSteps(protocol.steps);
    stepsCache.set(key, steps);
  }
  return steps;
}

function toEnrolmentSummary(row: EnrolmentRow, doctorName: string | null, now: Date, timezone: string): EnrolmentSummaryDTO {
  const steps = stepsOf(row.protocol);
  const tasks = row.tasks;
  const next = tasks.filter((t) => t.status === "PENDING").sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0] ?? null;
  const awaiting = tasks.filter((t) => t.status === "SENT" && t.kind !== "INSTRUCTION").length;
  const lastCheckIn = tasks
    .map((t) => t.checkIn)
    .filter((c): c is CheckIn => Boolean(c))
    .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime())[0];
  return {
    id: row.id,
    status: row.status,
    language: row.language,
    channel: row.channel,
    startedAt: row.startedAt.toISOString(),
    completedAt: iso(row.completedAt),
    pausedAt: iso(row.pausedAt),
    pauseReason: row.pauseReason,
    stoppedAt: iso(row.stoppedAt),
    stopReason: row.stopReason,
    patient: { id: row.patient.id, fullName: row.patient.fullName, phone: row.patient.whatsapp ?? row.patient.phone, language: row.patient.language },
    treatment: row.protocol.treatment,
    protocol: { id: row.protocol.id, name: row.protocol.name, version: row.protocol.version, lengthDays: protocolLengthDays(steps) },
    procedure: { id: row.procedure.id, performedAt: row.procedure.performedAt.toISOString(), doctorName },
    progress: {
      done: tasks.filter(isTaskDone).length,
      total: tasks.length,
      day: clinicDayNumber(row.startedAt, now, timezone),
      nextDueAt: next ? next.dueAt.toISOString() : null,
      nextTitle: next ? next.title : null,
      nextKind: next ? next.kind : null,
      awaiting,
      lastTriage: lastCheckIn?.triage ?? null,
      lastCheckInAt: lastCheckIn ? lastCheckIn.submittedAt.toISOString() : null,
      openEscalations: row.escalations.filter((e) => e.status !== "RESOLVED").length,
    },
  };
}

export const ENROLMENT_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "STOPPED"] as const satisfies readonly EnrolmentStatus[];

export const EnrolmentListQuery = z.object({
  status: z.enum(ENROLMENT_STATUSES).optional(),
  patientId: zOptionalText(64),
  treatmentId: zOptionalText(64),
  /** Patient name or phone. */
  q: zOptionalText(80),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type EnrolmentListQuery = z.input<typeof EnrolmentListQuery>;

export async function listEnrolments(tenantId: string, rawQuery: EnrolmentListQuery = {}, now = new Date()): Promise<EnrolmentListDTO> {
  const query = EnrolmentListQuery.parse(rawQuery);
  const q = query.q?.trim();
  const base: Prisma.ConciergeEnrolmentWhereInput = {
    tenantId,
    ...(query.patientId ? { patientId: query.patientId } : {}),
    ...(query.treatmentId ? { protocol: { treatmentId: query.treatmentId } } : {}),
    ...(q
      ? {
          patient: {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { phone: { contains: q.replace(/[\s()-]/g, "") } },
              { whatsapp: { contains: q.replace(/[\s()-]/g, "") } },
            ],
          },
        }
      : {}),
  };
  const where: Prisma.ConciergeEnrolmentWhereInput = { ...base, ...(query.status ? { status: query.status } : {}) };
  const [rows, total, grouped, timezone] = await Promise.all([
    db.conciergeEnrolment.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: enrolmentInclude,
    }),
    db.conciergeEnrolment.count({ where }),
    db.conciergeEnrolment.groupBy({ by: ["status"], where: base, _count: { _all: true } }),
    getTenantTimezone(tenantId),
  ]);
  const doctors = await userNames(tenantId, rows.map((r) => r.procedure.doctorId));
  const counts = Object.fromEntries(ENROLMENT_STATUSES.map((s) => [s, 0])) as Record<EnrolmentStatus, number>;
  for (const g of grouped) counts[g.status] = g._count._all;
  return {
    enrolments: rows.map((r) => toEnrolmentSummary(r, r.procedure.doctorId ? (doctors.get(r.procedure.doctorId) ?? null) : null, now, timezone)),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts,
  };
}

/**
 * One enrolment with its tasks (answers included) and escalations. With
 * `messages`, each sent step also carries the last message it sent (the text
 * the patient received, link included): for staff who can act on the
 * follow-up, never for the patient-facing API.
 */
export async function getEnrolmentDetail(tenantId: string, id: string, now = new Date(), opts: { messages?: boolean } = {}): Promise<EnrolmentDetailDTO | null> {
  const row = await db.conciergeEnrolment.findFirst({ where: { id, tenantId }, include: enrolmentInclude });
  if (!row) return null;
  const messageIds = opts.messages ? row.tasks.map((t) => t.messageId).filter((m): m is string => Boolean(m)) : [];
  const [doctors, timezone, escalations, sentMessages] = await Promise.all([
    userNames(tenantId, [row.procedure.doctorId]),
    getTenantTimezone(tenantId),
    toEscalationDTOs(tenantId, row.escalations),
    messageIds.length
      ? db.message.findMany({ where: { tenantId, id: { in: messageIds } }, select: { id: true, body: true, delivery: true, createdAt: true, failedReason: true } })
      : Promise.resolve([]),
  ]);
  const steps = stepsOf(row.protocol);
  const byId = new Map(sentMessages.map((m) => [m.id, m]));
  return {
    ...toEnrolmentSummary(row, row.procedure.doctorId ? (doctors.get(row.procedure.doctorId) ?? null) : null, now, timezone),
    tasks: row.tasks.map((t) => {
      const dto = toTaskDTO(t, steps);
      if (!opts.messages) return dto;
      const m = t.messageId ? byId.get(t.messageId) : undefined;
      return { ...dto, message: m ? { body: m.body, delivery: m.delivery, sentAt: m.createdAt.toISOString(), failedReason: m.failedReason } : null };
    }),
    escalations,
  };
}

async function requireEnrolment(tenantId: string, id: string): Promise<ConciergeEnrolment> {
  const row = await db.conciergeEnrolment.findFirst({ where: { id, tenantId } });
  if (!row) throw new ConciergeNotFoundError("enrolment", id);
  return row;
}

// ── Enrolment writes ─────────────────────────────────────────────────────────

export const ReasonInput = z.object({ reason: zOptionalText(500) });

async function enrolmentAudit(tenantId: string, action: string, id: string, actor: Actor, before: unknown, after: unknown) {
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action, entity: "ConciergeEnrolment", entityId: id, before, after });
}

/** ACTIVE → PAUSED: nothing new goes out; links already sent stay answerable. */
export async function pauseEnrolment(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, now = new Date()) {
  const input = ReasonInput.parse(rawInput ?? {});
  const before = await requireEnrolment(tenantId, id);
  if (before.status !== "ACTIVE") throw new ConciergeError("invalid_state", `an enrolment that is ${before.status} cannot be paused`);
  const after = await db.$transaction(async (tx) => {
    const row = await tx.conciergeEnrolment.update({ where: { id }, data: { status: "PAUSED", pausedAt: now, pauseReason: input.reason ?? null } });
    await tx.timelineEvent.create({
      data: { tenantId, patientId: row.patientId, kind: "CHECK_IN", title: "Concierge follow-up paused", body: input.reason ?? null, refId: row.id, occurredAt: now },
    });
    return row;
  });
  await enrolmentAudit(tenantId, "concierge.enrolment.pause", id, actor, { status: before.status }, { status: "PAUSED", reason: input.reason ?? null });
  return after;
}

/**
 * PAUSED → ACTIVE. Steps that came due while paused go out on the next
 * dispatch; any more than a day late are skipped there instead of flooding the
 * patient (see dispatch.ts).
 */
export async function resumeEnrolment(tenantId: string, id: string, actor: Actor = {}, now = new Date()) {
  const before = await requireEnrolment(tenantId, id);
  if (before.status !== "PAUSED") throw new ConciergeError("invalid_state", `an enrolment that is ${before.status} cannot be resumed`);
  const after = await db.$transaction(async (tx) => {
    const row = await tx.conciergeEnrolment.update({ where: { id }, data: { status: "ACTIVE", pausedAt: null, pauseReason: null } });
    await tx.timelineEvent.create({
      data: { tenantId, patientId: row.patientId, kind: "CHECK_IN", title: "Concierge follow-up resumed", refId: row.id, occurredAt: now },
    });
    return row;
  });
  await enrolmentAudit(tenantId, "concierge.enrolment.resume", id, actor, { status: before.status }, { status: "ACTIVE" });
  return after;
}

/**
 * Stop for good (a reason is required): pending steps are skipped and so are
 * check-ins still waiting for an answer, so their links stop working. Answers
 * already given, missed steps and escalations stay as they are.
 */
export async function stopEnrolment(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, now = new Date()) {
  const input = z.object({ reason: zText(500).min(1, "A reason is required to stop") }).parse(rawInput ?? {});
  const before = await requireEnrolment(tenantId, id);
  if (before.status === "STOPPED" || before.status === "COMPLETED") {
    throw new ConciergeError("invalid_state", `an enrolment that is ${before.status} cannot be stopped`);
  }
  const { row: after, skipped } = await db.$transaction(async (tx) => {
    const row = await tx.conciergeEnrolment.update({ where: { id }, data: { status: "STOPPED", stoppedAt: now, stopReason: input.reason } });
    const pending = await tx.conciergeTask.updateMany({ where: { enrolmentId: id, status: "PENDING" }, data: { status: "SKIPPED" } });
    const open = await tx.conciergeTask.updateMany({
      where: { enrolmentId: id, status: "SENT", kind: { not: "INSTRUCTION" } },
      data: { status: "SKIPPED", tokenHash: null },
    });
    await tx.timelineEvent.create({
      data: { tenantId, patientId: row.patientId, kind: "CHECK_IN", title: "Concierge follow-up stopped", body: input.reason, refId: row.id, occurredAt: now },
    });
    return { row, skipped: pending.count + open.count };
  });
  await enrolmentAudit(tenantId, "concierge.enrolment.stop", id, actor, { status: before.status }, { status: "STOPPED", reason: input.reason, skippedSteps: skipped });
  return after;
}

export async function requireTask(tenantId: string, taskId: string) {
  const task = await db.conciergeTask.findFirst({ where: { id: taskId, tenantId }, include: { enrolment: true } });
  if (!task) throw new ConciergeNotFoundError("task", taskId);
  return task;
}

/** Skip one step: a pending one never goes out, a sent one's link stops working. */
export async function skipTask(tenantId: string, taskId: string, actor: Actor = {}) {
  const before = await requireTask(tenantId, taskId);
  if (before.status !== "PENDING" && before.status !== "SENT") throw new ConciergeError("invalid_state", `a task that is ${before.status} cannot be skipped`);
  if (before.kind === "INSTRUCTION" && before.status === "SENT") throw new ConciergeError("invalid_state", "these instructions already went out");
  const changed = await db.conciergeTask.updateMany({
    where: { id: taskId, tenantId, status: before.status },
    data: { status: "SKIPPED", tokenHash: null },
  });
  if (!changed.count) throw new ConciergeError("invalid_state", "this task changed a moment ago; reload and try again");
  const after = await db.conciergeTask.findUniqueOrThrow({ where: { id: taskId } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.task.skip",
    entity: "ConciergeTask",
    entityId: taskId,
    before: { status: before.status },
    after: { status: after.status },
  });
  return after;
}

// ── Protocols ────────────────────────────────────────────────────────────────

type ProtocolRow = Protocol & { _count: { enrolments: number } };

function toProtocolDTO(p: ProtocolRow): ProtocolDTO {
  return {
    id: p.id,
    treatmentId: p.treatmentId,
    name: p.name,
    version: p.version,
    status: p.status,
    steps: parseSteps(p.steps),
    notes: p.notes,
    approvedAt: iso(p.approvedAt),
    retiredAt: iso(p.retiredAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    enrolments: p._count.enrolments,
  };
}

/** Every active treatment with its active, draft and retired protocol versions. */
export async function listTreatmentProtocols(tenantId: string): Promise<TreatmentProtocolsDTO[]> {
  const treatments = await listTreatments(tenantId);
  const protocols = await db.protocol.findMany({
    where: { tenantId },
    orderBy: [{ version: "desc" }],
    include: { _count: { select: { enrolments: true } } },
  });
  return treatments.map((t) => {
    const mine = protocols.filter((p) => p.treatmentId === t.id).map(toProtocolDTO);
    return {
      treatment: { id: t.id, key: t.key, name: t.name, active: t.active },
      active: mine.find((p) => p.status === "ACTIVE") ?? null,
      drafts: mine.filter((p) => p.status === "DRAFT"),
      retired: mine.filter((p) => p.status === "RETIRED"),
    };
  });
}

export async function getProtocol(tenantId: string, id: string): Promise<(ProtocolDTO & { treatment: { id: string; key: string; name: string } }) | null> {
  const row = await db.protocol.findFirst({ where: { id, tenantId }, include: { _count: { select: { enrolments: true } }, treatment: { select: { id: true, key: true, name: true } } } });
  return row ? { ...toProtocolDTO(row), treatment: row.treatment } : null;
}

export const ProtocolCreateInput = z.object({ treatmentId: zText(64).min(1), name: zOptionalText(120) });

/**
 * "New version": copy the active protocol (or the latest, or the default) of
 * a treatment into a DRAFT. One draft per treatment: a second request gets 409
 * `draft_exists` with the draft's id.
 */
export async function createDraftProtocol(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = ProtocolCreateInput.parse(rawInput);
  const treatment = await requireTenantTreatment(tenantId, input.treatmentId);
  const draft = await db.protocol.findFirst({ where: { tenantId, treatmentId: treatment.id, status: "DRAFT" }, select: { id: true, version: true } });
  if (draft) throw new ConciergeError("draft_exists", `version ${draft.version} is already a draft; edit or approve it first`, 409, { protocolId: draft.id });
  const latest = await db.protocol.findFirst({ where: { tenantId, treatmentId: treatment.id }, orderBy: { version: "desc" } });
  const source =
    (await db.protocol.findFirst({ where: { tenantId, treatmentId: treatment.id, status: "ACTIVE" }, orderBy: { version: "desc" } })) ?? latest;
  const fallback = DEFAULT_PROTOCOLS.find((d) => d.treatmentKey === treatment.key);
  const steps = source ? parseSteps(source.steps) : (fallback?.steps ?? []);
  let created: ProtocolRow;
  try {
    created = await db.protocol.create({
      data: {
        tenantId,
        treatmentId: treatment.id,
        name: input.name ?? source?.name ?? fallback?.name ?? `${treatment.name} aftercare`,
        version: (latest?.version ?? 0) + 1,
        status: "DRAFT",
        steps: steps as unknown as Prisma.InputJsonValue,
        notes: source ? `Copied from v${source.version}` : null,
        createdById: actor.id ?? null,
      },
      include: { _count: { select: { enrolments: true } } },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConciergeError("draft_exists", "someone created a new version a moment ago; reload the protocols");
    throw err;
  }
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.protocol.create",
    entity: "Protocol",
    entityId: created.id,
    after: { treatmentId: treatment.id, version: created.version, copiedFrom: source?.id ?? null },
  });
  return toProtocolDTO(created);
}

export const ProtocolUpdateInput = z.object({
  name: zText(120).min(1).optional(),
  steps: zSteps.optional(),
  notes: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), zText(2000).nullable().optional()),
});

async function requireProtocol(tenantId: string, id: string): Promise<ProtocolRow> {
  const row = await db.protocol.findFirst({ where: { id, tenantId }, include: { _count: { select: { enrolments: true } } } });
  if (!row) throw new ConciergeNotFoundError("protocol", id);
  return row;
}

/** Edit a DRAFT (name, steps, notes). Active and retired versions are immutable. */
export async function updateDraftProtocol(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = ProtocolUpdateInput.parse(rawInput);
  const before = await requireProtocol(tenantId, id);
  if (before.status !== "DRAFT") throw new ConciergeError("draft_only", "only a draft protocol can be edited");
  const after = await db.protocol.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.steps !== undefined ? { steps: input.steps as unknown as Prisma.InputJsonValue } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    include: { _count: { select: { enrolments: true } } },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.protocol.update",
    entity: "Protocol",
    entityId: id,
    before: { name: before.name, steps: parseSteps(before.steps).length },
    after: { name: after.name, steps: parseSteps(after.steps).length },
  });
  return toProtocolDTO(after);
}

/** Throw a DRAFT away (it was never used: enrolments only ever run an approved version). */
export async function discardDraftProtocol(tenantId: string, id: string, actor: Actor = {}) {
  const before = await requireProtocol(tenantId, id);
  if (before.status !== "DRAFT") throw new ConciergeError("draft_only", "only a draft protocol can be discarded");
  const removed = await db.protocol.deleteMany({ where: { id, tenantId, status: "DRAFT" } });
  if (!removed.count) throw new ConciergeError("draft_only", "this draft was approved or discarded a moment ago");
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.protocol.discard",
    entity: "Protocol",
    entityId: id,
    before: { treatmentId: before.treatmentId, version: before.version, name: before.name, steps: parseSteps(before.steps).length },
  });
  return { id, version: before.version };
}

/** DRAFT → ACTIVE; the previous active version of the treatment retires. Running enrolments keep their version. */
export async function approveProtocol(tenantId: string, id: string, actor: Actor = {}, now = new Date()) {
  const before = await requireProtocol(tenantId, id);
  if (before.status !== "DRAFT") throw new ConciergeError("draft_only", "only a draft protocol can be approved");
  const checked = zSteps.safeParse(before.steps);
  if (!checked.success) throw new ConciergeError("no_steps", "fix the highlighted steps before approving", 422);
  if (!checked.data.length) throw new ConciergeError("no_steps", "add at least one step before approving");
  const { row: after, retired } = await db.$transaction(async (tx) => {
    const previous = await tx.protocol.findMany({
      where: { tenantId, treatmentId: before.treatmentId, status: "ACTIVE", id: { not: id } },
      select: { id: true, version: true },
    });
    await tx.protocol.updateMany({
      where: { id: { in: previous.map((p) => p.id) } },
      data: { status: "RETIRED", retiredAt: now },
    });
    const row = await tx.protocol.update({
      where: { id },
      data: { status: "ACTIVE", approvedAt: now, approvedById: actor.id ?? null },
      include: { _count: { select: { enrolments: true } } },
    });
    return { row, retired: previous };
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.protocol.approve",
    entity: "Protocol",
    entityId: id,
    before: { status: before.status },
    after: { status: after.status, version: after.version, retired: retired.map((r) => `v${r.version}`) },
  });
  return toProtocolDTO(after);
}

/** ACTIVE → RETIRED. Running enrolments keep their version; new procedures get nothing until a draft is approved. */
export async function retireProtocol(tenantId: string, id: string, actor: Actor = {}, now = new Date()) {
  const before = await requireProtocol(tenantId, id);
  if (before.status !== "ACTIVE") throw new ConciergeError("active_only", "only an active protocol can be retired");
  const after = await db.protocol.update({ where: { id }, data: { status: "RETIRED", retiredAt: now }, include: { _count: { select: { enrolments: true } } } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "concierge.protocol.retire",
    entity: "Protocol",
    entityId: id,
    before: { status: before.status },
    after: { status: after.status },
  });
  return toProtocolDTO(after);
}

// ── Board ────────────────────────────────────────────────────────────────────

export const KPI_WINDOW_DAYS = 30;
/** A check-in counts towards the answer rate once its 48-hour answer window has closed. */
const ANSWER_WINDOW_MS = 48 * 3_600_000;
/** Answered more than this long after it went out: after the 24-hour reminder. */
const REMINDER_MS = 24 * 3_600_000;
export const ANSWER_RATE_TARGET = 90;
export const ACK_TARGET = 100;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const pct = (num: number, den: number): number | null => (den ? Math.round((num / den) * 1000) / 10 : null);

type BoardTaskRow = ConciergeTask & { enrolment: { id: string; patient: { id: string; fullName: string }; protocol: { id: string; steps: unknown } } };

function toBoardTask(t: BoardTaskRow): BoardTaskDTO {
  const steps = stepsOf(t.enrolment.protocol);
  const step = steps[t.stepIndex];
  return {
    id: t.id,
    enrolmentId: t.enrolment.id,
    patient: t.enrolment.patient,
    title: t.title,
    dayLabel: step ? dayLabel(step) : `Step ${t.stepIndex + 1}`,
    kind: t.kind,
    status: t.status,
    dueAt: t.dueAt.toISOString(),
    sentAt: iso(t.sentAt),
    attempts: t.attempts,
    reminded: t.status === "SENT" && t.attempts >= 2,
    missesAt: t.status === "SENT" && t.sentAt ? new Date(t.sentAt.getTime() + ANSWER_WINDOW_MS).toISOString() : null,
    hasHighRisk: step ? stepHasHighRisk(step) : false,
    lastError: t.lastError,
  };
}

/** Who a high-risk reply reaches right now, per the roster and the clinic clock. */
export async function onCallNow(tenantId: string, now = new Date(), timezone?: string): Promise<BoardDTO["onCall"]> {
  const [settings, tz] = await Promise.all([readConciergeSettings(tenantId), timezone ? Promise.resolve(timezone) : getTenantTimezone(tenantId)]);
  const outOfHours = !isWithinHours(now, tz, settings.hours);
  const roster = await resolveRoster(tenantId, settings);
  const primary = (outOfHours ? roster.outOfHours : roster.inHours) ?? roster.backup;
  const backup = roster.backup && roster.backup.id !== primary?.id ? roster.backup : null;
  return {
    outOfHours,
    assigneeName: primary?.fullName ?? null,
    backupName: backup?.fullName ?? null,
    ackMinutes: outOfHours ? settings.ackMinutes.outOfHours : settings.ackMinutes.inHours,
    hours: settings.hours,
  };
}

/** Everything the concierge board shows, computed on the clinic clock. */
export async function getBoard(tenantId: string, now = new Date()): Promise<BoardDTO> {
  const timezone = await getTenantTimezone(tenantId);
  const dayStart = startOfDayInTz(now, timezone);
  const dayEnd = endOfDayInTz(now, timezone);
  const since = new Date(now.getTime() - KPI_WINDOW_DAYS * DAY_MS);
  const taskInclude = { enrolment: { select: { id: true, patient: { select: { id: true, fullName: true } }, protocol: { select: { id: true, steps: true } } } } } as const;

  const [open, dueToday, awaiting, answeredToday, sentTasks, highRisk, activeEnrolments, satisfaction, onCall] = await Promise.all([
    db.escalation.findMany({ where: { tenantId, kind: "CONCIERGE", status: { in: ["OPEN", "ACKNOWLEDGED"] } }, orderBy: [{ dueAt: "asc" }], take: 100 }),
    db.conciergeTask.findMany({
      where: { tenantId, status: "PENDING", kind: { not: "INSTRUCTION" }, dueAt: { gte: dayStart, lte: dayEnd }, enrolment: { status: "ACTIVE" } },
      orderBy: [{ dueAt: "asc" }],
      take: 100,
      include: taskInclude,
    }),
    db.conciergeTask.findMany({
      where: { tenantId, status: "SENT", kind: { not: "INSTRUCTION" }, enrolment: { status: { in: ["ACTIVE", "PAUSED"] } } },
      orderBy: [{ sentAt: "asc" }],
      take: 100,
      include: taskInclude,
    }),
    db.checkIn.findMany({
      where: { tenantId, submittedAt: { gte: dayStart, lte: dayEnd } },
      orderBy: [{ submittedAt: "desc" }],
      take: 100,
      include: { task: { select: { title: true, stepIndex: true } }, patient: { select: { id: true, fullName: true } }, enrolment: { select: { id: true, protocol: { select: { id: true, steps: true } } } } },
    }),
    db.conciergeTask.findMany({
      where: { tenantId, kind: { in: ["CHECK_IN", "PHOTO_REQUEST"] }, sentAt: { gte: since, lte: now }, status: { in: ["SENT", "ANSWERED", "MISSED"] } },
      select: { kind: true, status: true, sentAt: true, answeredAt: true },
    }),
    db.escalation.findMany({
      where: { tenantId, kind: "CONCIERGE", level: "HIGH_RISK", createdAt: { gte: since, lte: now } },
      select: { status: true, createdAt: true, dueAt: true, acknowledgedAt: true },
    }),
    db.conciergeEnrolment.count({ where: { tenantId, status: "ACTIVE" } }),
    db.checkIn.aggregate({ where: { tenantId, submittedAt: { gte: since, lte: now }, satisfaction: { not: null } }, _avg: { satisfaction: true }, _count: { satisfaction: true } }),
    onCallNow(tenantId, now, timezone),
  ]);

  // Answer rate: of the check-ins sent in the window whose 48-hour answer window has closed.
  const isClosed = (t: { status: string; sentAt: Date | null }) => t.status !== "SENT" || (t.sentAt && now.getTime() - t.sentAt.getTime() >= ANSWER_WINDOW_MS);
  const checkIns = sentTasks.filter((t) => t.kind === "CHECK_IN" && isClosed(t));
  const answered = checkIns.filter((t) => t.status === "ANSWERED");
  const afterReminder = answered.filter((t) => t.sentAt && t.answeredAt && t.answeredAt.getTime() - t.sentAt.getTime() > REMINDER_MS).length;
  const photos = sentTasks.filter((t) => t.kind === "PHOTO_REQUEST" && isClosed(t));
  const photosAnswered = photos.filter((t) => t.status === "ANSWERED").length;

  // High-risk acknowledgement: within target, counting open ones past their target as missed.
  const counted = highRisk.filter((e) => e.acknowledgedAt || e.dueAt.getTime() < now.getTime());
  const within = counted.filter((e) => e.acknowledgedAt && e.acknowledgedAt.getTime() <= e.dueAt.getTime()).length;
  const ackMinutes = highRisk
    .filter((e) => e.acknowledgedAt)
    .map((e) => (e.acknowledgedAt!.getTime() - e.createdAt.getTime()) / 60_000);
  const medianAck = median(ackMinutes);

  // Waiting for a human first (most urgent target first), then acknowledged ones waiting to be resolved.
  const ordered = [...open.filter((e) => e.status === "OPEN"), ...open.filter((e) => e.status !== "OPEN")];
  const names = await nameMapsFor(tenantId, ordered);
  const escalations: EscalationDTO[] = ordered.map((e) => toEscalationDTO(e, names));

  return {
    timezone,
    now: now.toISOString(),
    windowDays: KPI_WINDOW_DAYS,
    kpis: {
      answerRate: {
        answered: answered.length,
        sent: checkIns.length,
        missed: checkIns.filter((t) => t.status === "MISSED").length,
        afterReminder,
        pct: pct(answered.length, checkIns.length),
        target: ANSWER_RATE_TARGET,
      },
      photoRate: { answered: photosAnswered, sent: photos.length, pct: pct(photosAnswered, photos.length) },
      highRiskAck: {
        within,
        counted: counted.length,
        pct: pct(within, counted.length),
        medianMinutes: medianAck === null ? null : Math.round(medianAck * 10) / 10,
        target: ACK_TARGET,
      },
      satisfaction: {
        average: satisfaction._avg.satisfaction === null ? null : Math.round(satisfaction._avg.satisfaction * 10) / 10,
        count: satisfaction._count.satisfaction,
      },
      openEscalations: open.filter((e) => e.status === "OPEN").length,
      overdueEscalations: open.filter((e) => e.status === "OPEN" && e.dueAt.getTime() < now.getTime()).length,
      activeEnrolments,
    },
    onCall,
    escalations,
    dueToday: dueToday.map(toBoardTask),
    awaiting: awaiting.map(toBoardTask),
    answeredToday: answeredToday.map((c): BoardCheckInDTO => {
      const step = stepsOf(c.enrolment.protocol)[c.task.stepIndex];
      return {
        id: c.id,
        enrolmentId: c.enrolment.id,
        patient: c.patient,
        title: step ? stepTitle(dayLabel(step), c.task.title) : c.task.title,
        triage: c.triage,
        satisfaction: c.satisfaction,
        submittedAt: c.submittedAt.toISOString(),
        source: c.source,
        flags: flagsOf(c.flags),
        photos: c.photoIds.length,
      };
    }),
  };
}

// ── Patient card ─────────────────────────────────────────────────────────────

export interface PatientConciergeSummary {
  enrolment: EnrolmentSummaryDTO;
  openEscalation: EscalationDTO | null;
  /** Earlier enrolments of the patient (newest first), beyond the one shown. */
  others: number;
}

/** The running (or latest) enrolment of a patient, for the patient page card. */
export async function patientConciergeSummary(tenantId: string, patientId: string, now = new Date()): Promise<PatientConciergeSummary | null> {
  const rows = await db.conciergeEnrolment.findMany({ where: { tenantId, patientId }, orderBy: [{ startedAt: "desc" }], take: 10, include: enrolmentInclude });
  if (!rows.length) return null;
  const row = rows.find((r) => r.status === "ACTIVE" || r.status === "PAUSED") ?? rows[0]!;
  const [doctors, timezone] = await Promise.all([userNames(tenantId, [row.procedure.doctorId]), getTenantTimezone(tenantId)]);
  // An open escalation of any enrolment of this patient is worth showing.
  const openRow = rows.flatMap((r) => r.escalations).find((e: Escalation) => e.status !== "RESOLVED") ?? null;
  const [openEscalation] = openRow ? await toEscalationDTOs(tenantId, [openRow]) : [null];
  return {
    enrolment: toEnrolmentSummary(row, row.procedure.doctorId ? (doctors.get(row.procedure.doctorId) ?? null) : null, now, timezone),
    openEscalation: openEscalation ?? null,
    others: rows.length - 1,
  };
}

// ── Files ────────────────────────────────────────────────────────────────────

export interface StoredFile {
  bytes: Buffer;
  mimeType: string;
  name: string;
}

/** What the file route may serve: raster images only (an SVG could carry script). */
export const SERVABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);

/**
 * A check-in photo by its Document id. The document, its blob and the check-in
 * that lists it must all belong to the tenant; any other document (lab report,
 * consent form…) is not served from here.
 */
export async function getConciergeFile(tenantId: string, documentId: string): Promise<StoredFile | null> {
  if (!documentId || documentId.length > 64) return null;
  const [doc, checkIn] = await Promise.all([
    db.document.findFirst({ where: { id: documentId, tenantId }, select: { name: true, s3Key: true, mimeType: true } }),
    db.checkIn.findFirst({ where: { tenantId, photoIds: { has: documentId } }, select: { id: true } }),
  ]);
  if (!doc || !checkIn || !doc.s3Key.startsWith("blob:")) return null;
  const blob = await db.fileBlob.findFirst({ where: { id: doc.s3Key.slice("blob:".length), tenantId }, select: { bytes: true, mimeType: true } });
  if (!blob) return null;
  const mimeType = blob.mimeType || doc.mimeType || "";
  if (!SERVABLE_IMAGE_TYPES.has(mimeType)) return null;
  return { bytes: Buffer.from(blob.bytes), mimeType, name: doc.name };
}
