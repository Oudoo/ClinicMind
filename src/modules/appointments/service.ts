import { Prisma, type UserRole } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { can } from "@/lib/auth/rbac";
import { ingestInBackground } from "@/modules/knowledge/ingest";
import { notify, type NotifyInput } from "@/modules/notifications/service";
import { readTenantSetting } from "@/lib/tenant-settings";
import {
  addDays,
  dateKeyInTz,
  endOfDayInTz,
  formatDateInTz,
  formatTimeInTz,
  fromDateKey,
  isValidTimeZone,
  startOfDayInTz,
  zonedParts,
} from "@/lib/time";
import { TenantScopeError, requireTenantClinic, requireTenantPatient, requireTenantUser } from "@/lib/tenant-scope";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import { requestConfirmation, type ConfirmationRequest } from "./confirmation";
import { toAppointmentDTO, type FreeSlotsDTO, type NextAppointmentDTO, type SlotCellDTO } from "./dto";
import { buildSlotGrid, freeCellsAfter, initialsOf, normaliseHours, type SlotCell, type TakenRange } from "./slots";
import { clinicDayLabel, hoursViolation, isInThePast, transitionTimeBlock, type TransitionTimeCode } from "./rules";
import {
  APPOINTMENT_KINDS,
  APPOINTMENT_STATUSES,
  canTransition,
  DEFAULT_WORKING_HOURS,
  isReschedulable,
  LIVE_STATUSES,
  MAX_DURATION_MINUTES,
  MAX_REASON_LENGTH,
  MIN_DURATION_MINUTES,
  NON_BLOCKING_STATUSES,
  SLOT_STEP_MINUTES,
  type AppointmentKind,
  type AppointmentStatus,
  type WorkingHours,
} from "./transitions";

/**
 * Appointment lifecycle: booking with conflict detection, rescheduling and
 * status transitions. Every query is tenant-scoped, every foreign key a
 * request supplies is proven to belong to the tenant (SEC-4), and every
 * mutation is audited.
 *
 * No double bookings, three layers deep:
 *   1. the conflict check and the write run inside one transaction that first
 *      takes a Postgres advisory lock per doctor, room and patient, so two
 *      concurrent bookings of the same slot are serialised and the second one
 *      sees the first;
 *   2. the database enforces it regardless (exclusion constraints
 *      `appointments_doctor_no_overlap` / `appointments_room_no_overlap`); a
 *      violation that slips past the check (a writer that did not take the
 *      lock) is caught and answered as the same 409 with the bookings in the way;
 *   3. a patient cannot hold two live appointments that overlap either
 *      (409 `patient_conflict`) unless the caller says so explicitly.
 */

type Client = Prisma.TransactionClient;

export const DEFAULT_TIMEZONE = "Africa/Cairo";

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
  /** The caller's role: owner-level callers (users:manage) may back-enter or book outside the hours on purpose. */
  role?: UserRole | null;
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

