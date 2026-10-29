import { randomUUID } from "node:crypto";
import { Prisma, type AppointmentKind, type ChannelType, type RecallStatus, type UserRole } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireTenantPatient, TenantScopeError } from "@/lib/tenant-scope";
import { addDays, endOfDayInTz, formatDateInTz, formatTimeInTz, fromDateKey, startOfDayInTz } from "@/lib/time";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import { can } from "@/lib/auth/rbac";
import type { NextAppointmentDTO } from "@/modules/appointments/dto";
import { createAppointment, getTenantTimezone } from "@/modules/appointments/service";
import { readReminderSettings } from "@/modules/messaging/reminder-settings";
import {
  ACTIVE_RECALL_STATUSES,
  bandLabel,
  CALL_OUTCOME_KEYS,
  callOutcomeLabel,
  CLOSED_RECALL_STATUSES,
  declineReasonLabel,
  DUE_SOON_DAYS,
  RECALL_CHANNELS,
  RECALL_KIND_LABEL,
  RECALL_KINDS,
  RECALL_OWNER_ROLES,
  RECALL_STATUS_LABEL,
  RECALL_STATUSES,
  recallBand,
  RETRY_DAYS,
  STAFF_DECLINE_REASONS,
  UNREACHABLE_AFTER_TRIES,
  urgencyRank,
  WAITING_RECALL_STATUSES,
} from "./constants";
import { closeRecall, moveRecall, syncPatientRecalls } from "./engine";
import { deliverRecallMessage, recallForMessage, renderRecallMessage } from "./messages";
import type { RecallActivityDTO, RecallDetailDTO, RecallDTO, RecallListDTO, VisitRecallDTO } from "./dto";

/**
 * The recall record and reception's worklist.
 *
 * Today's list is who to contact today: recalls due or overdue and waiting
 * for a booking, whose next try is today or earlier, plus those due within
 * two weeks that no automatic message will reach (a phone-call recall, no
 * WhatsApp number). Ordered by urgency (overdue longest first, then due,
 * then due soon), then by what the visit is worth. Each call, message,
 * snooze, decline and note is logged on the recall and audited; booking goes
 * through the appointments service (its rules: free slot, opening hours, the
 * patient's other bookings).
 */

type Client = Prisma.TransactionClient;

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
  role?: UserRole | null;
}

export class RecallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RecallError";
  }
}

const DAY_MS = 86_400_000;
const WAITING = WAITING_RECALL_STATUSES as readonly RecallStatus[];
const ACTIVE = ACTIVE_RECALL_STATUSES as readonly RecallStatus[];
const zId = zText(64).min(1);
const zDayKey = zText(10).regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date (YYYY-MM-DD)");

// ── Reading ──────────────────────────────────────────────────────────────────

const recallSelect = {
  id: true,
  kind: true,
  label: true,
  status: true,
  dueAt: true,
  windowEndAt: true,
  value: true,
  channel: true,
  ownerRole: true,
  ownerId: true,
  attempts: true,
  lastContactAt: true,
  nextContactAt: true,
  snoozedUntil: true,
  declineReason: true,
  outcomeNote: true,
  closedAt: true,
  bookedAppointmentId: true,
  procedureId: true,
  stage: true,
  createdAt: true,
  patient: { select: { id: true, fullName: true, phone: true, whatsapp: true, language: true, reminderConsent: true, marketingConsent: true } },
  treatment: { select: { id: true, name: true } },
} satisfies Prisma.RecallSelect;

type RecallRow = Prisma.RecallGetPayload<{ select: typeof recallSelect }>;

type ConsentPatient = { phone: string | null; whatsapp: string | null; reminderConsent: boolean; marketingConsent: boolean };

/** The patient agreed to this recall's message: offers and news for a lapsed patient (asking them back is marketing), treatment reminders otherwise. */
const agreed = (r: { kind: string; patient: ConsentPatient }) => (r.kind === "LAPSED" ? r.patient.marketingConsent : r.patient.reminderConsent);

/** Why no automatic message reaches it (reception contacts the patient), or null when one will. */
function noMessageReason(r: { kind: string; channel: ChannelType; patient: ConsentPatient }, autoMessages: boolean): string | null {
  if (r.channel === "VOICE") return "A phone-call recall: no automatic message goes.";
  if (!(r.patient.whatsapp || r.patient.phone)) return "No WhatsApp number: call the patient.";
  if (!agreed(r)) return r.kind === "LAPSED" ? "No consent to offers and news: call the patient." : "The patient said no to WhatsApp reminders: call.";
  if (!autoMessages) return "Automatic recall messages are off: contact the patient.";
  return null;
}

async function names(tenantId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const users = await db.user.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
}

