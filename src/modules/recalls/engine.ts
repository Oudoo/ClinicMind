import { Prisma, type AppointmentKind, type AppointmentStatus, type ChannelType, type RecallKind, type RecallRule, type RecallStatus, type UserRole } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { addDays, endOfDayInTz, formatDateInTz, formatTimeInTz, startOfDayInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { stageShare, summarizeCharges } from "@/modules/finance/charges";
import {
  ACTIVE_RECALL_STATUSES,
  DUE_SOON_DAYS,
  LAPSED_HORIZON_MONTHS,
  LAPSED_MONTHS,
  MISSED_AFTER_HOURS,
  UNBOOKED_AFTER_DAYS,
  WAITING_RECALL_STATUSES,
} from "./constants";
import { followUpDays, followUpWindow } from "./followups";
import { activeRules, FALLBACK_SESSION_DAYS, FALLBACK_SESSION_WINDOW, normaliseTerm } from "./rules";

/**
 * Where recalls come from and how they follow what happens, without anyone
 * typing them.
 *
 * Made at the moment something is done (the hooks, called by the finance,
 * consultation and appointment modules once their own work has committed;
 * a failure here never undoes theirs):
 *  - a procedure signed: its treatment's reviews (transplant at months 1, 3,
 *    6 and 12), and for a course recorded a session at a time the next
 *    session until the course is complete;
 *  - a session of a course done: the next session, an interval later;
 *  - a consultation signed: the reviews of a diagnosis rule (acne at 6–8
 *    weeks) and any follow-up the doctor stated ("review in 6 weeks").
 * Made by the sweep (every few minutes, `recalls-sweep`):
 *  - planned treatment still not booked three days after it was planned;
 *  - a visit cancelled or missed and not rebooked within 48 hours;
 *  - a patient with no visit for 12 months, and again at 18 (unless they
 *    declined at 12); patients last seen over two years ago are left to
 *    campaigns;
 *  - a course with sessions left and no recall for the next one (a safety
 *    net for the hook).
 *
 * Never a duplicate: each recall has a key naming its source (the review,
 * the session, the plan, the missed visit, the lapse), unique per clinic, so
 * the same thing is never recalled twice however often the hooks and the
 * sweep run; a patient already being recalled gets no second contact recall
 * (missed, unbooked, lapsed) on top, and a stated follow-up within two weeks
 * of a recall already due is the same return.
 *
 * Then each recall follows the patient (`syncPatientRecalls`): a booking
 * from two weeks before its due day books it (BOOKED); that visit cancelled
 * or missed reopens it; the visit made (or a walk-in) closes a review, a
 * missed-visit or a lapsed recall as DONE; a session or planned treatment is
 * done when it is marked done on the procedure, and a visit that ends without
 * it reopens the recall for the desk to check; a cancelled treatment closes
 * its recalls as declined.
 */

type Client = Prisma.TransactionClient;

export interface EngineActor {
  id?: string | null;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A moment as the UTC wall time the columns hold (Prisma binds a Date as timestamptz, which a non-UTC server would shift). */
const utc = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
const VISITED: readonly AppointmentStatus[] = ["COMPLETED", "CHECKED_IN", "IN_PROGRESS"];
const BOOKED_AHEAD: readonly AppointmentStatus[] = ["SCHEDULED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"];
const ACTIVE = ACTIVE_RECALL_STATUSES as readonly RecallStatus[];
const WAITING = WAITING_RECALL_STATUSES as readonly RecallStatus[];

const isUnique = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const net = (p: { price: number; discount: number }) => Math.max(0, p.price - p.discount);

function day(date: Date, tz: string): string {
  return formatDateInTz(date, tz, { day: "numeric", month: "short", year: "numeric" });
}

function dayTime(date: Date, tz: string): string {
  return `${formatDateInTz(date, tz, { weekday: "short", day: "numeric", month: "short" })} ${formatTimeInTz(date, tz)}`;
}

/** "1-month", "6-week", "10-day": how long after the treatment a review is. */
export function durationPhrase(days: number): string {
  const months = days / 30.44;
  if (days >= 28 && Math.abs(months - Math.round(months)) * 30.44 <= 3) return `${Math.round(months)}-month`;
  if (days % 7 === 0) return `${days / 7}-week`;
  return `${days}-day`;
}

const KIND_WORD: Record<AppointmentKind, string> = { CONSULTATION: "consultation", FOLLOW_UP: "follow-up", PROCEDURE: "procedure", CHECK_UP: "check-up" };

// ── Making ───────────────────────────────────────────────────────────────────

interface Draft {
  patientId: string;
  kind: RecallKind;
  label: string;
  /** Any moment of the due day. */
  due: Date;
  windowDays: number;
  dedupeKey: string;
  ruleId?: string | null;
  treatmentId?: string | null;
  procedureId?: string | null;
  stage?: number | null;
  appointmentId?: string | null;
  consultationId?: string | null;
  ownerRole?: UserRole;
  ownerId?: string | null;
  channel?: ChannelType;
  value?: number;
  createdById?: string | null;
  /** Why it was made: the first line of its log. */
  why: string;
}

function ownedBy(rule: Pick<RecallRule, "ownerRole" | "ownerId" | "channel"> | null | undefined) {
  return { ownerRole: rule?.ownerRole ?? "RECEPTIONIST", ownerId: rule?.ownerId ?? null, channel: rule?.channel ?? "WHATSAPP" } as const;
}

/** Make a recall unless its source was already recalled (then nothing). Returns the new id, or null. */
async function makeRecall(tenantId: string, d: Draft, tz: string, now: Date): Promise<string | null> {
  const dueAt = startOfDayInTz(d.due, tz);
  const windowEndAt = endOfDayInTz(addDays(dueAt, d.windowDays, tz), tz);
  // A follow-up the doctor stated within two weeks of a rule's review or a course's session is that same
  // return: it becomes this recall (keeping its log) instead of a second one beside it.
  if (d.kind === "NEXT_SESSION" || (d.kind === "REVIEW" && d.ruleId)) {
    const stated = await db.recall.findFirst({
      where: {
        tenantId,
        patientId: d.patientId,
        status: { in: [...ACTIVE] },
        dedupeKey: { startsWith: "followup:" },
        dueAt: { gte: new Date(dueAt.getTime() - DUE_SOON_DAYS * DAY_MS), lte: new Date(dueAt.getTime() + DUE_SOON_DAYS * DAY_MS) },
      },
      orderBy: { dueAt: "asc" },
      select: { id: true, label: true },
    });
    if (stated && !(await db.recall.findFirst({ where: { tenantId, dedupeKey: d.dedupeKey }, select: { id: true } }))) {
      const merged = await moveRecall(tenantId, stated.id, {
        from: ACTIVE,
        data: {
          kind: d.kind,
          label: d.label.slice(0, 200),
          ruleId: d.ruleId ?? null,
          treatmentId: d.treatmentId ?? null,
          procedureId: d.procedureId ?? null,
          stage: d.stage ?? null,
          dueAt,
          windowEndAt,
          value: Math.max(0, Math.round(d.value ?? 0)),
          dedupeKey: d.dedupeKey,
        },
        outcome: "MERGED",
        note: `${d.why.slice(0, 600)} The doctor's "${stated.label.replace(/^Follow-up: /, "")}" is this same return.`,
        at: now,
        byId: d.createdById ?? null,
      }).catch((err: unknown) => {
        if (isUnique(err)) return false;
        throw err;
      });
      if (merged) return stated.id;
    }
  }
  try {
    return await db.$transaction(async (tx) => {
      const recall = await tx.recall.create({
        data: {
          tenantId,
          patientId: d.patientId,
          kind: d.kind,
          ruleId: d.ruleId ?? null,
          treatmentId: d.treatmentId ?? null,
          procedureId: d.procedureId ?? null,
          stage: d.stage ?? null,
          appointmentId: d.appointmentId ?? null,
          consultationId: d.consultationId ?? null,
          label: d.label.slice(0, 200),
          dueAt,
          windowEndAt,
          ownerRole: d.ownerRole ?? "RECEPTIONIST",
          ownerId: d.ownerId ?? null,
          channel: d.channel ?? "WHATSAPP",
          value: Math.max(0, Math.round(d.value ?? 0)),
          dedupeKey: d.dedupeKey,
          createdById: d.createdById ?? null,
          createdAt: now,
        },
        select: { id: true },
      });
      await tx.recallActivity.create({ data: { tenantId, recallId: recall.id, kind: "STATUS", outcome: "OPEN", note: d.why.slice(0, 1000), byId: d.createdById ?? null, at: now } });
      return recall.id;
    });
  } catch (err) {
    if (isUnique(err)) return null;
    throw err;
  }
}

/**
 * A rule's review: one at a time per rule and review day for a patient. When
 * one is still being worked (the treatment done again, the diagnosis seen
 * again), an untouched one moves to the new dates instead of a second being
 * made; one already contacted or booked stands.
 */
async function makeRuleReview(tenantId: string, rule: RecallRule, days: number, d: Draft, again: string, tz: string, now: Date): Promise<string | null> {
  const existing = await db.recall.findFirst({
    where: { tenantId, patientId: d.patientId, ruleId: rule.id, status: { in: [...ACTIVE] }, dedupeKey: { endsWith: `:${rule.id}:${days}` } },
    orderBy: { dueAt: "asc" },
    select: { id: true, status: true, attempts: true, autoStep: true, dueAt: true, dedupeKey: true },
  });
  if (!existing) return makeRecall(tenantId, d, tz, now);
  if (existing.dedupeKey === d.dedupeKey) return null;
  const dueAt = startOfDayInTz(d.due, tz);
  if (existing.status === "OPEN" && existing.attempts === 0 && existing.autoStep === 0 && dueAt.getTime() > existing.dueAt.getTime()) {
    await moveRecall(tenantId, existing.id, {
      from: ["OPEN"],
      data: { dueAt, windowEndAt: endOfDayInTz(addDays(dueAt, rule.windowDays, tz), tz) },
      outcome: "MOVED",
      note: `${again}: now due ${day(dueAt, tz)}.`,
      at: now,
      byId: d.createdById ?? null,
    });
  }
  return null;
}

// ── Moving and closing ───────────────────────────────────────────────────────

interface Ending {
  status: "DONE" | "DECLINED" | "UNREACHABLE";
  note: string;
  at: Date;
  byId?: string | null;
  reason?: string | null;
  outcomeNote?: string | null;
  doneAppointmentId?: string | null;
}

/** Close an active recall (conditional, so a person closing it at the same moment wins once). */
export async function closeRecall(tenantId: string, id: string, end: Ending, client?: Client): Promise<boolean> {
  const run = async (tx: Client) => {
    const changed = await tx.recall.updateMany({
      where: { id, tenantId, status: { in: [...ACTIVE] } },
      data: {
        status: end.status,
        closedAt: end.at,
        closedById: end.byId ?? null,
        declineReason: end.status === "DECLINED" ? (end.reason ?? "other") : null,
        ...(end.outcomeNote !== undefined ? { outcomeNote: end.outcomeNote } : {}),
        ...(end.doneAppointmentId ? { doneAppointmentId: end.doneAppointmentId } : {}),
        nextContactAt: null,
      },
    });
    if (!changed.count) return false;
    await tx.recallActivity.create({ data: { tenantId, recallId: id, kind: "STATUS", outcome: end.status, note: end.note.slice(0, 1000), byId: end.byId ?? null, at: end.at } });
    return true;
  };
  return client ? run(client) : db.$transaction(run);
}

interface Move {
  from: readonly RecallStatus[];
  data: Prisma.RecallUncheckedUpdateManyInput;
  outcome: string;
  note: string;
  at: Date;
  byId?: string | null;
}

/** Move a recall between working states, only from the states given. */
export async function moveRecall(tenantId: string, id: string, move: Move, client?: Client): Promise<boolean> {
  const run = async (tx: Client) => {
    const changed = await tx.recall.updateMany({ where: { id, tenantId, status: { in: [...move.from] } }, data: move.data });
    if (!changed.count) return false;
    await tx.recallActivity.create({ data: { tenantId, recallId: id, kind: "STATUS", outcome: move.outcome, note: move.note.slice(0, 1000), byId: move.byId ?? null, at: move.at } });
    return true;
  };
  return client ? run(client) : db.$transaction(run);
}

async function closeWhere(tenantId: string, where: Prisma.RecallWhereInput, end: Ending): Promise<number> {
  const rows = await db.recall.findMany({ where: { ...where, tenantId, status: { in: [...ACTIVE] } }, select: { id: true } });
  let n = 0;
  for (const r of rows) if (await closeRecall(tenantId, r.id, end)) n += 1;
  return n;
}

// ── The hooks ────────────────────────────────────────────────────────────────

const procedureInclude = {
  treatment: { select: { id: true, name: true } },
  priceItem: { select: { name: true } },
  patient: { select: { deletedAt: true } },
  charges: { select: { amount: true, stage: true, reversalOfId: true, chargedAt: true } },
} satisfies Prisma.ProcedureInclude;

type ProcedureRow = Prisma.ProcedureGetPayload<{ include: typeof procedureInclude }>;

const courseName = (p: ProcedureRow) => p.priceItem?.name ?? p.treatment.name;

/** When the work was last done: the latest session charged, or the day it was performed. */
function lastDoneAt(p: ProcedureRow): Date {
  const sessions = p.charges.filter((c) => c.stage !== null && c.reversalOfId === null).map((c) => c.chargedAt.getTime());
  return sessions.length ? new Date(Math.max(...sessions)) : p.performedAt;
}

/**
 * Where this procedure stands in a run of single-session procedures of the
 * same treatment (1 for the first): earlier ones count while each followed
 * the one before within the interval, its window and two weeks' grace.
 */
async function seriesPosition(tenantId: string, p: ProcedureRow, rule: RecallRule): Promise<number> {
  const earlier = await db.procedure.findMany({
    where: { tenantId, patientId: p.patientId, treatmentId: p.treatmentId, status: "SIGNED", stages: { lte: 1 }, ...notDeleted, id: { not: p.id }, performedAt: { lte: p.performedAt } },
    orderBy: { performedAt: "desc" },
    take: 60,
    select: { performedAt: true },
  });
  const gapMs = ((rule.dueDays[0] ?? FALLBACK_SESSION_DAYS) + rule.windowDays + 14) * DAY_MS;
  let position = 1;
  let after = p.performedAt;
  for (const e of earlier) {
    if (after.getTime() - e.performedAt.getTime() > gapMs) break;
    position += 1;
    after = e.performedAt;
  }
  return position;
}

/**
 * A procedure was signed. What waited on it is done (its plan, its last
 * session, an earlier session's recall of a one-at-a-time course); its
 * treatment's reviews are made, and a one-at-a-time course recalls its next
 * session until it is complete. Returns how many recalls were made.
 */
export async function recallsOnProcedureSigned(tenantId: string, procedureId: string, actor: EngineActor = {}, now: Date = new Date()): Promise<number> {
  const p = await db.procedure.findFirst({ where: { id: procedureId, tenantId, ...notDeleted }, include: procedureInclude });
  if (!p || p.status !== "SIGNED" || p.patient.deletedAt) return 0;
  const tz = await getTenantTimezone(tenantId);
  const doneAt = lastDoneAt(p);
  const doneDay = day(doneAt, tz);

  await closeWhere(tenantId, { procedureId: p.id, kind: { in: ["UNBOOKED", "NEXT_SESSION"] } }, { status: "DONE", note: `${courseName(p)} done on ${doneDay}.`, at: now, byId: actor.id ?? null });
  if (p.stages <= 1) {
    // A course recorded a session at a time: the recall for this session (made after the one before) is done.
    await closeWhere(
      tenantId,
      { patientId: p.patientId, treatmentId: p.treatmentId, kind: "NEXT_SESSION", procedureId: { not: p.id }, procedure: { is: { stages: { lte: 1 } } } },
      { status: "DONE", note: `${courseName(p)} done on ${doneDay}.`, at: now, byId: actor.id ?? null },
    );
  }

  const rules = (await activeRules(tenantId)).filter((r) => r.treatmentId === p.treatmentId);
  let made = 0;
  for (const rule of rules) {
    if (rule.kind === "REVIEWS") {
      for (const days of rule.dueDays) {
        const phrase = durationPhrase(days);
        const id = await makeRuleReview(
          tenantId,
          rule,
          days,
          {
            patientId: p.patientId,
            kind: "REVIEW",
            label: `${p.treatment.name} · ${phrase} review`,
            due: addDays(doneAt, days, tz),
            windowDays: rule.windowDays,
            dedupeKey: `review:${p.id}:${rule.id}:${days}`,
            ruleId: rule.id,
            treatmentId: p.treatmentId,
            procedureId: p.id,
            ...ownedBy(rule),
            createdById: actor.id ?? null,
            why: `${p.treatment.name} done on ${doneDay}: the ${phrase} review (rule "${rule.name}").`,
          },
          `${p.treatment.name} done again on ${doneDay}`,
          tz,
          now,
        );
        if (id) made += 1;
      }
    } else if (p.stages <= 1 && rule.sessions) {
      const position = await seriesPosition(tenantId, p, rule);
      if (position >= rule.sessions) continue;
      const interval = rule.dueDays[0] ?? FALLBACK_SESSION_DAYS;
      const id = await makeRecall(
        tenantId,
        {
          patientId: p.patientId,
          kind: "NEXT_SESSION",
          label: `${courseName(p)} · session ${position + 1} of ${rule.sessions}`,
          due: addDays(doneAt, interval, tz),
          windowDays: rule.windowDays,
          dedupeKey: `series:${p.id}`,
          ruleId: rule.id,
          treatmentId: p.treatmentId,
          procedureId: p.id,
          stage: position + 1,
          ...ownedBy(rule),
          value: net(p),
          createdById: actor.id ?? null,
          why: `Session ${position} of ${rule.sessions} done on ${doneDay}: the next is due ${interval} days later (rule "${rule.name}").`,
        },
        tz,
        now,
      );
      if (id) made += 1;
    }
  }
  return made;
}

/**
 * A session of a course was done: its recall (and the plan's) is done, and
 * the next session is recalled an interval later (the treatment's session
 * rule, or four weeks). The last session signs the course, which
 * `recallsOnProcedureSigned` handles.
 */
export async function recallsOnStageDone(tenantId: string, procedureId: string, stage: number, performedAt: Date, actor: EngineActor = {}, now: Date = new Date()): Promise<number> {
  const p = await db.procedure.findFirst({ where: { id: procedureId, tenantId, ...notDeleted }, include: procedureInclude });
  if (!p || p.patient.deletedAt) return 0;
  const tz = await getTenantTimezone(tenantId);
  const doneDay = day(performedAt, tz);
  await closeWhere(tenantId, { procedureId: p.id, kind: "NEXT_SESSION", stage: { lte: stage } }, { status: "DONE", note: `Session ${stage} of ${p.stages} done on ${doneDay}.`, at: now, byId: actor.id ?? null });
  await closeWhere(tenantId, { procedureId: p.id, kind: "UNBOOKED" }, { status: "DONE", note: `Under way: session ${stage} done on ${doneDay}.`, at: now, byId: actor.id ?? null });
  if (p.status !== "STARTED" || stage >= p.stages) return 0;
  return (await recallNextSession(tenantId, p, stage, performedAt, tz, now, actor.id ?? null)) ? 1 : 0;
}

async function recallNextSession(tenantId: string, p: ProcedureRow, stageDone: number, doneAt: Date, tz: string, now: Date, byId: string | null): Promise<string | null> {
  const rule = (await activeRules(tenantId)).find((r) => r.kind === "SESSIONS" && r.treatmentId === p.treatmentId) ?? null;
  const interval = rule?.dueDays[0] ?? FALLBACK_SESSION_DAYS;
  const next = stageDone + 1;
  return makeRecall(
    tenantId,
    {
      patientId: p.patientId,
      kind: "NEXT_SESSION",
      label: `${courseName(p)} · session ${next} of ${p.stages}`,
      due: addDays(doneAt, interval, tz),
      windowDays: rule?.windowDays ?? FALLBACK_SESSION_WINDOW,
      dedupeKey: `session:${p.id}:${next}`,
      ruleId: rule?.id ?? null,
      treatmentId: p.treatmentId,
      procedureId: p.id,
      stage: next,
      ...ownedBy(rule),
      value: stageShare(net(p), p.stages, next),
      createdById: byId,
      why: `Session ${stageDone} of ${p.stages} done on ${day(doneAt, tz)}: session ${next} is due ${interval} days later${rule ? ` (rule "${rule.name}")` : ""}.`,
    },
    tz,
    now,
  );
}

/** Staged work was started: its plan is no longer waiting for a booking. */
export async function recallsOnProcedureStarted(tenantId: string, procedureId: string, actor: EngineActor = {}, now: Date = new Date()): Promise<number> {
  const tz = await getTenantTimezone(tenantId);
  return closeWhere(tenantId, { procedureId, kind: "UNBOOKED" }, { status: "DONE", note: `Started on ${day(now, tz)}.`, at: now, byId: actor.id ?? null });
}

/** A procedure was cancelled: what it brought the patient back for no longer applies. */
export async function recallsOnProcedureCancelled(tenantId: string, procedureId: string, reason: string, actor: EngineActor = {}, now: Date = new Date()): Promise<number> {
  return closeWhere(tenantId, { procedureId }, { status: "DECLINED", reason: "treatment_cancelled", outcomeNote: reason.slice(0, 500), note: `The treatment was cancelled: ${reason}`, at: now, byId: actor.id ?? null });
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : []);

/**
 * A consultation was signed: a diagnosis rule's reviews (an untouched one
 * from the same rule moves to the new dates instead of a second being made)
 * and each follow-up the doctor stated with a time. Then the patient's
 * recalls follow the visit (the signature completes the appointment).
 */
export async function recallsOnConsultationSigned(tenantId: string, consultationId: string, actor: EngineActor = {}, now: Date = new Date()): Promise<number> {
  const c = await db.consultation.findFirst({
    where: { id: consultationId, tenantId, status: "SIGNED" },
    select: { id: true, patientId: true, extraction: true, reviewedAt: true, patient: { select: { deletedAt: true } } },
  });
  if (!c || c.patient.deletedAt) return 0;
  const tz = await getTenantTimezone(tenantId);
  const signedAt = c.reviewedAt ?? now;
  const signedDay = day(signedAt, tz);
  const extraction = (c.extraction && typeof c.extraction === "object" ? c.extraction : {}) as Record<string, unknown>;
  const diagnoses = stringList(extraction.diagnoses);
  const normalised = diagnoses.map(normaliseTerm);
  let made = 0;

  for (const rule of (await activeRules(tenantId)).filter((r) => r.diagnosisTerms.length > 0)) {
    const at = normalised.findIndex((d) => rule.diagnosisTerms.some((t) => d.includes(t)));
    if (at < 0) continue;
    const diagnosis = diagnoses[at]!;
    for (const days of rule.dueDays) {
      const phrase = durationPhrase(days);
      const id = await makeRuleReview(
        tenantId,
        rule,
        days,
        {
          patientId: c.patientId,
          kind: "REVIEW",
          label: `${diagnosis} · ${phrase} review`,
          due: addDays(signedAt, days, tz),
          windowDays: rule.windowDays,
          dedupeKey: `dx:${c.id}:${rule.id}:${days}`,
          ruleId: rule.id,
          treatmentId: rule.treatmentId,
          consultationId: c.id,
          ...ownedBy(rule),
          createdById: actor.id ?? null,
          why: `Diagnosis "${diagnosis}" signed on ${signedDay}: the ${phrase} review (rule "${rule.name}").`,
        },
        `Seen again on ${signedDay} ("${diagnosis}")`,
        tz,
        now,
      );
      if (id) made += 1;
    }
  }

  const followUps = stringList(extraction.followUps);
  for (const [i, text] of followUps.entries()) {
    const days = followUpDays(text);
    if (!days) continue;
    const due = addDays(signedAt, days, tz);
    // The same return as a recall already due within two weeks of it (a rule's review, a course's session).
    const near = await db.recall.findFirst({
      where: { tenantId, patientId: c.patientId, status: { in: [...ACTIVE] }, dueAt: { gte: new Date(due.getTime() - DUE_SOON_DAYS * DAY_MS), lte: new Date(due.getTime() + DUE_SOON_DAYS * DAY_MS) } },
      select: { id: true },
    });
    if (near) continue;
    const id = await makeRecall(
      tenantId,
      {
        patientId: c.patientId,
        kind: "REVIEW",
        label: `Follow-up: ${text.trim().slice(0, 120)}`,
        due,
        windowDays: followUpWindow(days),
        dedupeKey: `followup:${c.id}:${i}`,
        consultationId: c.id,
        createdById: actor.id ?? null,
        why: `The doctor wrote "${text.trim().slice(0, 300)}" when signing on ${signedDay}.`,
      },
      tz,
      now,
    );
    if (id) made += 1;
  }

  await syncPatientRecalls(tenantId, c.patientId, now, tz);
  return made;
}

// ── Following the patient ────────────────────────────────────────────────────

export interface SyncResult {
  booked: number;
  reopened: number;
  done: number;
  declined: number;
}

interface VisitRow {
  id: string;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
  createdById: string | null;
}

function acceptingBooking(r: { dueAt: Date }, appointments: readonly VisitRow[], now: Date, except?: string | null): VisitRow | null {
  const from = r.dueAt.getTime() - DUE_SOON_DAYS * DAY_MS;
  return (
    appointments
      // Booked by then (a replay of the past must not see bookings made later), ahead, from two weeks before the due day.
      .filter((a) => a.id !== except && BOOKED_AHEAD.includes(a.status) && a.createdAt.getTime() <= now.getTime() && a.endsAt.getTime() > now.getTime() && a.startsAt.getTime() >= from)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0] ?? null
  );
}

/**
 * Bring one patient's recalls in line with their bookings, visits and work
 * (see the comment at the top). Idempotent: the appointment, procedure and
 * consultation hooks call it for the patient, the sweep for everyone whose
 * recalls may have moved.
 */
export async function syncPatientRecalls(tenantId: string, patientId: string, now: Date = new Date(), tz?: string): Promise<SyncResult> {
  const result: SyncResult = { booked: 0, reopened: 0, done: 0, declined: 0 };
  const recalls = await db.recall.findMany({
    where: { tenantId, patientId, status: { in: [...ACTIVE] } },
    orderBy: { dueAt: "asc" },
    select: { id: true, kind: true, status: true, dueAt: true, createdAt: true, procedureId: true, treatmentId: true, stage: true, bookedAppointmentId: true },
  });
  if (!recalls.length) return result;
  const patient = await db.patient.findFirst({ where: { id: patientId, tenantId }, select: { deletedAt: true } });
  if (!patient || patient.deletedAt) {
    for (const r of recalls) {
      if (await closeRecall(tenantId, r.id, { status: "DECLINED", reason: "patient_archived", note: "The patient's record was archived.", at: now })) result.declined += 1;
    }
    return result;
  }
  const zone = tz ?? (await getTenantTimezone(tenantId));

  const earliest = new Date(Math.min(...recalls.map((r) => Math.min(r.createdAt.getTime(), r.dueAt.getTime() - DUE_SOON_DAYS * DAY_MS))) - DAY_MS);
  const bookedIds = recalls.map((r) => r.bookedAppointmentId).filter((id): id is string => Boolean(id));
  const appointments: VisitRow[] = await db.appointment.findMany({
    where: { tenantId, patientId, ...notDeleted, OR: [{ startsAt: { gte: earliest } }, ...(bookedIds.length ? [{ id: { in: bookedIds } }] : [])] },
    orderBy: { startsAt: "asc" },
    select: { id: true, status: true, startsAt: true, endsAt: true, createdAt: true, createdById: true },
  });
  const procIds = [...new Set(recalls.map((r) => r.procedureId).filter((id): id is string => Boolean(id)))];
  const procedures = new Map(
    (procIds.length
      ? await db.procedure.findMany({
          where: { tenantId, id: { in: procIds } },
          select: { id: true, status: true, stages: true, deletedAt: true, cancelReason: true, treatmentId: true, charges: { select: { amount: true, stage: true, reversalOfId: true } } },
        })
      : []
    ).map((p) => [p.id, p]),
  );
  // One-at-a-time courses: the next session is done when a later procedure of the treatment is signed.
  const seriesTreatments = [...new Set(recalls.filter((r) => r.kind === "NEXT_SESSION" && r.procedureId && (procedures.get(r.procedureId)?.stages ?? 1) <= 1).map((r) => r.treatmentId).filter((id): id is string => Boolean(id)))];
  const laterSigned = seriesTreatments.length
    ? await db.procedure.findMany({ where: { tenantId, patientId, treatmentId: { in: seriesTreatments }, status: "SIGNED", ...notDeleted, performedAt: { gte: earliest } }, select: { id: true, treatmentId: true, performedAt: true, signedAt: true } })
    : [];

  for (const r of recalls) {
    const proc = r.procedureId ? procedures.get(r.procedureId) : undefined;
    // The treatment went away.
    if (proc && (proc.status === "CANCELLED" || proc.deletedAt)) {
      if (await closeRecall(tenantId, r.id, { status: "DECLINED", reason: "treatment_cancelled", outcomeNote: proc.cancelReason, note: `The treatment was cancelled${proc.cancelReason ? `: ${proc.cancelReason}` : "."}`, at: now })) result.declined += 1;
      continue;
    }
    // The work it waited for was marked done.
    if (r.kind === "NEXT_SESSION" && proc && r.stage) {
      const series = proc.stages <= 1;
      const done = series
        ? laterSigned.find((s) => s.treatmentId === r.treatmentId && s.id !== proc.id && (s.signedAt ?? s.performedAt).getTime() >= r.createdAt.getTime() - DAY_MS)
        : summarizeCharges(proc.charges).stagesDone >= r.stage || proc.status === "SIGNED";
      if (done) {
        if (await closeRecall(tenantId, r.id, { status: "DONE", note: `Session ${r.stage} done.`, at: now, doneAppointmentId: r.status === "BOOKED" ? r.bookedAppointmentId : null })) result.done += 1;
        continue;
      }
    }
    if (r.kind === "UNBOOKED" && proc && proc.status !== "PLANNED") {
      if (await closeRecall(tenantId, r.id, { status: "DONE", note: proc.status === "SIGNED" ? "The planned treatment was done." : "The planned treatment was started.", at: now, doneAppointmentId: r.status === "BOOKED" ? r.bookedAppointmentId : null })) result.done += 1;
      continue;
    }

    const waitsForWork = r.kind === "NEXT_SESSION" || r.kind === "UNBOOKED";
    if (r.status === "BOOKED") {
      const booked = appointments.find((a) => a.id === r.bookedAppointmentId) ?? null;
      const lost = !booked || booked.status === "CANCELLED" || booked.status === "NO_SHOW";
      // A booked visit long past and never marked attended or missed holds nothing either.
      const stale = booked && (booked.status === "SCHEDULED" || booked.status === "CONFIRMED") && booked.endsAt.getTime() < startOfDayInTz(new Date(now.getTime() - DAY_MS), zone).getTime();
      if (lost || stale) {
        const other = acceptingBooking(r, appointments, now, r.bookedAppointmentId);
        const what = !booked ? "was removed" : booked.status === "NO_SHOW" ? "was missed" : booked.status === "CANCELLED" ? "was cancelled" : "was never marked attended or missed";
        const when = booked ? ` on ${dayTime(booked.startsAt, zone)}` : "";
        if (other) {
          if (await moveRecall(tenantId, r.id, { from: ["BOOKED"], data: { bookedAppointmentId: other.id, bookedAt: now }, outcome: "BOOKED", note: `The booked visit${when} ${what}; booked again for ${dayTime(other.startsAt, zone)}.`, at: now, byId: other.createdById })) result.booked += 1;
        } else if (await moveRecall(tenantId, r.id, { from: ["BOOKED"], data: { status: "OPEN", nextContactAt: now }, outcome: "OPEN", note: `The booked visit${when} ${what}: contact the patient again.`, at: now })) {
          result.reopened += 1;
        }
        continue;
      }
      if (booked && VISITED.includes(booked.status)) {
        if (!waitsForWork) {
          if (await closeRecall(tenantId, r.id, { status: "DONE", note: `Came in on ${dayTime(booked.startsAt, zone)}.`, at: now, doneAppointmentId: booked.id })) result.done += 1;
        } else if (booked.status === "COMPLETED" && now.getTime() >= endOfDayInTz(booked.startsAt, zone).getTime()) {
          const what = r.kind === "NEXT_SESSION" ? `session ${r.stage}` : "the planned treatment";
          if (await moveRecall(tenantId, r.id, { from: ["BOOKED"], data: { status: "OPEN", nextContactAt: now }, outcome: "OPEN", note: `Came in on ${day(booked.startsAt, zone)}, but ${what} is not marked done: mark it on the procedure, or book it again.`, at: now })) result.reopened += 1;
        }
      }
      continue;
    }

    // Waiting for a booking. A visit since it was made (a walk-in, one booked before it existed) serves a review, a missed visit or a lapse.
    if (!waitsForWork) {
      const from = Math.max(r.createdAt.getTime(), r.dueAt.getTime() - DUE_SOON_DAYS * DAY_MS);
      const visited = appointments.find((a) => VISITED.includes(a.status) && a.startsAt.getTime() >= from && a.startsAt.getTime() <= now.getTime());
      if (visited) {
        if (await closeRecall(tenantId, r.id, { status: "DONE", note: `Came in on ${dayTime(visited.startsAt, zone)}.`, at: now, doneAppointmentId: visited.id })) result.done += 1;
        continue;
      }
    }
    const ahead = acceptingBooking(r, appointments, now);
    if (ahead && WAITING.includes(r.status)) {
      const changed = await moveRecall(tenantId, r.id, {
        from: WAITING,
        data: { status: "BOOKED", bookedAppointmentId: ahead.id, bookedAt: now, bookedById: ahead.createdById, nextContactAt: null, snoozedUntil: null },
        outcome: "BOOKED",
        note: `Booked for ${dayTime(ahead.startsAt, zone)}.`,
        at: now,
        byId: ahead.createdById,
      });
      if (changed) result.booked += 1;
    }
  }
  return result;
}

// ── The sweep ────────────────────────────────────────────────────────────────

/** Patients whose recalls may have moved since they were last looked at. */
async function patientsToSync(tenantId: string, now: Date, tz: string): Promise<string[]> {
  const staleBefore = startOfDayInTz(new Date(now.getTime() - DAY_MS), tz);
  const rows = await db.$queryRaw<{ patientId: string }[]>`
    SELECT DISTINCT r."patientId"
    FROM "recalls" r
    JOIN "patients" p ON p.id = r."patientId"
    LEFT JOIN "appointments" b ON b.id = r."bookedAppointmentId"
    LEFT JOIN "procedures" pr ON pr.id = r."procedureId"
    WHERE r."tenantId" = ${tenantId}
      AND r.status IN ('OPEN', 'CONTACTED', 'SNOOZED', 'BOOKED')
      AND (
        p."deletedAt" IS NOT NULL
        OR (r.status = 'BOOKED' AND (b.id IS NULL OR b."deletedAt" IS NOT NULL OR b.status NOT IN ('SCHEDULED', 'CONFIRMED') OR b."endsAt" < ${utc(staleBefore)}))
        OR (r.status <> 'BOOKED' AND EXISTS (
          SELECT 1 FROM "appointments" a
          WHERE a."tenantId" = r."tenantId" AND a."patientId" = r."patientId" AND a."deletedAt" IS NULL
            AND a."startsAt" >= r."dueAt" - interval '14 days'
            AND (
              (a.status IN ('SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS') AND a."endsAt" > ${utc(now)})
              OR (a.status IN ('COMPLETED', 'CHECKED_IN', 'IN_PROGRESS') AND a."startsAt" >= r."createdAt" AND a."startsAt" <= ${utc(now)})
            )
        ))
        OR (pr.id IS NOT NULL AND (
          pr."deletedAt" IS NOT NULL OR pr.status = 'CANCELLED'
          OR (r.kind = 'UNBOOKED' AND pr.status <> 'PLANNED')
          OR (r.kind = 'NEXT_SESSION' AND pr.stages > 1 AND (pr.status = 'SIGNED' OR EXISTS (
            SELECT 1 FROM "charges" c WHERE c."procedureId" = pr.id AND c.stage >= r.stage AND c."reversalOfId" IS NULL
          )))
          OR (r.kind = 'NEXT_SESSION' AND pr.stages <= 1 AND EXISTS (
            SELECT 1 FROM "procedures" s
            WHERE s."tenantId" = r."tenantId" AND s."patientId" = r."patientId" AND s."treatmentId" = r."treatmentId" AND s.id <> pr.id
              AND s.status = 'SIGNED' AND s."deletedAt" IS NULL AND COALESCE(s."signedAt", s."performedAt") >= r."createdAt" - interval '1 day'
          ))
        ))
      )
    LIMIT 500`;
  return rows.map((r) => r.patientId);
}

/** Snoozes that ran out: back on the list. */
async function wakeSnoozed(tenantId: string, now: Date): Promise<number> {
  const rows = await db.recall.findMany({ where: { tenantId, status: "SNOOZED", snoozedUntil: { lte: now } }, select: { id: true } });
  let n = 0;
  for (const r of rows) {
    if (await moveRecall(tenantId, r.id, { from: ["SNOOZED"], data: { status: "OPEN", snoozedUntil: null, nextContactAt: now }, outcome: "OPEN", note: "The snooze ended.", at: now })) n += 1;
  }
  return n;
}

/** A course with sessions left and no recall for the next one (the hook failed, or it predates recalls). */
async function recallCourses(tenantId: string, now: Date, tz: string): Promise<number> {
  const courses = await db.procedure.findMany({
    where: { tenantId, status: "STARTED", stages: { gt: 1 }, ...notDeleted, patient: { deletedAt: null } },
    include: procedureInclude,
    take: 500,
  });
  let made = 0;
  for (const p of courses) {
    const { stagesDone } = summarizeCharges(p.charges);
    if (stagesDone < 1 || stagesDone >= p.stages) continue;
    const exists = await db.recall.findFirst({ where: { tenantId, dedupeKey: `session:${p.id}:${stagesDone + 1}` }, select: { id: true } });
    if (exists) continue;
    if (await recallNextSession(tenantId, p, stagesDone, lastDoneAt(p), tz, now, null)) made += 1;
  }
  return made;
}

const CONTACT_KINDS = "('MISSED', 'UNBOOKED', 'LAPSED')";

/** Visits cancelled or missed 48 hours ago or more (within two weeks) and not rebooked. */
async function recallMissedVisits(tenantId: string, now: Date, tz: string): Promise<number> {
  const before = new Date(now.getTime() - MISSED_AFTER_HOURS * HOUR_MS);
  const since = new Date(now.getTime() - 14 * DAY_MS);
  const soon = new Date(now.getTime() + DUE_SOON_DAYS * DAY_MS);
  const rows = await db.$queryRaw<{ id: string; patientId: string; status: AppointmentStatus; kind: AppointmentKind; startsAt: Date; cancelReason: string | null }[]>`
    SELECT a.id, a."patientId", a.status, a.kind, a."startsAt", a."cancelReason"
    FROM "appointments" a
    JOIN "patients" p ON p.id = a."patientId"
    WHERE a."tenantId" = ${tenantId} AND a."deletedAt" IS NULL AND p."deletedAt" IS NULL
      AND a.status IN ('CANCELLED', 'NO_SHOW')
      AND a."statusChangedAt" <= ${utc(before)} AND a."statusChangedAt" >= ${utc(since)}
      AND NOT EXISTS (SELECT 1 FROM "recalls" r WHERE r."tenantId" = a."tenantId" AND (r."dedupeKey" = 'missed:' || a.id OR r."bookedAppointmentId" = a.id))
      AND NOT EXISTS (
        SELECT 1 FROM "appointments" o
        WHERE o."tenantId" = a."tenantId" AND o."patientId" = a."patientId" AND o.id <> a.id AND o."deletedAt" IS NULL
          AND o.status IN ('SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'WAITLISTED')
          AND (o."startsAt" >= LEAST(a."statusChangedAt", a."startsAt") OR o."createdAt" >= a."statusChangedAt")
      )
      AND NOT EXISTS (
        SELECT 1 FROM "recalls" r
        WHERE r."tenantId" = a."tenantId" AND r."patientId" = a."patientId" AND r.status IN ('OPEN', 'CONTACTED', 'SNOOZED', 'BOOKED')
          AND (r.kind IN ${Prisma.raw(CONTACT_KINDS)} OR r."dueAt" <= ${utc(soon)})
      )
    ORDER BY a."statusChangedAt" ASC
    LIMIT 100`;
  const seen = new Set<string>();
  let made = 0;
  for (const a of rows) {
    if (seen.has(a.patientId)) continue;
    seen.add(a.patientId);
    const planned = await db.procedure.findMany({ where: { tenantId, appointmentId: a.id, status: { in: ["PLANNED", "STARTED"] }, ...notDeleted }, select: { price: true, discount: true } });
    const what = KIND_WORD[a.kind];
    const label = a.status === "NO_SHOW" ? `Missed the ${what} on ${day(a.startsAt, tz)}` : `Cancelled the ${what} on ${day(a.startsAt, tz)}`;
    const id = await makeRecall(
      tenantId,
      {
        patientId: a.patientId,
        kind: "MISSED",
        label,
        due: now,
        windowDays: 7,
        dedupeKey: `missed:${a.id}`,
        appointmentId: a.id,
        value: planned.reduce((s, p) => s + net(p), 0),
        why: `${label}${a.cancelReason ? ` (${a.cancelReason})` : ""} and not rebooked within ${MISSED_AFTER_HOURS} hours.`,
      },
      tz,
      now,
    );
    if (id) made += 1;
  }
  return made;
}

/** Planned treatment not booked three days after it was planned (planned within the last six months). */
async function recallUnbookedPlans(tenantId: string, now: Date, tz: string): Promise<number> {
  const before = new Date(now.getTime() - UNBOOKED_AFTER_DAYS * DAY_MS);
  const since = new Date(now.getTime() - 180 * DAY_MS);
  const rows = await db.$queryRaw<{ id: string; patientId: string; treatmentId: string; price: number; discount: number; createdAt: Date; name: string }[]>`
    SELECT pr.id, pr."patientId", pr."treatmentId", pr.price, pr.discount, pr."createdAt", COALESCE(i.name, t.name) AS name
    FROM "procedures" pr
    JOIN "patients" p ON p.id = pr."patientId"
    JOIN "treatments" t ON t.id = pr."treatmentId"
    LEFT JOIN "price_items" i ON i.id = pr."priceItemId"
    WHERE pr."tenantId" = ${tenantId} AND pr."deletedAt" IS NULL AND p."deletedAt" IS NULL AND pr.status = 'PLANNED'
      AND pr."createdAt" <= ${utc(before)} AND pr."createdAt" >= ${utc(since)}
      AND NOT EXISTS (SELECT 1 FROM "recalls" r WHERE r."tenantId" = pr."tenantId" AND r."dedupeKey" = 'plan:' || pr.id)
      AND NOT EXISTS (
        SELECT 1 FROM "appointments" a
        WHERE a."tenantId" = pr."tenantId" AND a."patientId" = pr."patientId" AND a."deletedAt" IS NULL
          AND a.status IN ('SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'WAITLISTED') AND a."endsAt" > ${utc(now)}
      )
      AND NOT EXISTS (
        SELECT 1 FROM "recalls" r
        WHERE r."tenantId" = pr."tenantId" AND r."patientId" = pr."patientId" AND r.status IN ('OPEN', 'CONTACTED', 'SNOOZED', 'BOOKED') AND r.kind IN ${Prisma.raw(CONTACT_KINDS)}
      )
    ORDER BY pr."createdAt" ASC
    LIMIT 100`;
  const seen = new Set<string>();
  let made = 0;
  for (const p of rows) {
    if (seen.has(p.patientId)) continue;
    seen.add(p.patientId);
    const id = await makeRecall(
      tenantId,
      {
        patientId: p.patientId,
        kind: "UNBOOKED",
        label: `${p.name} planned ${day(p.createdAt, tz)}, not booked`,
        due: now,
        windowDays: 14,
        dedupeKey: `plan:${p.id}`,
        treatmentId: p.treatmentId,
        procedureId: p.id,
        value: net(p),
        why: `${p.name} was planned on ${day(p.createdAt, tz)} and nothing is booked for it ${UNBOOKED_AFTER_DAYS} days later.`,
      },
      tz,
      now,
    );
    if (id) made += 1;
  }
  return made;
}

function monthsBefore(date: Date, months: number): Date {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** No visit for 12 months (and again at 18 unless they declined at 12); last seen within two years. */
async function recallLapsedPatients(tenantId: string, now: Date, tz: string): Promise<number> {
  const [first, second] = LAPSED_MONTHS;
  const at12 = monthsBefore(now, first);
  const at18 = monthsBefore(now, second);
  const horizon = monthsBefore(now, LAPSED_HORIZON_MONTHS);
  const rows = await db.$queryRaw<{ patientId: string; at: Date }[]>`
    WITH seen AS (
      SELECT a."patientId", a."startsAt" AS at FROM "appointments" a
      WHERE a."tenantId" = ${tenantId} AND a."deletedAt" IS NULL AND a.status IN ('COMPLETED', 'CHECKED_IN', 'IN_PROGRESS')
      UNION ALL
      SELECT c."patientId", c."chargedAt" FROM "charges" c WHERE c."tenantId" = ${tenantId} AND c."reversalOfId" IS NULL
      UNION ALL
      SELECT v."patientId", v."createdAt" FROM "visits" v WHERE v."tenantId" = ${tenantId}
    ), last AS (
      SELECT "patientId", max(at) AS at FROM seen GROUP BY "patientId"
    )
    SELECT l."patientId", l.at
    FROM last l
    JOIN "patients" p ON p.id = l."patientId"
    WHERE p."tenantId" = ${tenantId} AND p."deletedAt" IS NULL
      AND l.at <= ${utc(at12)} AND l.at > ${utc(horizon)}
      AND NOT EXISTS (
        SELECT 1 FROM "appointments" f
        WHERE f."tenantId" = ${tenantId} AND f."patientId" = l."patientId" AND f."deletedAt" IS NULL
          AND f.status IN ('SCHEDULED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'WAITLISTED') AND f."endsAt" > ${utc(now)}
      )
      AND NOT EXISTS (
        SELECT 1 FROM "recalls" r WHERE r."tenantId" = ${tenantId} AND r."patientId" = l."patientId" AND r.status IN ('OPEN', 'CONTACTED', 'SNOOZED', 'BOOKED')
      )
    ORDER BY l.at DESC
    LIMIT 100`;
  let made = 0;
  for (const row of rows) {
    const months = row.at.getTime() <= at18.getTime() ? second : first;
    const lastKey = startOfDayInTz(row.at, tz).toISOString().slice(0, 10);
    if (months === second) {
      // Declined at 12 months: not asked again at 18.
      const declined = await db.recall.findFirst({ where: { tenantId, dedupeKey: `lapsed:${row.patientId}:${first}:${lastKey}`, status: "DECLINED" }, select: { id: true } });
      if (declined) continue;
    }
    const id = await makeRecall(
      tenantId,
      {
        patientId: row.patientId,
        kind: "LAPSED",
        label: `No visit since ${day(row.at, tz)} (${months} months)`,
        due: now,
        windowDays: 30,
        dedupeKey: `lapsed:${row.patientId}:${months}:${lastKey}`,
        why: `Last seen on ${day(row.at, tz)}: no visit for ${months} months and nothing booked.`,
      },
      tz,
      now,
    );
    if (id) made += 1;
  }
  return made;
}

export interface SweepSummary {
  tenants: number;
  made: { sessions: number; missed: number; unbooked: number; lapsed: number };
  synced: number;
  woken: number;
}

/** One pass over every active clinic (the `recalls-sweep` job). */
export async function sweepRecalls(now: Date = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = { tenants: 0, made: { sessions: 0, missed: 0, unbooked: 0, lapsed: 0 }, synced: 0, woken: 0 };
  const tenants = await db.tenant.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true } });
  for (const tenant of tenants) {
    summary.tenants += 1;
    const tz = await getTenantTimezone(tenant.id);
    summary.woken += await wakeSnoozed(tenant.id, now);
    for (const patientId of await patientsToSync(tenant.id, now, tz)) {
      await syncPatientRecalls(tenant.id, patientId, now, tz);
      summary.synced += 1;
    }
    summary.made.sessions += await recallCourses(tenant.id, now, tz);
    summary.made.missed += await recallMissedVisits(tenant.id, now, tz);
    summary.made.unbooked += await recallUnbookedPlans(tenant.id, now, tz);
    summary.made.lapsed += await recallLapsedPatients(tenant.id, now, tz);
  }
  return summary;
}

/** For callers that must not fail because of recalls (the hooks in other modules). */
export async function safely<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[recalls] ${what} failed`, err);
    return null;
  }
}