/** The patient already holds a live appointment that overlaps the requested slot. */
export class PatientConflictError extends Error {
  readonly status = 409;
  readonly code = "patient_conflict";
  constructor(readonly conflicts: AppointmentConflict[]) {
    super("The patient already has an appointment at that time");
    this.name = "PatientConflictError";
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

/**
 * The clock does not allow the move yet (or any more): a no-show before the
 * start, a check-in on another day, a completion before the start (409).
 */
export class AppointmentTimeError extends Error {
  readonly status = 409;
  constructor(
    readonly code: TransitionTimeCode,
    message: string,
    readonly from: AppointmentStatus,
    readonly to: AppointmentStatus,
  ) {
    super(message);
    this.name = "AppointmentTimeError";
  }
}

export type BookingTimeCode = "in_the_past" | "outside_hours";

/**
 * A booking or a move into the past or outside the opening hours (422).
 * `overridable` tells the caller that an owner may resend it with
 * `allowPast` / `allowOutsideHours` set.
 */
/**
 * The person booked as the doctor cannot take the booking: not marked as a
 * clinician, or a nurse booked for anything but a procedure (422).
 */
export class DoctorNotBookableError extends Error {
  readonly status = 422;
  constructor(
    readonly doctorId: string,
    readonly role: UserRole,
  ) {
    super(
      role === "NURSE"
        ? "A nurse can be booked for a procedure only; choose a doctor."
        : "Only staff the owner marked as clinicians can be booked as the doctor.",
    );
    this.name = "DoctorNotBookableError";
  }
}

export class BookingTimeError extends Error {
  readonly status = 422;
  constructor(
    readonly code: BookingTimeCode,
    message: string,
    readonly overridable: boolean,
    readonly hours: WorkingHours | null = null,
  ) {
    super(message);
    this.name = "BookingTimeError";
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

/** The tenant's opening hours (`hours` setting, repaired field by field; Saturday–Thursday 10:00–20:00 by default). */
export async function getWorkingHours(tenantId: string): Promise<WorkingHours> {
  return normaliseHours(await readTenantSetting(tenantId, "hours", DEFAULT_WORKING_HOURS));
}

// ── The booking clock ────────────────────────────────────────────────────────

interface BookingClock {
  timezone: string;
  hours: WorkingHours;
  now: Date;
}

async function bookingClock(tenantId: string): Promise<BookingClock> {
  const [timezone, hours] = await Promise.all([getTenantTimezone(tenantId), getWorkingHours(tenantId)]);
  return { timezone, hours, now: new Date() };
}

/** The owner overrides a booking needed; written to the audit entry. */
interface BookingOverrides {
  allowPast?: true;
  allowOutsideHours?: true;
}

/**
 * Refuse a slot that starts more than 15 minutes before now (422
 * `in_the_past`) or lies outside the opening hours (422 `outside_hours`),
 * unless an owner-level caller (users:manage) asked for it on purpose with
 * `allowPast` / `allowOutsideHours`. Returns the overrides that were needed.
 * `checkPast` is false when a move keeps the booking's start (only its end
 * changes): the booking is not being put into the past.
 */
function checkBookingTime(
  slot: { startsAt: Date; endsAt: Date },
  flags: { allowPast: boolean; allowOutsideHours: boolean },
  actor: Actor,
  clock: BookingClock,
  checkPast = true,
): BookingOverrides {
  const owner = Boolean(actor.role && can(actor.role, "users:manage"));
  const overrides: BookingOverrides = {};
  if (checkPast && isInThePast(slot.startsAt, clock.now)) {
    if (!(owner && flags.allowPast)) {
      const when = `${clinicDayLabel(slot.startsAt, clock.timezone)} ${formatTimeInTz(slot.startsAt, clock.timezone)}`;
      throw new BookingTimeError(
        "in_the_past",
        owner
          ? `${when} has already passed. Choose a time from now on, or back-enter it on purpose.`
          : `${when} has already passed. Choose a time from now on; only the clinic owner can back-enter a past booking.`,
        owner,
      );
    }
    overrides.allowPast = true;
  }
  const outside = hoursViolation(slot.startsAt, slot.endsAt, clock.hours, clock.timezone);
  if (outside) {
    if (!(owner && flags.allowOutsideHours)) {
      throw new BookingTimeError(
        "outside_hours",
        owner ? `${outside.message} As the owner you can book outside the hours on purpose.` : outside.message,
        owner,
        clock.hours,
      );
    }
    overrides.allowOutsideHours = true;
  }
  return overrides;
}

/**
 * The same clock check a booking gets, for callers that must look before they
 * write anything else (the CRM converts a lead into a patient before booking:
 * a refused time must not leave that patient behind). Throws the 422
 * `BookingTimeError`; owners may pass the override flags.
 */
export async function assertBookableTime(
  tenantId: string,
  slot: { startsAt: Date; endsAt: Date },
  actor: Actor = {},
  flags: { allowPast?: boolean; allowOutsideHours?: boolean } = {},
): Promise<void> {
  checkBookingTime(slot, { allowPast: Boolean(flags.allowPast), allowOutsideHours: Boolean(flags.allowOutsideHours) }, actor, await bookingClock(tenantId));
}

// ── Staff (doctor pickers) ───────────────────────────────────────────────────

/**
 * The person booked as the doctor: of the acting tenant (SEC-4) and one of the
 * people the doctor pickers offer (`listStaff`): a bookable role the owner
 * marked as a clinician, or a nurse for a PROCEDURE (a nurse-led session).
 */
async function requireBookableDoctor(tenantId: string, doctorId: string, kind: AppointmentKind | null | undefined): Promise<void> {
  await requireTenantUser(tenantId, doctorId);
  const user = await db.user.findFirst({ where: { id: doctorId, tenantId }, select: { role: true, isClinician: true } });
  if (!user) throw new TenantScopeError("user", doctorId);
  const bookableRole = (BOOKABLE_ROLES as readonly UserRole[]).includes(user.role);
  if (bookableRole && (user.isClinician || (kind === "PROCEDURE" && user.role === "NURSE"))) return;
  throw new DoctorNotBookableError(doctorId, user.role);
}

export const BOOKABLE_ROLES = ["DOCTOR", "NURSE", "CLINIC_OWNER"] as const;
export const zBookableRole = z.enum(BOOKABLE_ROLES);
export type BookableRole = z.infer<typeof zBookableRole>;

export interface StaffSummary {
  id: string;
  fullName: string;
  role: BookableRole;
}

export interface StaffFilter {
  /** Narrow to one role. */
  role?: BookableRole;
  /** The kind of booking: a PROCEDURE may also be a nurse-led session, so nurses are listed too. */
  kind?: AppointmentKind;
}

/**
 * Who an appointment can be booked with: active, non-deleted staff of a
 * bookable role whom the owner marked as clinicians (doctors and the
 * physician-owner), plus nurses for a PROCEDURE (nurse-led sessions). An
 * owner-level administrator who is not a clinician (the Clinic AI lead) and,
 * outside procedures, the nurses are never offered as "the doctor".
 */
export async function listStaff(tenantId: string, filter: BookableRole | StaffFilter = {}): Promise<StaffSummary[]> {
  const { role, kind } = typeof filter === "string" ? { role: filter, kind: undefined } : filter;
  const nurseLed = kind === "PROCEDURE";
  const users = await db.user.findMany({
    where: {
      tenantId,
      ...notDeleted,
      status: "ACTIVE",
      role: role ?? { in: [...BOOKABLE_ROLES] },
      OR: [{ isClinician: true }, ...(nurseLed ? [{ role: "NURSE" as const }] : [])],
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
export const zAppointmentKind = z.enum(APPOINTMENT_KINDS);

const zId = zText(64).min(1);
const zSource = z.enum(["WHATSAPP", "VOICE", "SMS", "WEB_CHAT", "IN_PERSON"]);

/** Optional text where a blank string means "clear" (null) and absence means "keep". */
const zClearableText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    zText(max).nullable().optional(),
  );

const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

function checkDuration(startsAt: Date, endsAt: Date, ctx: z.RefinementCtx): void {
  // Refinements run even when a field already failed; those issues are reported on their own.
  if (!isDate(startsAt) || !isDate(endsAt)) return;
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
    kind: zAppointmentKind.default("CONSULTATION"),
    reason: zOptionalText(MAX_REASON_LENGTH),
    notes: zOptionalText(2000),
    source: zSource.default("IN_PERSON"),
    /** When the slot is taken, book onto the waitlist instead of failing with 409. */
    allowWaitlist: z.boolean().default(false),
    /** Let the patient hold two overlapping live appointments (e.g. two procedures in one visit). */
    allowPatientOverlap: z.boolean().default(false),
    /** Owner only (users:manage): back-enter a booking that started more than 15 minutes ago. Audited. */
    allowPast: z.boolean().default(false),
    /** Owner only (users:manage): book outside the opening hours or on a closed day. Audited. */
    allowOutsideHours: z.boolean().default(false),
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
    kind: zAppointmentKind.optional(),
    reason: zClearableText(MAX_REASON_LENGTH),
    notes: zClearableText(2000),
    allowWaitlist: z.boolean().default(false),
    allowPatientOverlap: z.boolean().default(false),
    /** Owner only: move the booking to a time that started more than 15 minutes ago. Audited. */
    allowPast: z.boolean().default(false),
    /** Owner only: move the booking outside the opening hours. Audited. */
    allowOutsideHours: z.boolean().default(false),
    /** A new time asks the patient to confirm it on WhatsApp (appointments/confirmation.ts); false when they already agreed (on the phone, at the desk). */
    askPatientToConfirm: z.boolean().default(true),
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
    kind: zAppointmentKind.optional(),
    patientId: zOptionalText(64),
  })
  .transform((q) => {
    const from = q.from ?? new Date();
    const to = q.to ?? new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    return { ...q, from, to };
  })
  .superRefine((q, ctx) => {
    if (!isDate(q.from) || !isDate(q.to)) return;
    if (q.to.getTime() < q.from.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must not be before from" });
    } else if (q.to.getTime() - q.from.getTime() > MAX_LIST_RANGE_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Range must not exceed one year" });
    }
  });
export type AppointmentListFilter = z.infer<typeof AppointmentListQuery>;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const isCalendarKey = (s: string) => {
  const m = DATE_KEY.exec(s);
  if (!m) return false;
  const probe = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return probe.getUTCFullYear() === Number(m[1]) && probe.getUTCMonth() === Number(m[2]) - 1 && probe.getUTCDate() === Number(m[3]);
};

/** Query string of GET /api/appointments/free-slots. */
export const FreeSlotsQuery = z
  .object({
    doctorId: zOptionalText(64),
    room: zOptionalText(60),
    date: z.string().trim().refine(isCalendarKey, "Use a calendar date as YYYY-MM-DD"),
    duration: z.coerce.number().int().min(MIN_DURATION_MINUTES).max(MAX_DURATION_MINUTES).default(30),
    /** Suggestions are the next free starts after this instant (default: now). */
    after: zDateTime.optional(),
    /** The appointment being rescheduled does not block its own slot. */
    excludeId: zOptionalText(64),
  })
  .superRefine((q, ctx) => {
    if (!q.doctorId && !q.room) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["doctorId"], message: "Give a doctor or a room" });
    }
  });
export type FreeSlotsFilter = z.infer<typeof FreeSlotsQuery>;

export const NextAppointmentQuery = z.object({
  scope: z.enum(["auto", "mine", "clinic"]).default("auto"),
  patientId: zOptionalText(64),
});

/** Query string of GET /api/appointments/clinicians. */
export const CliniciansQuery = z.object({ kind: zAppointmentKind.optional() });

// ── Shapes ───────────────────────────────────────────────────────────────────

const patientSelect = { select: { id: true, fullName: true } } as const;

/** Patient plus the count of live dictated notes, on every appointment the API returns. */
const appointmentInclude = {
  patient: patientSelect,
  _count: { select: { dictatedNotes: { where: { deletedAt: null } } } },
} satisfies Prisma.AppointmentInclude;

/** `_count.dictatedNotes` → `notesCount`, the shape client code and DTOs use. */
function shape<T extends { _count: { dictatedNotes: number } }>(row: T): Omit<T, "_count"> & { notesCount: number } {
  const { _count, ...rest } = row;
  return { ...rest, notesCount: _count.dictatedNotes };
}

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

/** Same for the authors of dictated notes (`authorId` is a plain column too). */
export async function attachNoteAuthors<T extends { authorId: string | null }>(
  tenantId: string,
  rows: T[],
  client: Client = db,
): Promise<(T & { author: DoctorSummary | null })[]> {
  const ids = [...new Set(rows.map((r) => r.authorId).filter((id): id is string => Boolean(id)))];
  const users = ids.length
    ? await client.user.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, fullName: true, email: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, { id: u.id, fullName: u.fullName ?? u.email }]));
  return rows.map((r) => ({ ...r, author: r.authorId ? (byId.get(r.authorId) ?? null) : null }));
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
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.patientId ? { patientId: filter.patientId } : {}),
    },
    orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
    take: 500,
    include: appointmentInclude,
  });
  return attachDoctors(tenantId, rows.map(shape));
}