const STATUS_STEP: Record<string, string> = { MOVED: "Due date moved", MERGED: "The same return", CONTACTED: "Contacted", SNOOZED: "Snoozed", BOOKED: "Booked", DONE: "Done", DECLINED: "Declined", UNREACHABLE: "Unreachable" };
const DELIVERY: Record<string, string> = { SENT: "Sent", DELIVERED: "Delivered", READ: "Read", QUEUED: "Queued", LOGGED: "Logged (no channel connected)", FAILED: "Not delivered" };

/** `createdAt`: the recall's, so its first line reads "Made" and a later reopening "Back on the list". */
function activityDTO(
  a: { id: string; kind: RecallActivityDTO["kind"]; outcome: string | null; note: string | null; messageId: string | null; at: Date; byId: string | null },
  who: Map<string, string>,
  createdAt: Date,
): RecallActivityDTO {
  const outcomeLabel =
    a.outcome === null
      ? null
      : a.kind === "CALL"
        ? callOutcomeLabel(a.outcome)
        : a.kind === "STATUS"
          ? a.outcome === "OPEN"
            ? a.at.getTime() <= createdAt.getTime() + 1000
              ? "Made"
              : "Back on the list"
            : (STATUS_STEP[a.outcome] ?? RECALL_STATUS_LABEL[a.outcome as RecallStatus] ?? a.outcome)
          : a.kind === "MESSAGE"
            ? (DELIVERY[a.outcome] ?? a.outcome)
            : a.outcome;
  return {
    id: a.id,
    kind: a.kind,
    outcome: a.outcome,
    outcomeLabel,
    note: a.note,
    messageId: a.messageId,
    at: a.at.toISOString(),
    by: a.byId ? { id: a.byId, name: who.get(a.byId) ?? "Former staff member" } : null,
  };
}

