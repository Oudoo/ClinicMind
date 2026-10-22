import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ingestInBackground } from "@/modules/knowledge/ingest";
import { isValidTimeZone } from "@/lib/time";
import { requireTenantClinic, requireTenantPatient, requireTenantUser } from "@/lib/tenant-scope";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import {
  APPOINTMENT_STATUSES,
  canTransition,
  isReschedulable,
  MAX_DURATION_MINUTES,
  MAX_REASON_LENGTH,
  MIN_DURATION_MINUTES,
  NON_BLOCKING_STATUSES,
  type AppointmentStatus,
} from "./transitions";

/**
 * Appointment lifecycle: booking with conflict detection, rescheduling and
 * status transitions. Every query is tenant-scoped, every foreign key a
 * request supplies is proven to belong to the tenant (SEC-4), and every
 * mutation is audited.
 *
 * Double-booking protection: the conflict check and the write run inside one
 * transaction that first takes a Postgres advisory lock per doctor and per
 * room, so two concurrent bookings of the same slot are serialised and the
 * second one sees the first.
 */

type Client = Prisma.TransactionClient;

export const DEFAULT_TIMEZONE = "Africa/Cairo";

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

// ── Errors (mapped to HTTP by the route layer) ───────────────────────────────

export class AppointmentNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
  constructor(readonly id: string) {
    super(`appointment ${id} not found in tenant`);
    this.name = "AppointmentNotFoundError";
  }
}

/** The requested slot overlaps existing bookings of the same doctor or room. */
export class AppointmentConflictError extends Error {
  readonly status = 409;
  readonly code = "conflict";
  constructor(readonly conflicts: AppointmentConflict[]) {
    super("The slot conflicts with existing appointments");
    this.name = "AppointmentConflictError";
  }
}