/** One appointment with its live dictated notes (authors attached). */
export async function getAppointment(tenantId: string, id: string) {
  const row = await db.appointment.findFirst({
    where: { id, tenantId, ...notDeleted },
    include: {
      ...appointmentInclude,
      dictatedNotes: { where: { deletedAt: null }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!row) return null;
  const { dictatedNotes, ...rest } = row;
  const [appointment, notes] = await Promise.all([
    attachDoctor(tenantId, shape(rest)),
    attachNoteAuthors(tenantId, dictatedNotes),
  ]);
  return { ...appointment, dictatedNotes: notes };
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

/** The patient's other live appointments that overlap the slot. */
export async function findPatientOverlap(
  tenantId: string,
  input: { patientId: string; startsAt: Date; endsAt: Date; excludeId?: string },
  client: Client = db,
): Promise<AppointmentConflict[]> {
  const rows = await client.appointment.findMany({
    where: {
      tenantId,
      ...notDeleted,
      patientId: input.patientId,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      status: { notIn: [...NON_BLOCKING_STATUSES] },
      startsAt: { lt: input.endsAt },
      endsAt: { gt: input.startsAt },
    },
    orderBy: { startsAt: "asc" },
    take: 20,
    select: { id: true, startsAt: true, endsAt: true, doctorId: true, room: true, status: true, patient: patientSelect },
  });
  return attachDoctors(tenantId, rows, client);
}

/**
 * Serialise concurrent writes against the same doctor / room / patient for the
 * rest of the transaction (keys are sorted so two writers never deadlock).
 */
async function lockSlots(
  tx: Client,
  tenantId: string,
  keys: { doctorId?: string | null; room?: string | null; patientId?: string | null },
): Promise<void> {
  const names = [
    keys.doctorId ? `doctor:${keys.doctorId}` : null,
    keys.room ? `room:${keys.room}` : null,
    keys.patientId ? `patient:${keys.patientId}` : null,
  ]
    .filter((k): k is string => Boolean(k))
    .sort();
  for (const key of names) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${key}`}))`;
  }
}

const EXCLUSION_PATTERN = /23P01|exclusion_violation|_no_overlap|violates exclusion constraint/i;

/**
 * True when Postgres refused the write because of an exclusion constraint
 * (SQLSTATE 23P01). Prisma has no error code for it: depending on the engine
 * it arrives as a known request error carrying the Postgres code in `meta`,
 * or as an unknown request error with the code only in the message.
 */
export function isExclusionViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = (err.meta ?? {}) as Record<string, unknown>;
    if (meta.code === "23P01") return true;
    const driver = meta.driverAdapterError as { cause?: { code?: unknown } } | undefined;
    if (driver?.cause?.code === "23P01") return true;
    return EXCLUSION_PATTERN.test(err.message);
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return EXCLUSION_PATTERN.test(err.message);
  return false;
}

interface SlotRef {
  doctorId?: string | null;
  room?: string | null;
  startsAt: Date;
  endsAt: Date;
  excludeId?: string;
}

/**
 * Turn whatever stopped a booking transaction into the API's conflict errors:
 * a database exclusion violation becomes a 409 `conflict` with the bookings in
 * the way (re-read outside the aborted transaction), and every refusal tells
 * the actor through a BOOKING_CONFLICT notification. Anything else passes.
 */
async function conflictFromError(tenantId: string, actor: Actor, err: unknown, slot: SlotRef): Promise<unknown> {
  let refusal: AppointmentConflictError | PatientConflictError;
  if (isExclusionViolation(err)) {
    const conflicts = await findConflicts(tenantId, slot).catch(() => [] as AppointmentConflict[]);
    refusal = new AppointmentConflictError(conflicts);
  } else if (err instanceof AppointmentConflictError || err instanceof PatientConflictError) {
    refusal = err;
  } else {
    return err;
  }
  if (actor.id) {
    const actorId = actor.id;
    const other = refusal.conflicts[0];
    notifyLater(tenantId, (tz) => ({
      kind: "BOOKING_CONFLICT",
      level: "WARNING",
      title: refusal instanceof PatientConflictError ? "Patient already booked at that time" : "Double booking refused",
      body: `${formatDateInTz(slot.startsAt, tz, { weekday: "short", day: "2-digit", month: "short" })} ${formatTimeInTz(slot.startsAt, tz)}–${formatTimeInTz(slot.endsAt, tz)}${
        other ? ` overlaps ${other.patient.fullName}${other.doctor ? ` with ${other.doctor.fullName}` : ""}${other.room ? ` in ${other.room}` : ""}` : ""
      }`,
      href: dayHref(slot.startsAt, tz),
      entity: "Appointment",
      entityId: other?.id ?? null,
      userIds: [actorId],
    }));
  }
  return refusal;
}

// ── Notifications (cheap, fire-and-forget) ───────────────────────────────────

/** Reception and the owner hear about bookings; the actor is never told what they just did. */
const BOOKING_WATCHERS: readonly UserRole[] = ["RECEPTIONIST", "CLINIC_OWNER"];

function dayHref(startsAt: Date, tz: string): string {
  return `/dashboard/appointments?view=day&date=${dateKeyInTz(startsAt, tz)}`;
}

function slotLine(a: { startsAt: Date; endsAt: Date; room: string | null; doctor: DoctorSummary | null }, tz: string): string {
  return `${formatDateInTz(a.startsAt, tz, { weekday: "short", day: "2-digit", month: "short" })} ${formatTimeInTz(a.startsAt, tz)}–${formatTimeInTz(a.endsAt, tz)} · ${a.doctor?.fullName ?? "no doctor"}${a.room ? ` · ${a.room}` : ""}`;
}

/** Resolve the clinic clock, then notify; never awaited by the request and never throws. */
function notifyLater(tenantId: string, build: (tz: string) => NotifyInput): void {
  void getTenantTimezone(tenantId)
    .then((tz) => notify(tenantId, build(tz)))
    .catch((err) => console.error("[appointments] notification failed", err));
}

/**
 * The patient's recalls follow their bookings: a booking ahead books them, a
 * cancelled or missed one reopens them, a visit closes them (modules/recalls).
 * Loaded on demand (the recalls module books through this one) and never
 * fails the booking.
 */
async function syncRecalls(tenantId: string, patientId: string): Promise<void> {
  try {
    const { syncPatientRecalls } = await import("@/modules/recalls/engine");
    await syncPatientRecalls(tenantId, patientId);
  } catch (err) {
    console.error(`[appointments] recall sync failed for patient ${patientId}`, err);
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createAppointment(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = AppointmentInput.parse(rawInput);

  // Every client-supplied foreign key must belong to the acting tenant (SEC-4);
  // otherwise a booking (and its timeline event) could land on another
  // tenant's patient, doctor or clinic.
  await requireTenantPatient(tenantId, input.patientId);
  if (input.doctorId) await requireBookableDoctor(tenantId, input.doctorId, input.kind);
  if (input.clinicId) await requireTenantClinic(tenantId, input.clinicId);
  // Not in the past, not outside the opening hours (the owner may override, audited).
  const overrides = checkBookingTime(input, input, actor, await bookingClock(tenantId));

  const slot: SlotRef = { doctorId: input.doctorId ?? null, room: input.room ?? null, startsAt: input.startsAt, endsAt: input.endsAt };
  let outcome: { appointment: Awaited<ReturnType<typeof bookRow>>; conflicts: AppointmentConflict[] };
  try {
    outcome = await db.$transaction(async (tx) => {
      await lockSlots(tx, tenantId, { doctorId: input.doctorId, room: input.room, patientId: input.patientId });
      const conflicts = await findConflicts(tenantId, slot, tx);
      if (conflicts.length && !input.allowWaitlist) throw new AppointmentConflictError(conflicts);
      // A waitlisted booking holds no slot, so only a live one can overlap the patient.
      if (!conflicts.length && !input.allowPatientOverlap) {
        const own = await findPatientOverlap(tenantId, { patientId: input.patientId, startsAt: input.startsAt, endsAt: input.endsAt }, tx);
        if (own.length) throw new PatientConflictError(own);
      }

      const status: AppointmentStatus = conflicts.length ? "WAITLISTED" : "SCHEDULED";
      const appointment = await bookRow(tx, tenantId, input, status, actor);

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
  } catch (err) {
    throw await conflictFromError(tenantId, actor, err, slot);
  }
  const { conflicts } = outcome;
  const appointment = await attachDoctor(tenantId, outcome.appointment);

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "appointment.create",
    entity: "Appointment",
    entityId: appointment.id,
    after: { ...slotSnapshot(appointment), ...overrides },
  });
  // The patient profile document lists upcoming appointments; refresh it.
  ingestInBackground({ kind: "patient", tenantId, id: input.patientId });
  await syncRecalls(tenantId, input.patientId);
  notifyLater(tenantId, (tz) => ({
    kind: "BOOKING_CREATED",
    title: `${appointment.status === "WAITLISTED" ? "Waitlisted" : "New booking"}: ${appointment.patient.fullName}`,
    body: `${slotLine(appointment, tz)}${appointment.reason ? ` · ${appointment.reason}` : ""}`,
    href: dayHref(appointment.startsAt, tz),
    entity: "Appointment",
    entityId: appointment.id,
    roles: BOOKING_WATCHERS,
    excludeUserId: actor.id ?? null,
  }));

  return { appointment, conflicts };
}

async function bookRow(tx: Client, tenantId: string, input: AppointmentInput, status: AppointmentStatus, actor: Actor) {
  const now = new Date();
  const row = await tx.appointment.create({
    data: {
      tenantId,
      clinicId: input.clinicId ?? null,
      patientId: input.patientId,
      doctorId: input.doctorId ?? null,
      room: input.room ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      kind: input.kind,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      source: input.source,
      status,
      statusChangedAt: now,
      createdById: actor.id ?? null,
    },
    include: appointmentInclude,
  });
  return shape(row);
}

export async function rescheduleAppointment(
  tenantId: string,
  id: string,
  rawInput: unknown,
  actor: Actor = {},
) {
  const input = AppointmentUpdateInput.parse(rawInput);
  if (input.doctorId) await requireTenantUser(tenantId, input.doctorId);
  const clock = await bookingClock(tenantId);

  // The slot the transaction ends up targeting, for the conflict mapping below.
  const seen: { slot: SlotRef | null } = { slot: null };
  let outcome: Awaited<ReturnType<typeof applyReschedule>>;
  try {
    outcome = await db.$transaction((tx) => applyReschedule(tx, tenantId, id, input, seen, { actor, clock }));
  } catch (err) {
    throw await conflictFromError(tenantId, actor, err, seen.slot ?? { startsAt: input.startsAt ?? new Date(), endsAt: input.endsAt ?? new Date(), excludeId: id });
  }
  const { before, after, conflicts, slotChanged, timeChanged, overrides } = outcome;

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: slotChanged ? "appointment.reschedule" : "appointment.update",
    entity: "Appointment",
    entityId: id,
    before: slotSnapshot(before),
    after: { ...slotSnapshot(after), ...overrides },
  });
  // The patient profile document lists upcoming appointments; refresh it.
  ingestInBackground({ kind: "patient", tenantId, id: before.patientId });
  if (slotChanged) await syncRecalls(tenantId, before.patientId);

  // A live booking at a new time ahead asks the patient to confirm it (unless the desk says they already did).
  let confirmation: ConfirmationRequest | null = null;
  const now = new Date();
  if (timeChanged && after.status === "SCHEDULED" && after.startsAt > now && input.askPatientToConfirm) {
    try {
      confirmation = await requestConfirmation(tenantId, after, { timezone: clock.timezone, actor, now });
    } catch (err) {
      console.error("[appointments] could not ask the patient to confirm the new time", err);
      confirmation = { requested: false, delivery: null, reason: "error", conversationId: null };
    }
  }
  const moved = confirmation?.requested ? { ...after, confirmationRequestedAt: now } : after;

  return { appointment: await attachDoctor(tenantId, moved), conflicts, confirmation };
}

async function applyReschedule(
  tx: Client,
  tenantId: string,
  id: string,
  input: AppointmentUpdateInput,
  seen: { slot: SlotRef | null },
  ctx: { actor: Actor; clock: BookingClock },
) {
  const before = await tx.appointment.findFirst({
    where: { id, tenantId, ...notDeleted },
    include: appointmentInclude,
  });
  if (!before) throw new AppointmentNotFoundError(id);

  const startsAt = input.startsAt ?? before.startsAt;
  const endsAt = input.endsAt ?? before.endsAt;
  const doctorId = input.doctorId === undefined ? before.doctorId : input.doctorId;
  const room = input.room === undefined ? before.room : input.room;
  const startChanged = startsAt.getTime() !== before.startsAt.getTime();
  const timeChanged = startChanged || endsAt.getTime() !== before.endsAt.getTime();
  const slotChanged = timeChanged || doctorId !== before.doctorId || room !== before.room;
  // A new doctor (or a new kind of visit for the same one) must be someone the pickers offer.
  const kind = input.kind ?? before.kind;
  if (doctorId && (doctorId !== before.doctorId || kind !== before.kind)) await requireBookableDoctor(tenantId, doctorId, kind);
  seen.slot = { doctorId, room, startsAt, endsAt, excludeId: id };
  if (slotChanged && !isReschedulable(before.status)) {
    throw new AppointmentNotReschedulableError(before.status);
  }
  // A move must land from now on and inside the opening hours (the owner may override, audited).
  const overrides = timeChanged ? checkBookingTime({ startsAt, endsAt }, input, ctx.actor, ctx.clock, startChanged) : {};

  let status: AppointmentStatus = before.status;
  let conflicts: AppointmentConflict[] = [];
  if (slotChanged) {
    await lockSlots(tx, tenantId, { doctorId, room, patientId: before.patientId });
    conflicts = await findConflicts(tenantId, { doctorId, room, startsAt, endsAt, excludeId: id }, tx);
    if (conflicts.length) {
      if (!input.allowWaitlist) throw new AppointmentConflictError(conflicts);
      status = "WAITLISTED";
    } else if (before.status === "WAITLISTED" || timeChanged) {
      // A free slot takes a waitlisted booking off the waitlist, and a moved
      // appointment needs confirming again.
      status = "SCHEDULED";
    }
    if (status !== "WAITLISTED" && !input.allowPatientOverlap) {
      const own = await findPatientOverlap(tenantId, { patientId: before.patientId, startsAt, endsAt, excludeId: id }, tx);
      if (own.length) throw new PatientConflictError(own);
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
      kind: input.kind,
      // undefined keeps the stored value, null clears it (blank input).
      reason: input.reason,
      notes: input.notes,
      status,
      statusChangedAt: status === before.status ? undefined : now,
      // A moved booking is a new promise: the old confirmation no longer stands.
      confirmedAt: status !== before.status && status === "SCHEDULED" ? null : undefined,
      // Nor does a request to confirm the old time.
      confirmationRequestedAt: timeChanged ? null : undefined,
      // The new time gets its own reminders and day-before call; a request for another time is answered.
      ...(timeChanged ? { reminderSentAt: null, finalReminderSentAt: null, confirmCallFlaggedAt: null, rescheduleRequestedAt: null } : {}),
    },
    include: appointmentInclude,
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

  return { before: shape(before), after: shape(after), conflicts, slotChanged, timeChanged, overrides };
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
  const timezone = await getTenantTimezone(tenantId);

  const seen: { slot: SlotRef | null } = { slot: null };
  let outcome: { before: ReturnType<typeof shape<Row>>; after: ReturnType<typeof shape<Row>> };
  try {
    outcome = await db.$transaction(async (tx) => {
      const before = await tx.appointment.findFirst({
        where: { id, tenantId, ...notDeleted },
        include: appointmentInclude,
      });
      if (!before) throw new AppointmentNotFoundError(id);
      if (!canTransition(before.status, input.status)) {
        throw new InvalidTransitionError(before.status, input.status);
      }
      // The clock decides too: no no-show before the start, check-in only on the
      // day (until two hours after the end), no completion before the start.
      const now = new Date();
      const block = transitionTimeBlock(before, input.status, now, timezone);
      if (block) throw new AppointmentTimeError(block.code, block.message, before.status, input.status);
      seen.slot = { doctorId: before.doctorId, room: before.room, startsAt: before.startsAt, endsAt: before.endsAt, excludeId: id };

      if (before.status === "WAITLISTED" && input.status === "SCHEDULED") {
        // A slot that has passed cannot become a live booking again; move it instead.
        if (isInThePast(before.startsAt, now)) {
          throw new BookingTimeError(
            "in_the_past",
            `The waitlisted slot (${clinicDayLabel(before.startsAt, timezone)} ${formatTimeInTz(before.startsAt, timezone)}) has passed. Reschedule it to a free time instead.`,
            false,
          );
        }
        // Promotion only when the slot has since become free.
        await lockSlots(tx, tenantId, { doctorId: before.doctorId, room: before.room, patientId: before.patientId });
        const conflicts = await findConflicts(tenantId, seen.slot, tx);
        if (conflicts.length) throw new AppointmentConflictError(conflicts);
        // Once live, the booking must not overlap another live one of the same patient.
        const own = await findPatientOverlap(tenantId, { patientId: before.patientId, startsAt: before.startsAt, endsAt: before.endsAt, excludeId: id }, tx);
        if (own.length) throw new PatientConflictError(own);
      }

      const keepsReason = input.status === "CANCELLED" || input.status === "NO_SHOW";
      const after = await tx.appointment.update({
        where: { id, tenantId },
        data: {
          status: input.status,
          statusChangedAt: now,
          cancelReason: keepsReason ? (input.reason ?? null) : null,
          confirmedAt: input.status === "CONFIRMED" ? now : input.status === "SCHEDULED" ? null : undefined,
          // Any change of status settles a pending request to confirm a new time, or for another one.
          confirmationRequestedAt: null,
          rescheduleRequestedAt: null,
          checkedInAt: input.status === "CHECKED_IN" ? now : input.status === "SCHEDULED" ? null : undefined,
        },
        include: appointmentInclude,
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

      return { before: shape(before), after: shape(after) };
    });
  } catch (err) {
    throw await conflictFromError(tenantId, actor, err, seen.slot ?? { startsAt: new Date(), endsAt: new Date(), excludeId: id });
  }
  const { before } = outcome;
  const after = await attachDoctor(tenantId, outcome.after);

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
  await syncRecalls(tenantId, before.patientId);

  if (input.status === "CANCELLED" || input.status === "NO_SHOW") {
    const cancelled = input.status === "CANCELLED";
    notifyLater(tenantId, (tz) => ({
      kind: cancelled ? "BOOKING_CANCELLED" : "NO_SHOW",
      level: cancelled ? "INFO" : "WARNING",
      title: cancelled ? `Cancelled: ${after.patient.fullName}` : `No-show: ${after.patient.fullName}`,
      body: `${slotLine(after, tz)}${input.reason ? ` · ${input.reason}` : ""}`,
      href: dayHref(after.startsAt, tz),
      entity: "Appointment",
      entityId: id,
      roles: BOOKING_WATCHERS,
      excludeUserId: actor.id ?? null,
    }));
  }

  return after;
}

type Row = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

/** The audited fields of a booking. */
function slotSnapshot(a: {
  patientId: string;
  doctorId: string | null;
  clinicId: string | null;
  room: string | null;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  kind?: string;
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
    kind: a.kind,
    reason: a.reason,
  };
}

// ── The next appointment (the big button) ────────────────────────────────────

export interface NextAppointmentOptions {
  userId?: string | null;
  role?: UserRole;
  /**
   * `mine`: only the viewer's own bookings; `clinic`: the whole clinic;
   * `auto` (default): doctors and the owner see their own and fall back to the
   * clinic's when they have none, everyone else sees the clinic's.
   */
  scope?: "auto" | "mine" | "clinic";
  /** The patient's own next appointment instead (the patient page). */
  patientId?: string | null;
  now?: Date;
}

/**
 * The next live appointment (SCHEDULED / CONFIRMED / CHECKED_IN / IN_PROGRESS
 * and not over yet; a patient already in the room today counts even past the
 * slot's end) plus the rest of today's queue, three deep.
 */
export async function getNextAppointment(tenantId: string, opts: NextAppointmentOptions = {}): Promise<NextAppointmentDTO> {
  const now = opts.now ?? new Date();
  const [timezone, hours] = await Promise.all([getTenantTimezone(tenantId), getWorkingHours(tenantId)]);
  const dayStart = startOfDayInTz(now, timezone);
  const dayEnd = endOfDayInTz(now, timezone);
  const live: Prisma.AppointmentWhereInput = {
    tenantId,
    ...notDeleted,
    status: { in: [...LIVE_STATUSES] },
    OR: [{ endsAt: { gte: now } }, { status: { in: ["CHECKED_IN", "IN_PROGRESS"] }, startsAt: { gte: dayStart } }],
  };
  const first = async (where: Prisma.AppointmentWhereInput) => {
    const row = await db.appointment.findFirst({
      where,
      orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
      include: appointmentInclude,
    });
    return row ? attachDoctor(tenantId, shape(row)) : null;
  };

  let scope: NextAppointmentDTO["scope"];
  let fallback = false;
  let where: Prisma.AppointmentWhereInput;
  let appointment: Awaited<ReturnType<typeof first>>;
  if (opts.patientId) {
    scope = "patient";
    where = { ...live, patientId: opts.patientId };
    appointment = await first(where);
  } else {
    const own = Boolean(opts.userId) && (opts.scope === "mine" || (opts.scope !== "clinic" && (opts.role === "DOCTOR" || opts.role === "CLINIC_OWNER")));
    if (own) {
      scope = "mine";
      where = { ...live, doctorId: opts.userId };
      appointment = await first(where);
      if (!appointment && opts.scope !== "mine") {
        scope = "clinic";
        fallback = true;
        where = live;
        appointment = await first(where);
      }
    } else {
      scope = "clinic";
      where = live;
      appointment = await first(where);
    }
  }

  const rows = await db.appointment.findMany({
    where: {
      ...where,
      ...(scope === "patient" ? {} : { startsAt: { lte: dayEnd } }),
      ...(appointment ? { id: { not: appointment.id } } : {}),
    },
    orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
    take: 3,
    include: appointmentInclude,
  });
  const queue = await attachDoctors(tenantId, rows.map(shape));

  return {
    appointment: appointment ? toAppointmentDTO(appointment) : null,
    queue: queue.map(toAppointmentDTO),
    scope,
    fallback,
    timezone,
    hours,
    now: now.toISOString(),
  };
}

// ── Free slots ───────────────────────────────────────────────────────────────

/** The live bookings of the doctor and/or the room that touch the day. */
async function takenOn(tenantId: string, dayStart: Date, dayEnd: Date, q: FreeSlotsFilter): Promise<TakenRange[]> {
  const rows = await db.appointment.findMany({
    where: {
      tenantId,
      ...notDeleted,
      ...(q.excludeId ? { id: { not: q.excludeId } } : {}),
      status: { notIn: [...NON_BLOCKING_STATUSES] },
      startsAt: { lte: dayEnd },
      endsAt: { gt: dayStart },
      OR: [...(q.doctorId ? [{ doctorId: q.doctorId }] : []), ...(q.room ? [{ room: q.room }] : [])],
    },
    orderBy: { startsAt: "asc" },
    take: 200,
    select: { id: true, startsAt: true, endsAt: true, status: true, doctorId: true, room: true, patientId: true, patient: patientSelect },
  });
  return rows.map((r) => ({
    id: r.id,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    status: r.status,
    doctorId: r.doctorId,
    room: r.room,
    patientId: r.patientId,
    patientName: r.patient.fullName,
    patientInitials: initialsOf(r.patient.fullName),
  }));
}

function cellDTO(c: SlotCell): SlotCellDTO {
  return {
    startsAt: c.startsAt.toISOString(),
    endsAt: c.endsAt.toISOString(),
    free: c.free,
    past: c.past,
    takenBy: c.takenBy.map((t) => ({
      id: t.id,
      startsAt: t.startsAt.toISOString(),
      endsAt: t.endsAt.toISOString(),
      status: t.status,
      doctorId: t.doctorId,
      room: t.room,
      patientInitials: t.patientInitials,
      patientName: t.patientName,
    })),
  };
}

/**
 * The free start times of one clinic day on the 15-minute grid, inside the
 * tenant's working hours (`hours` setting; Saturday–Thursday 10:00–20:00 by
 * default, Friday closed), clear of the doctor's and the room's live bookings,
 * plus the next three free starts after `after` — looking up to a week ahead
 * when the day is full, so a refused booking always has an alternative.
 */
export async function findFreeSlots(tenantId: string, rawQuery: unknown, now: Date = new Date()): Promise<FreeSlotsDTO> {
  const q = FreeSlotsQuery.parse(rawQuery);
  if (q.doctorId) await requireTenantUser(tenantId, q.doctorId);
  const [timezone, hours] = await Promise.all([getTenantTimezone(tenantId), getWorkingHours(tenantId)]);
  const day = fromDateKey(q.date, timezone) ?? startOfDayInTz(now, timezone);

  const gridFor = async (d: Date) => {
    if (!hours.days.includes(zonedParts(d, timezone).weekday)) return { closed: true, cells: [] as SlotCell[] };
    const taken = await takenOn(tenantId, startOfDayInTz(d, timezone), endOfDayInTz(d, timezone), q);
    return buildSlotGrid({ day: d, timeZone: timezone, hours, durationMinutes: q.duration, stepMinutes: SLOT_STEP_MINUTES, taken, notBefore: now });
  };

  const grid = await gridFor(day);
  const after = q.after ?? now;
  let suggestions = freeCellsAfter(grid.cells, after, 3);
  let probe = day;
  for (let i = 0; suggestions.length < 3 && i < 6; i++) {
    probe = addDays(probe, 1, timezone);
    const next = await gridFor(probe);
    if (next.closed) continue;
    suggestions = [...suggestions, ...freeCellsAfter(next.cells, after, 3 - suggestions.length)];
  }

  return {
    date: q.date,
    timezone,
    hours,
    closed: grid.closed,
    stepMinutes: SLOT_STEP_MINUTES,
    durationMinutes: q.duration,
    slots: grid.cells.map(cellDTO),
    free: grid.cells.filter((c) => c.free).map((c) => c.startsAt.toISOString()),
    suggestions: suggestions.map((c) => ({ startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString(), date: dateKeyInTz(c.startsAt, timezone) })),
  };
}