async function toDTOs(tenantId: string, rows: RecallRow[], now: Date, tz: string, autoMessages = true): Promise<RecallDTO[]> {
  if (!rows.length) return [];
  const today = startOfDayInTz(now, tz);
  const ids = rows.map((r) => r.id);
  const bookedIds = rows.map((r) => r.bookedAppointmentId).filter((id): id is string => Boolean(id));
  const [last, booked] = await Promise.all([
    db.recallActivity.findMany({ where: { tenantId, recallId: { in: ids } }, orderBy: [{ at: "desc" }, { id: "desc" }], distinct: ["recallId"] }),
    bookedIds.length ? db.appointment.findMany({ where: { tenantId, id: { in: bookedIds } }, select: { id: true, startsAt: true, doctorId: true } }) : [],
  ]);
  const who = await names(tenantId, [...rows.map((r) => r.ownerId), ...last.map((a) => a.byId), ...booked.map((b) => b.doctorId)]);
  const lastOf = new Map(last.map((a) => [a.recallId, a]));
  const bookedOf = new Map(booked.map((b) => [b.id, b]));
  return rows.map((r) => {
    const band = recallBand(r, today);
    const lastActivity = lastOf.get(r.id);
    const b = r.bookedAppointmentId ? bookedOf.get(r.bookedAppointmentId) : undefined;
    const reopened = r.status === "OPEN" && lastActivity?.kind === "STATUS" && lastActivity.outcome === "OPEN" && lastActivity.byId === null && lastActivity.at.getTime() > r.createdAt.getTime() + 1000 && Boolean(lastActivity.note?.match(/^(The booked visit|Came in on)/));
    const silent = noMessageReason(r, autoMessages);
    const hint = reopened ? lastActivity!.note : r.status !== "BOOKED" && (band.band === "soon" || band.band === "due" || band.band === "overdue") && silent ? silent : null;
    return {
      id: r.id,
      kind: r.kind,
      kindLabel: RECALL_KIND_LABEL[r.kind],
      label: r.label,
      status: r.status,
      statusLabel: RECALL_STATUS_LABEL[r.status],
      band: band.band,
      bandLabel: bandLabel(band),
      bandDays: band.days,
      dueAt: r.dueAt.toISOString(),
      windowEndAt: r.windowEndAt.toISOString(),
      value: r.value,
      channel: r.channel,
      ownerRole: r.ownerRole,
      owner: r.ownerId ? { id: r.ownerId, name: who.get(r.ownerId) ?? "Former staff member" } : null,
      attempts: r.attempts,
      lastContactAt: r.lastContactAt?.toISOString() ?? null,
      nextContactAt: r.nextContactAt?.toISOString() ?? null,
      snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
      declineReason: r.declineReason,
      declineLabel: r.declineReason ? declineReasonLabel(r.declineReason) : null,
      outcomeNote: r.outcomeNote,
      closedAt: r.closedAt?.toISOString() ?? null,
      booked: r.status === "BOOKED" && r.bookedAppointmentId && b ? { appointmentId: b.id, startsAt: b.startsAt.toISOString(), doctorName: b.doctorId ? (who.get(b.doctorId) ?? null) : null } : null,
      patient: r.patient,
      treatment: r.treatment,
      procedureId: r.procedureId,
      stage: r.stage,
      lastActivity: lastActivity ? activityDTO(lastActivity, who, r.createdAt) : null,
      hint,
      canMessage: Boolean(r.patient.whatsapp || r.patient.phone) && agreed(r),
      suggestUnreachable: r.attempts >= UNREACHABLE_AFTER_TRIES && WAITING.includes(r.status) && lastActivity?.kind === "CALL" && lastActivity.outcome === "no_answer",
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export const RecallListQuery = z.object({
  tab: z.enum(["today", "soon", "booked", "all"]).default("today"),
  /** For the "all" tab: one status, everything still being worked, or everything closed. */
  status: z.enum([...RECALL_STATUSES, "active", "closed"]).optional(),
  kind: z.enum(RECALL_KINDS).optional(),
  owner: z.enum(["mine", "all"]).default("all"),
  q: zOptionalText(80),
  patientId: zOptionalText(64),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type RecallListQuery = z.input<typeof RecallListQuery>;

interface Viewer {
  userId?: string | null;
  role?: UserRole | null;
}

function baseWhere(tenantId: string, q: z.infer<typeof RecallListQuery>, viewer: Viewer): Prisma.RecallWhereInput {
  const and: Prisma.RecallWhereInput[] = [{ tenantId, patient: { deletedAt: null } }];
  if (q.kind) and.push({ kind: q.kind });
  if (q.patientId) and.push({ patientId: q.patientId });
  if (q.owner === "mine" && viewer.userId) {
    and.push({ OR: [{ ownerId: viewer.userId }, ...(viewer.role ? [{ ownerId: null, ownerRole: viewer.role }] : [])] });
  }
  if (q.q) {
    const digits = q.q.replace(/\D/g, "");
    and.push({
      OR: [
        { patient: { fullName: { contains: q.q, mode: "insensitive" } } },
        { label: { contains: q.q, mode: "insensitive" } },
        ...(digits.length >= 4 ? [{ patient: { phone: { contains: digits } } }, { patient: { whatsapp: { contains: digits } } }] : []),
      ],
    });
  }
  return { AND: and };
}

/** Who to contact today (see the top of the file); `autoMessages`: the clinic's recall messages are on. */
function todayWhere(now: Date, tz: string, autoMessages: boolean): Prisma.RecallWhereInput {
  const endToday = endOfDayInTz(now, tz);
  const soonEnd = endOfDayInTz(addDays(now, DUE_SOON_DAYS, tz), tz);
  // Due within two weeks and no automatic message will reach it: the desk's to contact now.
  const silent: Prisma.RecallWhereInput = autoMessages
    ? {
        OR: [
          { channel: "VOICE" },
          { patient: { phone: null, whatsapp: null } },
          { kind: { not: "LAPSED" }, patient: { reminderConsent: false } },
          { kind: "LAPSED", patient: { marketingConsent: false } },
        ],
      }
    : {};
  return {
    AND: [
      { OR: [{ status: { in: ["OPEN", "CONTACTED"] } }, { status: "SNOOZED", snoozedUntil: { lte: endToday } }] },
      { OR: [{ nextContactAt: null }, { nextContactAt: { lte: endToday } }] },
      { OR: [{ dueAt: { lte: endToday } }, { AND: [{ dueAt: { lte: soonEnd } }, silent] }] },
    ],
  };
}

function soonWhere(now: Date, tz: string): Prisma.RecallWhereInput {
  return { status: { in: [...WAITING] }, dueAt: { gt: endOfDayInTz(now, tz), lte: endOfDayInTz(addDays(now, DUE_SOON_DAYS, tz), tz) } };
}

const LIST_CAP = 1000;

export async function listRecalls(tenantId: string, raw: RecallListQuery, viewer: Viewer = {}, now: Date = new Date()): Promise<RecallListDTO> {
  const q = RecallListQuery.parse(raw);
  const [tz, settings] = await Promise.all([getTenantTimezone(tenantId), readReminderSettings(tenantId)]);
  const base = baseWhere(tenantId, q, viewer);
  const today = todayWhere(now, tz, settings.recallMessages);
  const soon = soonWhere(now, tz);
  const booked: Prisma.RecallWhereInput = { status: "BOOKED" };
  const [countToday, countSoon, countBooked] = await Promise.all([
    db.recall.count({ where: { AND: [base, today] } }),
    db.recall.count({ where: { AND: [base, soon] } }),
    db.recall.count({ where: { AND: [base, booked] } }),
  ]);
  const counts = { today: countToday, soon: countSoon, booked: countBooked };
  const skip = (q.page - 1) * q.pageSize;

  if (q.tab === "all") {
    const status: Prisma.RecallWhereInput =
      q.status === "active" ? { status: { in: [...ACTIVE] } } : q.status === "closed" ? { status: { in: [...CLOSED_RECALL_STATUSES] } } : q.status ? { status: q.status } : {};
    const where = { AND: [base, status] };
    const [total, rows] = await Promise.all([
      db.recall.count({ where }),
      db.recall.findMany({ where, orderBy: [{ dueAt: "desc" }, { id: "asc" }], skip, take: q.pageSize, select: recallSelect }),
    ]);
    return { recalls: await toDTOs(tenantId, rows, now, tz, settings.recallMessages), total, page: q.page, pageSize: q.pageSize, counts };
  }

  const where = { AND: [base, q.tab === "today" ? today : q.tab === "soon" ? soon : booked] };
  const rows = await db.recall.findMany({ where, orderBy: [{ dueAt: "asc" }, { id: "asc" }], take: LIST_CAP, select: recallSelect });
  const all = await toDTOs(tenantId, rows, now, tz, settings.recallMessages);
  if (q.tab === "booked") {
    all.sort((a, b) => (a.booked?.startsAt ?? a.dueAt).localeCompare(b.booked?.startsAt ?? b.dueAt));
  } else {
    const rank = (r: RecallDTO) => urgencyRank({ band: r.band, days: r.bandDays });
    all.sort((a, b) => rank(b) - rank(a) || b.value - a.value || a.dueAt.localeCompare(b.dueAt));
  }
  return { recalls: all.slice(skip, skip + q.pageSize), total: all.length, page: q.page, pageSize: q.pageSize, counts };
}

export async function getRecall(tenantId: string, id: string, now: Date = new Date()): Promise<RecallDetailDTO | null> {
  const row = await db.recall.findFirst({ where: { id, tenantId }, select: recallSelect });
  if (!row) return null;
  const [tz, settings] = await Promise.all([getTenantTimezone(tenantId), readReminderSettings(tenantId)]);
  const [dto] = await toDTOs(tenantId, [row], now, tz, settings.recallMessages);
  const activities = await db.recallActivity.findMany({ where: { tenantId, recallId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
  const who = await names(tenantId, activities.map((a) => a.byId));
  return { ...dto!, activities: activities.map((a) => activityDTO(a, who, row.createdAt)) };
}

/**
 * The recalls to see with a visit: the ones it is booked for, then the
 * patient's others due by two weeks after it (to do at the same visit, or
 * book for the same day).
 */
export async function visitRecalls(tenantId: string, visit: { id: string; patientId: string; startsAt: string | Date }, tz: string, now: Date = new Date()): Promise<VisitRecallDTO[]> {
  const startsAt = new Date(visit.startsAt);
  const rows = await db.recall.findMany({
    where: {
      tenantId,
      patientId: visit.patientId,
      OR: [{ status: "BOOKED", bookedAppointmentId: visit.id }, { status: { in: [...WAITING] }, dueAt: { lte: endOfDayInTz(addDays(startsAt, DUE_SOON_DAYS, tz), tz) } }],
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: 6,
    select: { id: true, kind: true, label: true, dueAt: true, windowEndAt: true, status: true, bookedAppointmentId: true },
  });
  const today = startOfDayInTz(now, tz);
  return rows
    .map((r) => {
      const band = recallBand(r, today);
      return { id: r.id, label: r.label, kindLabel: RECALL_KIND_LABEL[r.kind], dueAt: r.dueAt.toISOString(), band: band.band, bandLabel: bandLabel(band), thisVisit: r.bookedAppointmentId === visit.id };
    })
    .sort((a, b) => Number(b.thisVisit) - Number(a.thisVisit));
}

/** The next-appointment card's answer with the recalls of its visit, for the roles that read recalls. */
export async function nextWithRecalls(tenantId: string, role: UserRole, next: NextAppointmentDTO, now: Date = new Date()): Promise<NextAppointmentDTO> {
  if (!next.appointment || !can(role, "recalls:read")) return next;
  return { ...next, recalls: await visitRecalls(tenantId, next.appointment, next.timezone, now) };
}

/** A patient's recalls for their page: everything still being worked (the upcoming too), then the last closed. */
export async function listPatientRecalls(tenantId: string, patientId: string, now: Date = new Date()): Promise<{ active: RecallDTO[]; closed: RecallDTO[] }> {
  const [tz, settings] = await Promise.all([getTenantTimezone(tenantId), readReminderSettings(tenantId)]);
  const [active, closed] = await Promise.all([
    db.recall.findMany({ where: { tenantId, patientId, status: { in: [...ACTIVE] } }, orderBy: { dueAt: "asc" }, take: 50, select: recallSelect }),
    db.recall.findMany({ where: { tenantId, patientId, status: { in: [...CLOSED_RECALL_STATUSES] } }, orderBy: { closedAt: "desc" }, take: 5, select: recallSelect }),
  ]);
  const [a, c] = await Promise.all([toDTOs(tenantId, active, now, tz, settings.recallMessages), toDTOs(tenantId, closed, now, tz, settings.recallMessages)]);
  return { active: a, closed: c };
}

// ── Working a recall ─────────────────────────────────────────────────────────

export const RecallActionInput = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("call"),
      outcome: z.enum(CALL_OUTCOME_KEYS),
      note: zOptionalText(1000),
      /** call_back: the day the patient asked to be called. */
      callBackOn: zDayKey.optional(),
      /** declined: why. */
      reason: z.enum(STAFF_DECLINE_REASONS).optional(),
    }),
    z.object({ action: z.literal("message") }),
    z.object({ action: z.literal("snooze"), until: zDayKey, note: zOptionalText(500) }),
    z.object({ action: z.literal("decline"), reason: z.enum(STAFF_DECLINE_REASONS), note: zOptionalText(500) }),
    z.object({ action: z.literal("unreachable"), note: zOptionalText(500) }),
    z.object({ action: z.literal("reopen"), note: zOptionalText(500) }),
    z.object({ action: z.literal("note"), note: zText(1000).min(1, "Write the note") }),
  ])
  .superRefine((v, ctx) => {
    if (v.action === "call" && v.outcome === "call_back" && !v.callBackOn) ctx.addIssue({ code: "custom", path: ["callBackOn"], message: "The day to call back" });
    if (v.action === "call" && v.outcome === "declined" && !v.reason) ctx.addIssue({ code: "custom", path: ["reason"], message: "Why they declined" });
    const reason = v.action === "decline" || v.action === "call" ? v.reason : undefined;
    const note = "note" in v ? v.note : undefined;
    if (reason === "other" && !note) ctx.addIssue({ code: "custom", path: ["note"], message: "Say what the reason is" });
  });
export type RecallActionInput = z.input<typeof RecallActionInput>;

function issue(path: string, message: string): z.ZodError {
  return new z.ZodError([{ code: "custom", path: [path], message }]);
}

/** A day the patient named, on the clinic clock: from today (or tomorrow) up to a year ahead. */
function dayAhead(key: string, tz: string, now: Date, path: string, opts: { fromTomorrow?: boolean } = {}): Date {
  const start = fromDateKey(key, tz);
  if (!start) throw issue(path, "Not a real date");
  const today = startOfDayInTz(now, tz);
  if (start.getTime() < today.getTime() + (opts.fromTomorrow ? DAY_MS - 2 * 3_600_000 : 0)) throw issue(path, opts.fromTomorrow ? "From tomorrow on" : "Today or later");
  if (start.getTime() > today.getTime() + 366 * DAY_MS) throw issue(path, "Within a year");
  return start;
}

async function requireRecall(tenantId: string, id: string, client: Client = db) {
  const r = await client.recall.findFirst({ where: { id, tenantId }, select: { id: true, status: true, patientId: true, kind: true, label: true, attempts: true, bookedAppointmentId: true, dueAt: true, appointmentId: true } });
  if (!r) throw new TenantScopeError("recall", id);
  return r;
}

const stateChanged = () => new RecallError(409, "state_changed", "This recall changed a moment ago: reload it and try again.");

/** Log one staff contact and move the recall where it leads, in one transaction. */
async function logContact(
  tenantId: string,
  id: string,
  from: readonly RecallStatus[],
  activity: { kind: "CALL" | "MESSAGE"; outcome: string; note: string | null; messageId?: string | null },
  data: Prisma.RecallUncheckedUpdateManyInput,
  actor: Actor,
  now: Date,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const changed = await tx.recall.updateMany({ where: { id, tenantId, status: { in: [...from] } }, data });
    if (!changed.count) throw stateChanged();
    await tx.recallActivity.create({ data: { tenantId, recallId: id, kind: activity.kind, outcome: activity.outcome, note: activity.note, messageId: activity.messageId ?? null, byId: actor.id ?? null, at: now } });
  });
}

export interface ActionResult {
  recall: RecallDetailDTO;
  /** A message the patient was sent: how it went. */
  message?: { delivery: string; failedReason: string | null; conversationId: string };
}

export async function actOnRecall(tenantId: string, id: string, raw: unknown, actor: Actor = {}, now: Date = new Date()): Promise<ActionResult> {
  const input = RecallActionInput.parse(raw);
  const r = await requireRecall(tenantId, id);
  const tz = await getTenantTimezone(tenantId);
  const closed = (CLOSED_RECALL_STATUSES as readonly RecallStatus[]).includes(r.status);
  const at = (days: number) => startOfDayInTz(addDays(now, days, tz), tz);
  const contacted = { attempts: { increment: 1 }, lastContactAt: now, snoozedUntil: null } as const;
  let message: ActionResult["message"];

  if (closed && input.action !== "reopen" && input.action !== "note") {
    throw new RecallError(409, "closed", `This recall is closed (${RECALL_STATUS_LABEL[r.status].toLowerCase()}): reopen it first.`);
  }

  switch (input.action) {
    case "call": {
      const note = input.note ?? null;
      if (r.status === "BOOKED") {
        if (input.outcome === "declined" || input.outcome === "wrong_number") {
          throw new RecallError(409, "booked", "A visit is booked for this recall: cancel the visit first.");
        }
        await logContact(tenantId, id, ["BOOKED"], { kind: "CALL", outcome: input.outcome, note }, { attempts: { increment: 1 }, lastContactAt: now }, actor, now);
        break;
      }
      if (input.outcome === "declined") {
        await db.$transaction(async (tx) => {
          await tx.recallActivity.create({ data: { tenantId, recallId: id, kind: "CALL", outcome: "declined", note, byId: actor.id ?? null, at: now } });
          const ok = await tx.recall.updateMany({
            where: { id, tenantId, status: { in: [...WAITING] } },
            data: { ...contacted, status: "DECLINED", declineReason: input.reason!, outcomeNote: note, closedAt: now, closedById: actor.id ?? null, nextContactAt: null },
          });
          if (!ok.count) throw stateChanged();
        });
      } else if (input.outcome === "wrong_number") {
        await db.$transaction(async (tx) => {
          await tx.recallActivity.create({ data: { tenantId, recallId: id, kind: "CALL", outcome: "wrong_number", note, byId: actor.id ?? null, at: now } });
          const ok = await tx.recall.updateMany({
            where: { id, tenantId, status: { in: [...WAITING] } },
            data: { ...contacted, status: "UNREACHABLE", outcomeNote: note ?? "Wrong number", closedAt: now, closedById: actor.id ?? null, nextContactAt: null },
          });
          if (!ok.count) throw stateChanged();
        });
      } else {
        const next = input.outcome === "call_back" ? dayAhead(input.callBackOn!, tz, now, "callBackOn") : at(RETRY_DAYS[input.outcome] ?? 2);
        await logContact(tenantId, id, WAITING, { kind: "CALL", outcome: input.outcome, note }, { ...contacted, status: "CONTACTED", nextContactAt: next }, actor, now);
      }
      break;
    }
    case "message": {
      if (r.status === "BOOKED") throw new RecallError(409, "booked", "A visit is booked for this recall: nothing to ask the patient.");
      const loaded = await recallForMessage(tenantId, id);
      if (!loaded || !(loaded.patient.whatsapp || loaded.patient.phone)) throw new RecallError(422, "no_phone", "The patient has no WhatsApp number or phone on record.");
      if (!(loaded.kind === "LAPSED" ? loaded.patient.marketingConsent : loaded.patient.reminderConsent)) {
        throw new RecallError(409, "no_consent", loaded.kind === "LAPSED" ? "The patient has not agreed to offers and news on WhatsApp: call instead." : "The patient said no to WhatsApp reminders: call instead.");
      }
      const rendered = await renderRecallMessage(tenantId, loaded, { timezone: tz, now });
      if (!rendered.body || rendered.unfilled.length) {
        throw new RecallError(409, "template_incomplete", `The clinic's "${rendered.templateKey}" template uses ${rendered.unfilled.map((p) => `{{${p}}}`).join(", ") || "nothing"} that a recall cannot fill: edit it in Settings.`);
      }
      const sent = await deliverRecallMessage(tenantId, loaded, rendered, { authorId: actor.id ?? null });
      const failedReason = sent.delivery === "FAILED" ? ((await db.message.findFirst({ where: { id: sent.messageId, tenantId }, select: { failedReason: true } }))?.failedReason ?? "delivery failed") : null;
      if (sent.delivery === "FAILED") {
        await db.recallActivity.create({ data: { tenantId, recallId: id, kind: "MESSAGE", outcome: "FAILED", note: failedReason, messageId: sent.messageId, byId: actor.id ?? null, at: now } });
      } else {
        await logContact(tenantId, id, WAITING, { kind: "MESSAGE", outcome: sent.delivery, note: sent.body.slice(0, 1000), messageId: sent.messageId }, { ...contacted, status: "CONTACTED", nextContactAt: at(RETRY_DAYS.message ?? 3) }, actor, now);
      }
      message = { delivery: sent.delivery, failedReason, conversationId: sent.conversationId };
      break;
    }
    case "snooze": {
      if (r.status === "BOOKED") throw new RecallError(409, "booked", "A visit is booked for this recall.");
      const until = dayAhead(input.until, tz, now, "until", { fromTomorrow: true });
      const ok = await moveRecall(tenantId, id, {
        from: WAITING,
        data: { status: "SNOOZED", snoozedUntil: until, nextContactAt: until },
        outcome: "SNOOZED",
        note: `Until ${formatDateInTz(until, tz, { weekday: "short", day: "numeric", month: "short" })}${input.note ? `: ${input.note}` : ""}`,
        at: now,
        byId: actor.id ?? null,
      });
      if (!ok) throw stateChanged();
      break;
    }
    case "decline": {
      if (r.status === "BOOKED") throw new RecallError(409, "booked", "A visit is booked for this recall: cancel the visit first.");
      const ok = await closeRecall(tenantId, id, { status: "DECLINED", reason: input.reason, outcomeNote: input.note ?? null, note: `${declineReasonLabel(input.reason)}${input.note ? `: ${input.note}` : ""}`, at: now, byId: actor.id ?? null });
      if (!ok) throw stateChanged();
      break;
    }
    case "unreachable": {
      if (r.status === "BOOKED") throw new RecallError(409, "booked", "A visit is booked for this recall.");
      const ok = await closeRecall(tenantId, id, { status: "UNREACHABLE", outcomeNote: input.note ?? null, note: input.note ?? `Not reached after ${r.attempts} tr${r.attempts === 1 ? "y" : "ies"}.`, at: now, byId: actor.id ?? null });
      if (!ok) throw stateChanged();
      break;
    }
    case "reopen": {
      if (r.status === "DONE") throw new RecallError(409, "done", "A done recall stays done: add a new one if the patient is due again.");
      if (!["SNOOZED", "DECLINED", "UNREACHABLE"].includes(r.status)) throw new RecallError(409, "not_closed", "This recall is already open.");
      const ok = await moveRecall(tenantId, id, {
        from: ["SNOOZED", "DECLINED", "UNREACHABLE"],
        data: { status: "OPEN", snoozedUntil: null, closedAt: null, closedById: null, declineReason: null, nextContactAt: now },
        outcome: "OPEN",
        note: input.note ? `Reopened: ${input.note}` : "Reopened.",
        at: now,
        byId: actor.id ?? null,
      });
      if (!ok) throw stateChanged();
      break;
    }
    case "note": {
      await db.recallActivity.create({ data: { tenantId, recallId: id, kind: "NOTE", note: input.note, byId: actor.id ?? null, at: now } });
      break;
    }
  }

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: `recall.${input.action}`,
    entity: "Recall",
    entityId: id,
    patientId: r.patientId,
    before: { status: r.status },
    after: { ...input, ...(message ? { delivery: message.delivery } : {}) } as Prisma.InputJsonObject,
  });
  return { recall: (await getRecall(tenantId, id, now))!, ...(message ? { message } : {}) };
}

// ── Booking ──────────────────────────────────────────────────────────────────

export const RecallBookInput = z.object({
  doctorId: zId,
  startsAt: zDateTime,
  endsAt: zDateTime,
  clinicId: zOptionalText(64),
  room: zOptionalText(60),
  reason: zOptionalText(300),
});

const VISIT_KIND: Record<string, AppointmentKind> = { REVIEW: "FOLLOW_UP", NEXT_SESSION: "PROCEDURE", UNBOOKED: "PROCEDURE", LAPSED: "CHECK_UP" };

/** The kind of visit a recall books: a review is a follow-up, a session or plan a procedure, a lapse a check-up, a missed visit what was missed. */
export async function visitKindFor(tenantId: string, r: { kind: string; appointmentId: string | null }): Promise<AppointmentKind> {
  if (r.kind === "MISSED" && r.appointmentId) {
    const missed = await db.appointment.findFirst({ where: { id: r.appointmentId, tenantId }, select: { kind: true } });
    if (missed) return missed.kind;
  }
  return VISIT_KIND[r.kind] ?? "FOLLOW_UP";
}

/**
 * Book the recall straight into a slot (the appointments service checks the
 * slot is free, inside the opening hours and not on top of the patient's own
 * bookings), and mark it booked by whoever booked it. The visit serves any
 * other recall of the patient due by then too.
 */
export async function bookRecall(tenantId: string, id: string, raw: unknown, actor: Actor = {}, now: Date = new Date()) {
  const input = RecallBookInput.parse(raw);
  const r = await requireRecall(tenantId, id);
  if (r.status === "BOOKED") throw new RecallError(409, "already_booked", "A visit is already booked for this recall.");
  if (!WAITING.includes(r.status)) throw new RecallError(409, "closed", `This recall is closed (${RECALL_STATUS_LABEL[r.status].toLowerCase()}): reopen it first.`);
  const lastContact = await db.recallActivity.findFirst({ where: { tenantId, recallId: id, kind: { in: ["CALL", "MESSAGE"] } }, orderBy: { at: "desc" }, select: { kind: true } });
  const { appointment } = await createAppointment(
    tenantId,
    {
      patientId: r.patientId,
      doctorId: input.doctorId,
      clinicId: input.clinicId,
      room: input.room,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
      kind: await visitKindFor(tenantId, r),
      reason: input.reason ?? r.label,
      source: lastContact?.kind === "MESSAGE" ? "WHATSAPP" : lastContact?.kind === "CALL" ? "VOICE" : "IN_PERSON",
    },
    actor,
  );
  const tz = await getTenantTimezone(tenantId);
  const when = `${formatDateInTz(appointment.startsAt, tz, { weekday: "short", day: "numeric", month: "short" })} ${formatTimeInTz(appointment.startsAt, tz)}`;
  const current = await db.recall.findFirst({ where: { id, tenantId }, select: { status: true, bookedAppointmentId: true } });
  if (!(current?.status === "BOOKED" && current.bookedAppointmentId === appointment.id)) {
    await moveRecall(tenantId, id, {
      from: WAITING,
      data: { status: "BOOKED", bookedAppointmentId: appointment.id, bookedAt: now, bookedById: actor.id ?? null, nextContactAt: null, snoozedUntil: null },
      outcome: "BOOKED",
      note: `Booked for ${when}${appointment.doctor?.fullName ? ` with ${appointment.doctor.fullName}` : ""}.`,
      at: now,
      byId: actor.id ?? null,
    });
  }
  await syncPatientRecalls(tenantId, r.patientId, now, tz);
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "recall.book",
    entity: "Recall",
    entityId: id,
    patientId: r.patientId,
    before: { status: r.status },
    after: { status: "BOOKED", appointmentId: appointment.id, startsAt: appointment.startsAt.toISOString() },
  });
  return { recall: (await getRecall(tenantId, id, now))!, appointment };
}