export class InvalidTransitionError extends Error {
  readonly status = 409;
  readonly code = "invalid_transition";
  constructor(
    readonly from: AppointmentStatus,
    readonly to: AppointmentStatus,
  ) {
    super(`cannot move an appointment from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/** The slot of an appointment in this status can no longer be changed. */
export class AppointmentNotReschedulableError extends Error {
  readonly status = 409;
  readonly code = "not_reschedulable";
  constructor(readonly appointmentStatus: AppointmentStatus) {
    super(`a ${appointmentStatus} appointment cannot be rescheduled`);
    this.name = "AppointmentNotReschedulableError";
  }
}

// ── Clinic timezone ──────────────────────────────────────────────────────────

/**
 * The zone the tenant's clocks run on. A tenant may own several clinics; the
 * first non-deleted one wins for now. Falls back to Cairo when the stored
 * value is missing or unknown to this runtime.
 */
export async function getTenantTimezone(tenantId: string): Promise<string> {
  const clinic = await db.clinic.findFirst({
    where: { tenantId, ...notDeleted },
    orderBy: { createdAt: "asc" },
    select: { timezone: true },
  });
  const tz = clinic?.timezone;
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

// ── Staff (doctor pickers) ───────────────────────────────────────────────────

export const BOOKABLE_ROLES = ["DOCTOR", "NURSE", "CLINIC_OWNER"] as const;
export const zBookableRole = z.enum(BOOKABLE_ROLES);
export type BookableRole = z.infer<typeof zBookableRole>;

export interface StaffSummary {
  id: string;
  fullName: string;
  role: BookableRole;
}

/** Active, non-deleted staff an appointment can be booked with. */
export async function listStaff(tenantId: string, role?: BookableRole): Promise<StaffSummary[]> {
  const users = await db.user.findMany({
    where: {
      tenantId,
      ...notDeleted,
      status: "ACTIVE",
      role: role ?? { in: [...BOOKABLE_ROLES] },
    },
    orderBy: [{ fullName: "asc" }, { email: "asc" }],
    take: 200,
    select: { id: true, fullName: true, email: true, role: true },
  });
  return users.map((u) => ({
    id: u.id,
    fullName: u.fullName ?? u.email,
    role: u.role as BookableRole,
  }));
}

// ── Validation ───────────────────────────────────────────────────────────────

export const zAppointmentStatus = z.enum(APPOINTMENT_STATUSES);

const zId = zText(64).min(1);
const zSource = z.enum(["WHATSAPP", "VOICE", "SMS", "WEB_CHAT", "IN_PERSON"]);

/** Optional text where a blank string means "clear" (null) and absence means "keep". */
const zClearableText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    zText(max).nullable().optional(),
  );

function checkDuration(startsAt: Date, endsAt: Date, ctx: z.RefinementCtx): void {
  if (endsAt.getTime() <= startsAt.getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "End must be after start" });
    return;
  }
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endsAt"],
      message: `Duration must be between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES} minutes`,
    });
  }
}

export const AppointmentInput = z
  .object({
    patientId: zId,
    doctorId: zOptionalText(64),
    clinicId: zOptionalText(64),
    room: zOptionalText(60),
    startsAt: zDateTime,
    endsAt: zDateTime,
    reason: zOptionalText(MAX_REASON_LENGTH),
    notes: zOptionalText(2000),
    source: zSource.default("IN_PERSON"),
    /** When the slot is taken, book onto the waitlist instead of failing with 409. */
    allowWaitlist: z.boolean().default(false),
  })
  .superRefine((v, ctx) => checkDuration(v.startsAt, v.endsAt, ctx));
export type AppointmentInput = z.infer<typeof AppointmentInput>;

/** PATCH body: a reschedule (times, doctor, room) and/or a notes edit. */
export const AppointmentUpdateInput = z
  .object({
    startsAt: zDateTime.optional(),
    endsAt: zDateTime.optional(),
    doctorId: zClearableText(64),
    room: zClearableText(60),
    reason: zClearableText(MAX_REASON_LENGTH),
    notes: zClearableText(2000),
    allowWaitlist: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if ((v.startsAt === undefined) !== (v.endsAt === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [v.startsAt === undefined ? "startsAt" : "endsAt"],
        message: "startsAt and endsAt must be given together",
      });
      return;
    }
    if (v.startsAt && v.endsAt) checkDuration(v.startsAt, v.endsAt, ctx);
  });
export type AppointmentUpdateInput = z.infer<typeof AppointmentUpdateInput>;

export const AppointmentTransitionInput = z
  .object({
    status: zAppointmentStatus,
    reason: zOptionalText(MAX_REASON_LENGTH),
  })
  .superRefine((v, ctx) => {
    if (v.status === "CANCELLED" && !v.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "A reason is required to cancel" });
    }
  });
export type AppointmentTransitionInput = z.infer<typeof AppointmentTransitionInput>;

const MAX_LIST_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

/** Query string of GET /api/appointments; `from`/`to` default to the coming week. */
export const AppointmentListQuery = z
  .object({
    from: zDateTime.optional(),
    to: zDateTime.optional(),
    doctorId: zOptionalText(64),
    status: zAppointmentStatus.optional(),
    patientId: zOptionalText(64),
  })
  .transform((q) => {
    const from = q.from ?? new Date();
    const to = q.to ?? new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { ...q, from, to };
  })
  .superRefine((q, ctx) => {
    if (q.to.getTime() < q.from.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must not be before from" });
    } else if (q.to.getTime() - q.from.getTime() > MAX_LIST_RANGE_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Range must not exceed one year" });
    }
  });
export type AppointmentListFilter = z.infer<typeof AppointmentListQuery>;

// ── Shapes ───────────────────────────────────────────────────────────────────

const patientSelect = { select: { id: true, fullName: true } } as const;

export interface DoctorSummary {
  id: string;
  fullName: string;
}

export interface AppointmentConflict {
  id: string;
  startsAt: Date;
  endsAt: Date;
  doctorId: string | null;
  room: string | null;
  status: AppointmentStatus;
  patient: { id: string; fullName: string };
  doctor: DoctorSummary | null;
}

/**
 * `doctorId` is a plain column (no relation), so doctors are fetched in one
 * extra query and attached. Archived or disabled staff still resolve, so past
 * appointments keep their doctor's name.
 */
async function attachDoctors<T extends { doctorId: string | null }>(
  tenantId: string,
  rows: T[],
  client: Client = db,
): Promise<(T & { doctor: DoctorSummary | null })[]> {
  const ids = [...new Set(rows.map((r) => r.doctorId).filter((id): id is string => Boolean(id)))];
  const doctors = ids.length
    ? await client.user.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const byId = new Map(doctors.map((d) => [d.id, { id: d.id, fullName: d.fullName ?? d.email }]));
  return rows.map((r) => ({ ...r, doctor: r.doctorId ? (byId.get(r.doctorId) ?? null) : null }));
}

async function attachDoctor<T extends { doctorId: string | null }>(
  tenantId: string,
  row: T,
  client: Client = db,
): Promise<T & { doctor: DoctorSummary | null }> {
  const [withDoctor] = await attachDoctors(tenantId, [row], client);
  return withDoctor ?? { ...row, doctor: null };
}

export type AppointmentWithRelations = Awaited<ReturnType<typeof listAppointments>>[number];

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listAppointments(tenantId: string, filter: AppointmentListFilter) {
  const rows = await db.appointment.findMany({
    where: {
      tenantId,
      ...notDeleted,
      startsAt: { gte: filter.from, lte: filter.to },
      ...(filter.doctorId ? { doctorId: filter.doctorId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.patientId ? { patientId: filter.patientId } : {}),
    },
    orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
    take: 500,
    include: { patient: patientSelect },
  });
  return attachDoctors(tenantId, rows);
}

export async function getAppointment(tenantId: string, id: string) {
  const row = await db.appointment.findFirst({
    where: { id, tenantId, ...notDeleted },
    include: { patient: patientSelect },
  });
  return row ? attachDoctor(tenantId, row) : null;
}

// ── Conflicts & locking ──────────────────────────────────────────────────────

/**
 * Overlapping appointments of the same doctor or in the same room. Cancelled,
 * no-show and waitlisted bookings do not hold their slot.
 */
export async function findConflicts(
  tenantId: string,
  input: {
    doctorId?: string | null;
    room?: string | null;
    startsAt: Date;
    endsAt: Date;
    excludeId?: string;
  },
  client: Client = db,
): Promise<AppointmentConflict[]> {
  if (!input.doctorId && !input.room) return [];
  const rows = await client.appointment.findMany({
    where: {
      tenantId,
      ...notDeleted,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      status: { notIn: [...NON_BLOCKING_STATUSES] },
      startsAt: { lt: input.endsAt },
      endsAt: { gt: input.startsAt },
      OR: [
        ...(input.doctorId ? [{ doctorId: input.doctorId }] : []),
        ...(input.room ? [{ room: input.room }] : []),
      ],
    },
    orderBy: { startsAt: "asc" },
    take: 20,
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      doctorId: true,
      room: true,
      status: true,
      patient: patientSelect,
    },
  });
  return attachDoctors(tenantId, rows, client);
}

/**
 * Serialise concurrent writes against the same doctor / room for the rest of
 * the transaction (keys are sorted so two writers never deadlock).
 */
async function lockSlots(tx: Client, tenantId: string, doctorId?: string | null, room?: string | null): Promise<void> {
  const keys = [doctorId ? `doctor:${doctorId}` : null, room ? `room:${room}` : null]
    .filter((k): k is string => Boolean(k))
    .sort();
  for (const key of keys) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${key}`}))`;
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createAppointment(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = AppointmentInput.parse(rawInput);

  // Every client-supplied foreign key must belong to the acting tenant (SEC-4);
  // otherwise a booking (and its timeline event) could land on another
  // tenant's patient, doctor or clinic.
  await requireTenantPatient(tenantId, input.patientId);
  if (input.doctorId) await requireTenantUser(tenantId, input.doctorId);
  if (input.clinicId) await requireTenantClinic(tenantId, input.clinicId);

  const { appointment, conflicts } = await db.$transaction(async (tx) => {
    await lockSlots(tx, tenantId, input.doctorId, input.room);
    const conflicts = await findConflicts(
      tenantId,
      { doctorId: input.doctorId, room: input.room, startsAt: input.startsAt, endsAt: input.endsAt },
      tx,
    );
    if (conflicts.length && !input.allowWaitlist) throw new AppointmentConflictError(conflicts);

    const status: AppointmentStatus = conflicts.length ? "WAITLISTED" : "SCHEDULED";
    const now = new Date();
    const appointment = await tx.appointment.create({
      data: {
        tenantId,
        clinicId: input.clinicId ?? null,
        patientId: input.patientId,
        doctorId: input.doctorId ?? null,
        room: input.room ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        source: input.source,
        status,
        statusChangedAt: now,
        createdById: actor.id ?? null,
      },
      include: { patient: patientSelect },
    });

    await tx.timelineEvent.create({
      data: {
        tenantId,
        patientId: input.patientId,
        kind: "APPOINTMENT",
        title: input.reason ? `Appointment — ${input.reason}` : "Appointment booked",
        body: status === "WAITLISTED" ? "Waitlisted: the requested slot is already taken." : null,
        refId: appointment.id,
        occurredAt: input.startsAt,
      },
    });

    return { appointment, conflicts };
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "appointment.create",
    entity: "Appointment",
    entityId: appointment.id,
    after: slotSnapshot(appointment),
  });
  // The patient profile document lists upcoming appointments; refresh it.
  ingestInBackground({ kind: "patient", tenantId, id: input.patientId });

  return { appointment: await attachDoctor(tenantId, appointment), conflicts };
}

export async function rescheduleAppointment(
  tenantId: string,
  id: string,
  rawInput: unknown,
  actor: Actor = {},
) {
  const input = AppointmentUpdateInput.parse(rawInput);
  if (input.doctorId) await requireTenantUser(tenantId, input.doctorId);

  const { before, after, conflicts, slotChanged } = await db.$transaction(async (tx) => {
    const before = await tx.appointment.findFirst({
      where: { id, tenantId, ...notDeleted },
      include: { patient: patientSelect },
    });
    if (!before) throw new AppointmentNotFoundError(id);

    const startsAt = input.startsAt ?? before.startsAt;
    const endsAt = input.endsAt ?? before.endsAt;
    const doctorId = input.doctorId === undefined ? before.doctorId : input.doctorId;
    const room = input.room === undefined ? before.room : input.room;
    const timeChanged =
      startsAt.getTime() !== before.startsAt.getTime() || endsAt.getTime() !== before.endsAt.getTime();
    const slotChanged = timeChanged || doctorId !== before.doctorId || room !== before.room;
    if (slotChanged && !isReschedulable(before.status)) {
      throw new AppointmentNotReschedulableError(before.status);
    }

    let status: AppointmentStatus = before.status;
    let conflicts: AppointmentConflict[] = [];
    if (slotChanged) {
      await lockSlots(tx, tenantId, doctorId, room);
      conflicts = await findConflicts(tenantId, { doctorId, room, startsAt, endsAt, excludeId: id }, tx);
      if (conflicts.length) {
        if (!input.allowWaitlist) throw new AppointmentConflictError(conflicts);
        status = "WAITLISTED";
      } else if (before.status === "WAITLISTED" || timeChanged) {
        // A free slot takes a waitlisted booking off the waitlist, and a moved
        // appointment needs confirming again.
        status = "SCHEDULED";
      }
    }

    const now = new Date();
    const after = await tx.appointment.update({
      where: { id, tenantId },
      data: {
        startsAt,
        endsAt,
        doctorId,
        room,
        // undefined keeps the stored value, null clears it (blank input).
        reason: input.reason,
        notes: input.notes,
        status,
        statusChangedAt: status === before.status ? undefined : now,
      },
      include: { patient: patientSelect },
    });

    if (timeChanged) {
      // Keep the booking's entry on the patient timeline at the new time.
      const event = await tx.timelineEvent.findFirst({
        where: { tenantId, patientId: before.patientId, refId: id, kind: "APPOINTMENT" },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (event) await tx.timelineEvent.update({ where: { id: event.id }, data: { occurredAt: startsAt } });
    }

    return { before, after, conflicts, slotChanged };
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: slotChanged ? "appointment.reschedule" : "appointment.update",
    entity: "Appointment",
    entityId: id,
    before: slotSnapshot(before),
    after: slotSnapshot(after),
  });
  // The patient profile document lists upcoming appointments; refresh it.
  ingestInBackground({ kind: "patient", tenantId, id: before.patientId });

  return { appointment: await attachDoctor(tenantId, after), conflicts };
}

const TIMELINE_FOR_STATUS: Partial<Record<AppointmentStatus, string>> = {
  CANCELLED: "Appointment cancelled",
  NO_SHOW: "Missed appointment (no-show)",
  COMPLETED: "Appointment completed",
};

export async function transitionAppointment(
  tenantId: string,
  id: string,
  rawInput: unknown,
  actor: Actor = {},
) {
  const input = AppointmentTransitionInput.parse(rawInput);

  const { before, after } = await db.$transaction(async (tx) => {
    const before = await tx.appointment.findFirst({
      where: { id, tenantId, ...notDeleted },
      include: { patient: patientSelect },
    });
    if (!before) throw new AppointmentNotFoundError(id);
    if (!canTransition(before.status, input.status)) {
      throw new InvalidTransitionError(before.status, input.status);
    }

    if (before.status === "WAITLISTED" && input.status === "SCHEDULED") {
      // Promotion only when the slot has since become free.
      await lockSlots(tx, tenantId, before.doctorId, before.room);
      const conflicts = await findConflicts(
        tenantId,
        { doctorId: before.doctorId, room: before.room, startsAt: before.startsAt, endsAt: before.endsAt, excludeId: id },
        tx,
      );
      if (conflicts.length) throw new AppointmentConflictError(conflicts);
    }

    const now = new Date();
    const keepsReason = input.status === "CANCELLED" || input.status === "NO_SHOW";
    const after = await tx.appointment.update({
      where: { id, tenantId },
      data: {
        status: input.status,
        statusChangedAt: now,
        cancelReason: keepsReason ? (input.reason ?? null) : null,
      },
      include: { patient: patientSelect },
    });

    const title = TIMELINE_FOR_STATUS[input.status];
    if (title) {
      await tx.timelineEvent.create({
        data: {
          tenantId,
          patientId: before.patientId,
          kind: "APPOINTMENT",
          title,
          body: input.reason ?? null,
          refId: id,
          occurredAt: input.status === "NO_SHOW" ? before.startsAt : now,
        },
      });
    }

    return { before, after };
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "appointment.transition",
    entity: "Appointment",
    entityId: id,
    before: { status: before.status, cancelReason: before.cancelReason },
    after: { status: after.status, cancelReason: after.cancelReason, reason: input.reason ?? null },
  });
  // The patient profile document lists upcoming appointments; refresh it.
  ingestInBackground({ kind: "patient", tenantId, id: before.patientId });

  return attachDoctor(tenantId, after);
}

/** The audited fields of a booking. */
function slotSnapshot(a: {
  patientId: string;
  doctorId: string | null;
  clinicId: string | null;
  room: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  reason: string | null;
}) {
  return {
    patientId: a.patientId,
    doctorId: a.doctorId,
    clinicId: a.clinicId,
    room: a.room,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    status: a.status,
    reason: a.reason,
  };
}
