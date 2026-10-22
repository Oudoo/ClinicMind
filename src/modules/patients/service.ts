import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { parsePaging, zDate, zOptionalText, zPhone, zText } from "@/lib/validation";

/**
 * Patient module: registry CRUD, soft archive, medical history and the
 * aggregated record behind /dashboard/patients/[id].
 *
 * Every query is scoped by `tenantId`, so a foreign-tenant id behaves exactly
 * like a missing one (`null` here, 404 at the route). Every mutation writes an
 * audit row with before/after snapshots, and a `TimelineEvent` when the change
 * is clinical (a new diagnosis); profile edits leave the timeline alone.
 */

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

// ── Input schemas ─────────────────────────────────────────────────────────────

export const GENDERS = ["MALE", "FEMALE", "OTHER", "UNDISCLOSED"] as const;
export const LANGUAGES = ["ar", "en"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

/** Date-only date of birth that is not in the future. */
const zDateOfBirth = zDate.refine((d) => d.getTime() <= Date.now(), "Date of birth cannot be in the future");

const zEmail = z.string().trim().toLowerCase().max(254).email("Invalid e-mail address");

/**
 * Trim, drop blanks and de-duplicate (case-insensitively, keeping the first
 * spelling). Shared by tags and the medical history lists.
 */
export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, " ");
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

const zStringList = (maxItems: number, maxLength: number) =>
  z
    .array(z.string().trim().max(maxLength, `Each entry must be at most ${maxLength} characters`))
    .max(maxItems, `At most ${maxItems} entries`)
    .transform(dedupeStrings);

/** On a partial update a blank or `null` clears the column; absent leaves it. */
const clearable = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(blankToNull, schema.nullable().optional());

const zFullName = zText(120).min(1, "Full name is required");
const zTags = zStringList(10, 30);

export const PatientInput = z.object({
  fullName: zFullName,
  gender: z.enum(GENDERS).default("UNDISCLOSED"),
  dateOfBirth: z.preprocess(blankToUndefined, zDateOfBirth.optional()),
  phone: z.preprocess(blankToUndefined, zPhone.optional()),
  whatsapp: z.preprocess(blankToUndefined, zPhone.optional()),
  email: z.preprocess(blankToUndefined, zEmail.optional()),
  emergencyContact: zOptionalText(200),
  address: zOptionalText(300),
  language: z.enum(LANGUAGES).default("ar"),
  tags: zTags.default([]),
  notes: zOptionalText(2000),
});
export type PatientInput = z.input<typeof PatientInput>;

export const PatientUpdateInput = z.object({
  fullName: zFullName.optional(),
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: clearable(zDateOfBirth),
  phone: clearable(zPhone),
  whatsapp: clearable(zPhone),
  email: clearable(zEmail),
  emergencyContact: clearable(zText(200)),
  address: clearable(zText(300)),
  language: z.enum(LANGUAGES).optional(),
  tags: zTags.optional(),
  notes: clearable(zText(2000)),
});
export type PatientUpdateInput = z.input<typeof PatientUpdateInput>;

const zHistoryList = zStringList(50, 120);

export const MedicalHistoryInput = z.object({
  chronicConditions: zHistoryList.optional(),
  allergies: zHistoryList.optional(),
  surgeries: zHistoryList.optional(),
  diagnoses: zHistoryList.optional(),
});
export type MedicalHistoryInput = z.input<typeof MedicalHistoryInput>;

export const HISTORY_KEYS = ["chronicConditions", "allergies", "surgeries", "diagnoses"] as const;
export type HistoryKey = (typeof HISTORY_KEYS)[number];
export type HistoryLists = Record<HistoryKey, string[]>;