// ── Adding one by hand ───────────────────────────────────────────────────────

export const ManualRecallInput = z.object({
  patientId: zId,
  label: zText(200).min(2, "Say what the patient is due for"),
  dueOn: zDayKey,
  windowDays: z.coerce.number().int().min(0).max(90).default(7),
  ownerRole: z.enum(RECALL_OWNER_ROLES).default("RECEPTIONIST"),
  channel: z.enum(RECALL_CHANNELS).default("WHATSAPP"),
  note: zOptionalText(500),
});

/** A review someone asked for that no rule makes ("see her again after the exams"). */
export async function addRecall(tenantId: string, raw: unknown, actor: Actor = {}, now: Date = new Date()): Promise<RecallDetailDTO> {
  const input = ManualRecallInput.parse(raw);
  await requireTenantPatient(tenantId, input.patientId);
  const tz = await getTenantTimezone(tenantId);
  const dueAt = dayAhead(input.dueOn, tz, now, "dueOn");
  const who = actor.id ? (await names(tenantId, [actor.id])).get(actor.id) : null;
  const id = await db.$transaction(async (tx) => {
    const recall = await tx.recall.create({
      data: {
        tenantId,
        patientId: input.patientId,
        kind: "REVIEW",
        label: input.label,
        dueAt,
        windowEndAt: endOfDayInTz(addDays(dueAt, input.windowDays, tz), tz),
        ownerRole: input.ownerRole,
        channel: input.channel,
        dedupeKey: `manual:${randomUUID()}`,
        createdById: actor.id ?? null,
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.recallActivity.create({ data: { tenantId, recallId: recall.id, kind: "STATUS", outcome: "OPEN", note: `Added${who ? ` by ${who}` : ""}${input.note ? `: ${input.note}` : "."}`, byId: actor.id ?? null, at: now } });
    return recall.id;
  });
  await syncPatientRecalls(tenantId, input.patientId, now, tz);
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "recall.create", entity: "Recall", entityId: id, patientId: input.patientId, after: input });
  return (await getRecall(tenantId, id, now))!;
}

