import { Prisma, type CheckIn, type ConciergeEnrolment, type ConciergeTask, type Escalation, type Protocol } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { endOfDayInTz, startOfDayInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { listTreatments, requireTenantTreatment } from "@/modules/treatments/service";
import type {
  BoardCheckInDTO,
  BoardDTO,
  BoardTaskDTO,
  EnrolmentDetailDTO,
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

// ── Default protocols ────────────────────────────────────────────────────────

/**
 * Create version 1 (ACTIVE) of the default protocol for every treatment of
 * the tenant that has no protocol yet. Idempotent; used on first enrolment
 * and by the seed. Returns how many were created.
 */
export async function ensureDefaultProtocols(tenantId: string, client: Client = db): Promise<number> {
  const treatments = await listTreatments(tenantId, {}, client);
  const existing = await client.protocol.groupBy({ by: ["treatmentId"], where: { tenantId } });
  const covered = new Set(existing.map((e) => e.treatmentId));
  let created = 0;
  for (const def of DEFAULT_PROTOCOLS) {
    const treatment = treatments.find((t) => t.key === def.treatmentKey);
    if (!treatment || covered.has(treatment.id)) continue;
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
 * When each step goes out: `performedAt + offsetHours`, with check-ins and
 * photo requests moved to 10:00 on the clinic clock when they would land
 * earlier in the morning. Instructions keep the computed time.
 */
export function planTasks(steps: readonly ProtocolStep[], performedAt: Date, timeZone: string): PlannedTask[] {
  return steps.map((step, stepIndex) => {
    let dueAt = new Date(performedAt.getTime() + step.offsetHours * 3_600_000);
    if (step.kind !== "INSTRUCTION") {
      const p = zonedParts(dueAt, timeZone);
      if (p.hour < EARLIEST_CHECK_IN_HOUR) {
        dueAt = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: EARLIEST_CHECK_IN_HOUR }, timeZone);
      }
    }
    return { stepIndex, kind: step.kind, title: step.title, dueAt };
  });
}

// ── Enrolment (the finance contract) ─────────────────────────────────────────

async function activeProtocolFor(tenantId: string, treatmentId: string) {
  return db.protocol.findFirst({ where: { tenantId, treatmentId, status: "ACTIVE" }, orderBy: { version: "desc" } });
}

/**
 * Enrol the patient of a signed procedure in the active protocol of its
 * treatment. Returns null when the treatment has no active protocol (nothing
 * to do) and never throws for a missing protocol; a thrown error means the
 * sign-off should still succeed, so callers catch and log. Calling it twice
 * for the same procedure returns the existing enrolment.
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
  if (procedure.status === "CANCELLED" || procedure.patient.deletedAt) return null;

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
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
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

function toEnrolmentSummary(row: EnrolmentRow, doctorName: string | null, now: Date): EnrolmentSummaryDTO {
  const steps = stepsOf(row.protocol);
  const tasks = row.tasks;
  const pending = tasks
    .filter((t) => t.status === "PENDING" || (t.status === "SENT" && t.kind !== "INSTRUCTION"))
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const next = pending[0] ?? null;
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
      day: Math.max(0, Math.floor((now.getTime() - row.startedAt.getTime()) / 86_400_000)),
      nextDueAt: next ? next.dueAt.toISOString() : null,
      nextTitle: next ? next.title : null,
      lastTriage: lastCheckIn?.triage ?? null,
      lastCheckInAt: lastCheckIn ? lastCheckIn.submittedAt.toISOString() : null,
      openEscalations: row.escalations.filter((e) => e.status !== "RESOLVED").length,
    },
  };
}

export const EnrolmentListQuery = z.object({
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "STOPPED"]).optional(),
  patientId: zOptionalText(64),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type EnrolmentListQuery = z.infer<typeof EnrolmentListQuery>;

export async function listEnrolments(tenantId: string, query: EnrolmentListQuery, now = new Date()) {
  const where: Prisma.ConciergeEnrolmentWhereInput = {
    tenantId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.patientId ? { patientId: query.patientId } : {}),
  };
  const [rows, total] = await db.$transaction([
    db.conciergeEnrolment.findMany({
      where,
      orderBy: [{ startedAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: enrolmentInclude,
    }),
    db.conciergeEnrolment.count({ where }),
  ]);
  const doctors = await userNames(tenantId, rows.map((r) => r.procedure.doctorId));
  return {
    enrolments: rows.map((r) => toEnrolmentSummary(r, r.procedure.doctorId ? (doctors.get(r.procedure.doctorId) ?? null) : null, now)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getEnrolmentDetail(tenantId: string, id: string, now = new Date()): Promise<EnrolmentDetailDTO | null> {
  const row = await db.conciergeEnrolment.findFirst({ where: { id, tenantId }, include: enrolmentInclude });
  if (!row) return null;
  const doctors = await userNames(tenantId, [row.procedure.doctorId]);
  const steps = stepsOf(row.protocol);
  const escalations = await toEscalationDTOs(tenantId, row.escalations);
  return {
    ...toEnrolmentSummary(row, row.procedure.doctorId ? (doctors.get(row.procedure.doctorId) ?? null) : null, now),
    tasks: row.tasks.map((t) => toTaskDTO(t, steps)),
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

export async function pauseEnrolment(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, now = new Date()) {
  const input = ReasonInput.parse(rawInput ?? {});
  const before = await requireEnrolment(tenantId, id);
  if (before.status !== "ACTIVE") throw new ConciergeError("invalid_state", `an enrolment that is ${before.status} cannot be paused`);
  const after = await db.conciergeEnrolment.update({ where: { id }, data: { status: "PAUSED", pausedAt: now, pauseReason: input.reason ?? null } });
  await enrolmentAudit(tenantId, "concierge.enrolment.pause", id, actor, { status: before.status }, { status: "PAUSED", reason: input.reason ?? null });
  return after;
}

export async function resumeEnrolment(tenantId: string, id: string, actor: Actor = {}) {
  const before = await requireEnrolment(tenantId, id);
  if (before.status !== "PAUSED") throw new ConciergeError("invalid_state", `an enrolment that is ${before.status} cannot be resumed`);
  const after = await db.conciergeEnrolment.update({ where: { id }, data: { status: "ACTIVE", pausedAt: null, pauseReason: null } });
  await enrolmentAudit(tenantId, "concierge.enrolment.resume", id, actor, { status: before.status }, { status: "ACTIVE" });
  return after;
}

export async function stopEnrolment(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}, now = new Date()) {
  const input = z.object({ reason: zText(500).min(1, "A reason is required to stop") }).parse(rawInput ?? {});
  const before = await requireEnrolment(tenantId, id);
  if (before.status === "STOPPED" || before.status === "COMPLETED") {
    throw new ConciergeError("invalid_state", `an enrolment that is ${before.status} cannot be stopped`);
  }
  const after = await db.$transaction(async (tx) => {
    const row = await tx.conciergeEnrolment.update({ where: { id }, data: { status: "STOPPED", stoppedAt: now, stopReason: input.reason } });
    // Nothing further goes out: pending steps are skipped, open links stay answerable.
    await tx.conciergeTask.updateMany({ where: { enrolmentId: id, status: "PENDING" }, data: { status: "SKIPPED" } });
    await tx.timelineEvent.create({
      data: { tenantId, patientId: row.patientId, kind: "CHECK_IN", title: "Concierge follow-up stopped", body: input.reason, refId: row.id, occurredAt: now },
    });
    return row;
  });
  await enrolmentAudit(tenantId, "concierge.enrolment.stop", id, actor, { status: before.status }, { status: "STOPPED", reason: input.reason });
  return after;
}

export async function requireTask(tenantId: string, taskId: string) {
  const task = await db.conciergeTask.findFirst({ where: { id: taskId, tenantId }, include: { enrolment: true } });
  if (!task) throw new ConciergeNotFoundError("task", taskId);
  return task;
}

export async function skipTask(tenantId: string, taskId: string, actor: Actor = {}) {
  const before = await requireTask(tenantId, taskId);
  if (before.status !== "PENDING" && before.status !== "SENT") throw new ConciergeError("invalid_state", `a task that is ${before.status} cannot be skipped`);
  const after = await db.conciergeTask.update({ where: { id: taskId }, data: { status: "SKIPPED" } });
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

/** "New version": copy the active protocol (or the default) of a treatment into a DRAFT. */
export async function createDraftProtocol(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = ProtocolCreateInput.parse(rawInput);
  const treatment = await requireTenantTreatment(tenantId, input.treatmentId);
  const latest = await db.protocol.findFirst({ where: { tenantId, treatmentId: treatment.id }, orderBy: { version: "desc" } });
  const source =
    (await db.protocol.findFirst({ where: { tenantId, treatmentId: treatment.id, status: "ACTIVE" }, orderBy: { version: "desc" } })) ?? latest;
  const fallback = DEFAULT_PROTOCOLS.find((d) => d.treatmentKey === treatment.key);
  const steps = source ? parseSteps(source.steps) : (fallback?.steps ?? []);
  const created = await db.protocol.create({
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

/** DRAFT → ACTIVE; the previous active version of the treatment retires. */
export async function approveProtocol(tenantId: string, id: string, actor: Actor = {}, now = new Date()) {
  const before = await requireProtocol(tenantId, id);
  if (before.status !== "DRAFT") throw new ConciergeError("draft_only", "only a draft protocol can be approved");
  if (!parseSteps(before.steps).length) throw new ConciergeError("no_steps", "add at least one step before approving");
  const after = await db.$transaction(async (tx) => {
    await tx.protocol.updateMany({
      where: { tenantId, treatmentId: before.treatmentId, status: "ACTIVE", id: { not: id } },
      data: { status: "RETIRED", retiredAt: now },
    });
    return tx.protocol.update({
      where: { id },
      data: { status: "ACTIVE", approvedAt: now, approvedById: actor.id ?? null },
      include: { _count: { select: { enrolments: true } } },
    });
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
    after: { status: after.status, version: after.version },
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

const WINDOW_DAYS = 30;
const ANSWER_WINDOW_MS = 48 * 3_600_000;

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
    hasHighRisk: step ? stepHasHighRisk(step) : false,
  };
}

/** Everything the concierge board shows, computed on the clinic clock. */
export async function getBoard(tenantId: string, now = new Date()): Promise<BoardDTO> {
  const timezone = await getTenantTimezone(tenantId);
  const dayStart = startOfDayInTz(now, timezone);
  const dayEnd = endOfDayInTz(now, timezone);
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const taskInclude = { enrolment: { select: { id: true, patient: { select: { id: true, fullName: true } }, protocol: { select: { id: true, steps: true } } } } } as const;

  const [open, dueToday, awaiting, answeredToday, sentTasks, highRisk, activeEnrolments] = await Promise.all([
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
      where: { tenantId, kind: "CHECK_IN", sentAt: { gte: since, lte: now }, status: { in: ["SENT", "ANSWERED", "MISSED"] } },
      select: { status: true, sentAt: true },
    }),
    db.escalation.findMany({
      where: { tenantId, kind: "CONCIERGE", level: "HIGH_RISK", createdAt: { gte: since } },
      select: { status: true, createdAt: true, dueAt: true, acknowledgedAt: true },
    }),
    db.conciergeEnrolment.count({ where: { tenantId, status: "ACTIVE" } }),
  ]);

  // Answer rate: of the check-ins sent in the window whose 48-hour answer window has closed.
  const closed = sentTasks.filter((t) => t.status !== "SENT" || (t.sentAt && now.getTime() - t.sentAt.getTime() >= ANSWER_WINDOW_MS));
  const answered = closed.filter((t) => t.status === "ANSWERED").length;

  // High-risk acknowledgement: within target, counting open ones past their target as missed.
  const counted = highRisk.filter((e) => e.acknowledgedAt || e.dueAt.getTime() < now.getTime());
  const within = counted.filter((e) => e.acknowledgedAt && e.acknowledgedAt.getTime() <= e.dueAt.getTime()).length;
  const ackMinutes = highRisk
    .filter((e) => e.acknowledgedAt)
    .map((e) => (e.acknowledgedAt!.getTime() - e.createdAt.getTime()) / 60_000);

  const names = await nameMapsFor(tenantId, open);
  const escalations: EscalationDTO[] = open.map((e) => toEscalationDTO(e, names));

  return {
    timezone,
    now: now.toISOString(),
    kpis: {
      answerRate: { answered, sent: closed.length, pct: pct(answered, closed.length) },
      highRiskAck: { within, counted: counted.length, pct: pct(within, counted.length), medianMinutes: median(ackMinutes) === null ? null : Math.round(median(ackMinutes)! * 10) / 10 },
      openEscalations: open.filter((e) => e.status === "OPEN").length,
      overdueEscalations: open.filter((e) => e.status === "OPEN" && e.dueAt.getTime() < now.getTime()).length,
      activeEnrolments,
    },
    escalations,
    dueToday: dueToday.map(toBoardTask),
    awaiting: awaiting.map(toBoardTask),
    answeredToday: answeredToday.map((c): BoardCheckInDTO => {
      const step = stepsOf(c.enrolment.protocol)[c.task.stepIndex];
      return {
        id: c.id,
        enrolmentId: c.enrolment.id,
        patient: c.patient,
        title: step ? `${dayLabel(step)} · ${c.task.title}` : c.task.title,
        triage: c.triage,
        satisfaction: c.satisfaction,
        submittedAt: c.submittedAt.toISOString(),
        source: c.source,
        flags: flagsOf(c.flags),
      };
    }),
  };
}

// ── Patient card ─────────────────────────────────────────────────────────────

export interface PatientConciergeSummary {
  enrolment: EnrolmentSummaryDTO;
  openEscalation: EscalationDTO | null;
}

/** The running (or latest) enrolment of a patient, for the patient page card. */
export async function patientConciergeSummary(tenantId: string, patientId: string, now = new Date()): Promise<PatientConciergeSummary | null> {
  const rows = await db.conciergeEnrolment.findMany({ where: { tenantId, patientId }, orderBy: [{ startedAt: "desc" }], take: 10, include: enrolmentInclude });
  if (!rows.length) return null;
  const row = rows.find((r) => r.status === "ACTIVE" || r.status === "PAUSED") ?? rows[0]!;
  const doctors = await userNames(tenantId, [row.procedure.doctorId]);
  const openRow = row.escalations.find((e: Escalation) => e.status !== "RESOLVED") ?? null;
  const [openEscalation] = openRow ? await toEscalationDTOs(tenantId, [openRow]) : [null];
  return {
    enrolment: toEnrolmentSummary(row, row.procedure.doctorId ? (doctors.get(row.procedure.doctorId) ?? null) : null, now),
    openEscalation: openEscalation ?? null,
  };
}

// ── Files ────────────────────────────────────────────────────────────────────

export interface StoredFile {
  bytes: Buffer;
  mimeType: string;
  name: string;
}

/** A check-in photo by its Document id; the document and its blob must both belong to the tenant. */
export async function getConciergeFile(tenantId: string, documentId: string): Promise<StoredFile | null> {
  const doc = await db.document.findFirst({ where: { id: documentId, tenantId }, select: { name: true, s3Key: true, mimeType: true } });
  if (!doc || !doc.s3Key.startsWith("blob:")) return null;
  const blob = await db.fileBlob.findFirst({ where: { id: doc.s3Key.slice("blob:".length), tenantId }, select: { bytes: true, mimeType: true } });
  if (!blob) return null;
  return { bytes: Buffer.from(blob.bytes), mimeType: blob.mimeType || doc.mimeType || "application/octet-stream", name: doc.name };
}