/** The medical history JSON columns as string lists (anything else is ignored). */
export function historyLists(history: Partial<Record<HistoryKey, unknown>> | null | undefined): HistoryLists {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    chronicConditions: list(history?.chronicConditions),
    allergies: list(history?.allergies),
    surgeries: list(history?.surgeries),
    diagnoses: list(history?.diagnoses),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROFILE_KEYS = [
  "fullName",
  "gender",
  "dateOfBirth",
  "phone",
  "whatsapp",
  "email",
  "emergencyContact",
  "address",
  "language",
  "tags",
  "notes",
] as const;
type ProfileKey = (typeof PROFILE_KEYS)[number];

/** JSON-safe audit snapshot of the profile columns (dates as ISO strings). */
function snapshot(patient: Record<ProfileKey, unknown>, keys: readonly ProfileKey[] = PROFILE_KEYS) {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = patient[key];
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/** Drop `undefined` entries so a partial update only touches the fields sent. */
function definedEntries<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Prisma's "record not found" for a scoped `update` whose filters matched nothing. */
function isNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";
}

// ── Listing & search ──────────────────────────────────────────────────────────

export interface ListPatientsOptions {
  /** Case-insensitive match on name or e-mail; digits also match phone / WhatsApp. */
  q?: string;
  page?: number;
  pageSize?: number;
  /** Only patients carrying this tag. */
  tag?: string;
  /** Include archived (soft-deleted) patients alongside active ones. */
  includeArchived?: boolean;
}

function patientsWhere(tenantId: string, opts: ListPatientsOptions): Prisma.PatientWhereInput {
  const q = opts.q?.trim().slice(0, 100);
  const digits = q?.replace(/[\s()+-]/g, "");
  const tag = opts.tag?.trim().slice(0, 30);
  const search: Prisma.PatientWhereInput[] = [];
  if (q) {
    search.push(
      { fullName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
    );
    if (digits && /^\d{3,}$/.test(digits)) {
      search.push({ phone: { contains: digits } }, { whatsapp: { contains: digits } });
    }
  }
  return {
    tenantId,
    ...(opts.includeArchived ? {} : notDeleted),
    ...(tag ? { tags: { has: tag } } : {}),
    ...(search.length ? { OR: search } : {}),
  };
}

async function queryPatients(tenantId: string, opts: ListPatientsOptions) {
  // Reuse the request-level paging bounds (default 25, max 100) whoever calls.
  const params = new URLSearchParams();
  if (opts.page !== undefined) params.set("page", String(opts.page));
  if (opts.pageSize !== undefined) params.set("pageSize", String(opts.pageSize));
  const { page, pageSize, skip, take } = parsePaging(params);
  const where = patientsWhere(tenantId, opts);
  const [patients, total] = await db.$transaction([
    db.patient.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take,
      include: {
        medicalHistory: true,
        _count: { select: { appointments: true, visits: true } },
      },
    }),
    db.patient.count({ where }),
  ]);
  return { patients, total, page, pageSize };
}

export type PatientPage = Awaited<ReturnType<typeof queryPatients>>;
export type PatientListItem = PatientPage["patients"][number];

/**
 * Paginated, searchable registry of the tenant's patients, newest first.
 *
 * The legacy form `listPatients(tenantId, search?)` returns the first 100
 * matches as a bare array and is kept for existing callers (the consultation
 * page); new code passes an options object and receives the page envelope.
 */
export function listPatients(tenantId: string, search?: string): Promise<PatientListItem[]>;
export function listPatients(tenantId: string, options: ListPatientsOptions): Promise<PatientPage>;
export async function listPatients(
  tenantId: string,
  arg?: string | ListPatientsOptions,
): Promise<PatientListItem[] | PatientPage> {
  if (arg === undefined || typeof arg === "string") {
    const { patients } = await queryPatients(tenantId, { q: arg, pageSize: 100 });
    return patients;
  }
  return queryPatients(tenantId, arg);
}

// ── Patient record ────────────────────────────────────────────────────────────

/**
 * The full record for the patient page: profile, medical history, medications
 * (active first), the latest 100 timeline events, the latest 20 visits (with
 * the doctor), the latest 20 consultations and the next 10 appointments.
 * Archived patients are returned too (with `deletedAt` set) so they can be
 * reviewed and restored; `null` when the id is not in the tenant.
 */
export async function getPatient(tenantId: string, id: string) {
  const now = new Date();
  const patient = await db.patient.findFirst({
    where: { id, tenantId },
    include: {
      medicalHistory: true,
      _count: { select: { appointments: true, visits: true, documents: true, timeline: true } },
      medications: {
        where: { tenantId },
        orderBy: [{ active: "desc" }, { startDate: "desc" }, { createdAt: "desc" }],
      },
      timeline: { where: { tenantId }, orderBy: { occurredAt: "desc" }, take: 100 },
      visits: {
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          doctor: { select: { id: true, fullName: true, email: true } },
          consultation: { select: { id: true, status: true } },
        },
      },
      consultations: {
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: {
          id: true,
          status: true,
          summary: true,
          visitId: true,
          doctorId: true,
          reviewedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      appointments: {
        where: {
          tenantId,
          ...notDeleted,
          startsAt: { gte: now },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
        orderBy: { startsAt: "asc" },
        take: 10,
        include: { clinic: { select: { id: true, name: true } } },
      },
    },
  });
  if (!patient) return null;

  // Appointments and consultations carry a bare doctorId; resolve the names
  // in one tenant-scoped lookup so the UI never has to.
  const doctorIds = new Set<string>();
  for (const a of patient.appointments) if (a.doctorId) doctorIds.add(a.doctorId);
  for (const c of patient.consultations) if (c.doctorId) doctorIds.add(c.doctorId);
  const doctors = doctorIds.size
    ? await db.user.findMany({
        where: { id: { in: [...doctorIds] }, tenantId },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const doctorById = new Map(doctors.map((d) => [d.id, d]));
  const doctorFor = (doctorId: string | null) => (doctorId ? (doctorById.get(doctorId) ?? null) : null);

  const { appointments, consultations, ...profile } = patient;
  return {
    ...profile,
    consultations: consultations.map((c) => ({ ...c, doctor: doctorFor(c.doctorId) })),
    upcomingAppointments: appointments.map((a) => ({ ...a, doctor: doctorFor(a.doctorId) })),
  };
}

export type PatientDetail = NonNullable<Awaited<ReturnType<typeof getPatient>>>;

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createPatient(tenantId: string, input: unknown, actor: Actor = {}) {
  const data = PatientInput.parse(input);
  const patient = await db.patient.create({
    data: {
      tenantId,
      fullName: data.fullName,
      gender: data.gender,
      dateOfBirth: data.dateOfBirth ?? null,
      phone: data.phone ?? null,
      whatsapp: data.whatsapp ?? null,
      email: data.email ?? null,
      emergencyContact: data.emergencyContact ?? null,
      address: data.address ?? null,
      language: data.language,
      tags: data.tags,
      notes: data.notes ?? null,
      medicalHistory: { create: { tenantId } },
    },
    include: { medicalHistory: true },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.create",
    entity: "Patient",
    entityId: patient.id,
    after: snapshot(patient),
  });
  return patient;
}

/**
 * Partial profile update. Only the fields present in `input` change; a blank
 * or `null` clears an optional field. Archived patients must be restored
 * first. Returns `null` when the patient is not an active member of the tenant.
 */
export async function updatePatient(tenantId: string, id: string, input: unknown, actor: Actor = {}) {
  const patch = definedEntries(PatientUpdateInput.parse(input));
  const keys = Object.keys(patch) as ProfileKey[];

  const existing = await db.patient.findFirst({ where: { id, tenantId, ...notDeleted } });
  if (!existing) return null;
  if (keys.length === 0) return existing;

  let patient;
  try {
    patient = await db.patient.update({ where: { id, tenantId, ...notDeleted }, data: patch });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.update",
    entity: "Patient",
    entityId: patient.id,
    before: snapshot(existing, keys),
    after: snapshot(patient, keys),
  });
  return patient;
}

/**
 * Soft delete: the patient disappears from listings and from every write path
 * (`requireTenantPatient`) but keeps its history. Nothing else is cancelled.
 */
export async function archivePatient(tenantId: string, id: string, actor: Actor = {}) {
  const existing = await db.patient.findFirst({ where: { id, tenantId, ...notDeleted } });
  if (!existing) return null;

  let patient;
  try {
    patient = await db.patient.update({
      where: { id, tenantId, ...notDeleted },
      data: { deletedAt: new Date() },
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.archive",
    entity: "Patient",
    entityId: patient.id,
    before: { fullName: existing.fullName, deletedAt: null },
    after: { fullName: patient.fullName, deletedAt: patient.deletedAt?.toISOString() ?? null },
  });
  return patient;
}

export async function restorePatient(tenantId: string, id: string, actor: Actor = {}) {
  const existing = await db.patient.findFirst({ where: { id, tenantId, deletedAt: { not: null } } });
  if (!existing) return null;

  let patient;
  try {
    patient = await db.patient.update({
      where: { id, tenantId, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.restore",
    entity: "Patient",
    entityId: patient.id,
    before: { fullName: existing.fullName, deletedAt: existing.deletedAt?.toISOString() ?? null },
    after: { fullName: patient.fullName, deletedAt: null },
  });
  return patient;
}

/**
 * Replace the medical history lists that are present in `input` (trimmed and
 * de-duplicated). A diagnosis that was not on the list before is also recorded
 * on the timeline as a DIAGNOSIS event, so the clinical feed stays complete.
 * Returns `null` when the patient is not an active member of the tenant.
 */
export async function updateMedicalHistory(tenantId: string, patientId: string, input: unknown, actor: Actor = {}) {
  const patch = definedEntries(MedicalHistoryInput.parse(input));

  const patient = await db.patient.findFirst({
    where: { id: patientId, tenantId, ...notDeleted },
    select: { id: true, medicalHistory: true },
  });
  if (!patient) return null;

  const before = historyLists(patient.medicalHistory);
  const after: HistoryLists = { ...before, ...patch };
  const known = new Set(before.diagnoses.map((d) => d.toLowerCase()));
  const newDiagnoses = after.diagnoses.filter((d) => !known.has(d.toLowerCase()));
  const now = new Date();

  const history = await db.$transaction(async (tx) => {
    // The patient was proven to belong to the tenant above; the history row is
    // 1:1 with it and the unique lookup is scoped again for good measure.
    const row = await tx.medicalHistory.upsert({
      where: { patientId: patient.id, tenantId },
      create: { tenantId, patientId: patient.id, ...after },
      update: patch,
    });
    if (newDiagnoses.length) {
      await tx.timelineEvent.createMany({
        data: newDiagnoses.map((title) => ({
          tenantId,
          patientId: patient.id,
          kind: "DIAGNOSIS" as const,
          title,
          body: "Added to the medical history",
          refId: row.id,
          occurredAt: now,
        })),
      });
    }
    return row;
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.history.update",
    entity: "MedicalHistory",
    entityId: history.id,
    before,
    after,
  });
  return history;
}
