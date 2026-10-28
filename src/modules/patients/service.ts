import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ingestInBackground } from "@/modules/knowledge/ingest";
import { parsePaging, zDate, zOptionalText, zPhone, zText } from "@/lib/validation";
import { endOfDayInTz, fromDateKey, startOfWeekInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import {
  AGE_BANDS,
  DEFAULT_SORT,
  type AgeBandKey,
  type GenderKey,
  type LanguageKey,
  type PatientListQuery,
  type SortKey,
  type SourceKey,
  type UpcomingKey,
  type VisitWindowKey,
} from "@/modules/patients/filters";
import { digitsOnly, isNumericQuery, normalizeDigits, normalizeNationalId, phoneVariants } from "@/modules/patients/search";

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

/** Nobody on the registry is older than this. */
export const MAX_AGE_YEARS = 120;

/** Date-only date of birth: not in the future and not more than 120 years ago. */
const zDateOfBirth = zDate
  .refine((d) => d.getTime() <= Date.now(), "Date of birth cannot be in the future")
  .refine((d) => d.getTime() >= yearsBefore(new Date(), MAX_AGE_YEARS).getTime(), `Date of birth cannot be more than ${MAX_AGE_YEARS} years ago`);

const zEmail = z.string().trim().toLowerCase().max(254).email("Invalid e-mail address");

/** Phones may be typed with Arabic-Indic digits; they are converted before the E.164-ish check. */
const zPhoneAnyDigits = z.preprocess((v) => (typeof v === "string" ? normalizeDigits(v) : v), zPhone);
/** National id or passport number, digits normalised, at most 40 characters. */
const zNationalId = z.preprocess((v) => (typeof v === "string" ? normalizeNationalId(v) : v), zText(40));
const zCity = zText(80);

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
  phone: z.preprocess(blankToUndefined, zPhoneAnyDigits.optional()),
  whatsapp: z.preprocess(blankToUndefined, zPhoneAnyDigits.optional()),
  email: z.preprocess(blankToUndefined, zEmail.optional()),
  nationalId: z.preprocess(blankToUndefined, zNationalId.optional()),
  city: z.preprocess(blankToUndefined, zCity.optional()),
  emergencyContact: zOptionalText(200),
  address: zOptionalText(300),
  language: z.enum(LANGUAGES).default("ar"),
  tags: zTags.default([]),
  notes: zOptionalText(2000),
  /** Save even though the phone, WhatsApp or national id already belongs to another patient (409 otherwise). */
  confirmDuplicate: z.boolean().default(false),
});
export type PatientInput = z.input<typeof PatientInput>;

export const PatientUpdateInput = z.object({
  fullName: zFullName.optional(),
  gender: z.enum(GENDERS).optional(),
  dateOfBirth: clearable(zDateOfBirth),
  phone: clearable(zPhoneAnyDigits),
  whatsapp: clearable(zPhoneAnyDigits),
  email: clearable(zEmail),
  nationalId: clearable(zNationalId),
  city: clearable(zCity),
  emergencyContact: clearable(zText(200)),
  address: clearable(zText(300)),
  language: z.enum(LANGUAGES).optional(),
  tags: zTags.optional(),
  notes: clearable(zText(2000)),
  /** Save even though a changed phone, WhatsApp or national id belongs to another patient (409 otherwise). */
  confirmDuplicate: z.boolean().optional(),
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
  "nationalId",
  "city",
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

// ── Duplicates ────────────────────────────────────────────────────────────────

export type DuplicateField = "phone" | "whatsapp" | "nationalId";

export interface DuplicateMatch {
  id: string;
  fullName: string;
  /** Which of the submitted values matched this patient. */
  field: DuplicateField;
}

/**
 * The phone, WhatsApp number or national id of a new (or edited) patient
 * already belongs to another active patient of the tenant (409). The caller
 * may save anyway with `confirmDuplicate: true`.
 */
export class DuplicatePatientError extends Error {
  readonly status = 409;
  constructor(
    readonly code: "duplicate_phone" | "duplicate_national_id",
    readonly matches: DuplicateMatch[],
  ) {
    const first = matches.find((m) => (code === "duplicate_national_id" ? m.field === "nationalId" : m.field !== "nationalId"));
    super(
      code === "duplicate_national_id"
        ? `This national ID belongs to ${first?.fullName ?? "another patient"}.`
        : `This number belongs to ${first?.fullName ?? "another patient"}.`,
    );
    this.name = "DuplicatePatientError";
  }
}

/**
 * Active (not archived) patients of the tenant that already carry one of the
 * given numbers, in any spelling (`+2010…`, `010…`, `0020…`, Arabic-Indic
 * digits: the same normaliser the search box uses), or the same national id.
 * At most five per field, oldest record first.
 */
export async function findDuplicatePatients(
  tenantId: string,
  values: { phone?: string | null; whatsapp?: string | null; nationalId?: string | null },
  excludeId?: string,
): Promise<DuplicateMatch[]> {
  const base: Prisma.PatientWhereInput = { tenantId, ...notDeleted, ...(excludeId ? { id: { not: excludeId } } : {}) };
  const select = { id: true, fullName: true } as const;
  const matches: DuplicateMatch[] = [];
  const add = (rows: { id: string; fullName: string }[], field: DuplicateField) => {
    for (const r of rows) {
      // One phone typed into both boxes names its owner once, under the phone.
      if (field === "whatsapp" && matches.some((m) => m.id === r.id && m.field === "phone")) continue;
      matches.push({ id: r.id, fullName: r.fullName, field });
    }
  };
  for (const field of ["phone", "whatsapp"] as const) {
    const value = values[field];
    const variants = value ? phoneVariants(value) : [];
    if (!variants.length) continue;
    const rows = await db.patient.findMany({
      where: { ...base, OR: [{ phone: { in: variants } }, { whatsapp: { in: variants } }] },
      select,
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    add(rows, field);
  }
  const nationalId = values.nationalId ? normalizeNationalId(values.nationalId) : "";
  if (nationalId) {
    const rows = await db.patient.findMany({
      where: { ...base, nationalId: { equals: nationalId, mode: "insensitive" } },
      select,
      orderBy: { createdAt: "asc" },
      take: 5,
    });
    add(rows, "nationalId");
  }
  return matches;
}

/** Refuse duplicates unless confirmed; returns the ids that were confirmed on purpose (for the audit). */
async function guardDuplicates(
  tenantId: string,
  values: { phone?: string | null; whatsapp?: string | null; nationalId?: string | null },
  confirmed: boolean,
  excludeId?: string,
): Promise<string[]> {
  if (!values.phone && !values.whatsapp && !values.nationalId) return [];
  const matches = await findDuplicatePatients(tenantId, values, excludeId);
  if (!matches.length) return [];
  if (!confirmed) {
    throw new DuplicatePatientError(matches.some((m) => m.field === "nationalId") ? "duplicate_national_id" : "duplicate_phone", matches);
  }
  return [...new Set(matches.map((m) => m.id))];
}

// ── Listing & search ──────────────────────────────────────────────────────────

export type ArchivedMode = "active" | "include" | "only";

export interface ListPatientsOptions {
  /** Case-insensitive match on name or e-mail; digits (Arabic-Indic too) also match phone, WhatsApp and national id. */
  q?: string;
  page?: number;
  pageSize?: number;
  /** Only patients carrying this tag. */
  tag?: string;
  /** Legacy switch; prefer `archived: "include"`. */
  includeArchived?: boolean;
  archived?: ArchivedMode;
  gender?: GenderKey;
  ageBand?: AgeBandKey;
  /** Patients with an upcoming appointment or a past visit with this doctor. */
  doctorId?: string;
  upcoming?: UpcomingKey;
  lastVisit?: VisitWindowKey;
  registeredFrom?: Date;
  registeredTo?: Date;
  language?: LanguageKey;
  source?: SourceKey;
  sort?: SortKey;
  /** The clock the relative windows (age, "within 30 days", "upcoming") are measured against. */
  now?: Date;
}

const DAY_MS = 86_400_000;
/** The whole result is ordered in memory for the aggregate sorts and the exact-match-first rule; beyond this many rows the count is estimated separately. */
const SORT_SCAN_CAP = 5000;
const EXPORT_CAP = 5000;

const listInclude = {
  medicalHistory: true,
  _count: { select: { appointments: true, visits: true } },
} satisfies Prisma.PatientInclude;

export type PatientListItem = Prisma.PatientGetPayload<{ include: typeof listInclude }>;

/** A list row with the per-patient activity the registry shows and sorts by. */
export interface PatientListRow extends PatientListItem {
  lastVisitAt: Date | null;
  nextAppointmentAt: Date | null;
  upcomingCount: number;
  /** The search text matched this row's phone, WhatsApp or national id exactly. */
  exact: boolean;
}

export interface PatientPage {
  patients: PatientListRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Live bookings from `now` on (optionally before `until`); cancelled and no-show ones do not count. */
function upcomingAppointmentWhere(tenantId: string, now: Date, until?: Date): Prisma.AppointmentWhereInput {
  return {
    tenantId,
    ...notDeleted,
    startsAt: until ? { gte: now, lt: until } : { gte: now },
    status: { notIn: ["CANCELLED", "NO_SHOW"] },
  };
}

/** Midnight UTC `years` before `now` (dates of birth are stored at UTC midnight). */
function yearsBefore(now: Date, years: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
}

/** age ≥ min ⇔ dob ≤ now − min years; age ≤ max ⇔ dob > now − (max + 1) years. */
function ageBandWhere(band: AgeBandKey, now: Date): Prisma.DateTimeNullableFilter {
  const def = AGE_BANDS.find((b) => b.key === band) ?? AGE_BANDS[0];
  return {
    lte: yearsBefore(now, def.min),
    ...(def.max !== null ? { gt: yearsBefore(now, def.max + 1) } : {}),
  };
}

interface SearchClauses {
  /** Broad `contains` matches, OR-ed together. */
  search: Prisma.PatientWhereInput[];
  /** Exact phone / WhatsApp / national id matches that are listed first. */
  exact: Prisma.PatientWhereInput | null;
}

function searchClauses(raw: string | undefined): SearchClauses {
  const q = normalizeDigits(raw?.trim() ?? "").slice(0, 100);
  if (!q) return { search: [], exact: null };
  const search: Prisma.PatientWhereInput[] = [
    { fullName: { contains: q, mode: "insensitive" } },
    { email: { contains: q, mode: "insensitive" } },
  ];
  const exact: Prisma.PatientWhereInput[] = [];
  if (isNumericQuery(q)) {
    const digits = digitsOnly(q);
    search.push({ phone: { contains: digits } }, { whatsapp: { contains: digits } }, { nationalId: { contains: digits } });
    const variants = phoneVariants(q);
    if (variants.length) exact.push({ phone: { in: variants } }, { whatsapp: { in: variants } });
    if (digits.length >= 6) exact.push({ nationalId: digits });
  } else {
    search.push({ nationalId: { contains: q, mode: "insensitive" } });
    if (/^[A-Za-z0-9/-]{6,40}$/.test(q)) exact.push({ nationalId: { equals: q, mode: "insensitive" } });
  }
  // An exact spelling must also *find* the row, not only rank it: "+20 10…"
  // typed at the desk shares no substring with a phone stored as "010…".
  search.push(...exact);
  return { search, exact: exact.length ? { OR: exact } : null };
}

function patientsWhere(
  tenantId: string,
  opts: ListPatientsOptions,
): { where: Prisma.PatientWhereInput; exact: Prisma.PatientWhereInput | null } {
  const now = opts.now ?? new Date();
  const archived: ArchivedMode = opts.archived ?? (opts.includeArchived ? "include" : "active");
  const { search, exact } = searchClauses(opts.q);
  const and: Prisma.PatientWhereInput[] = [];
  if (search.length) and.push({ OR: search });

  const tag = opts.tag?.trim().slice(0, 30);
  if (tag) and.push({ tags: { has: tag } });
  if (opts.gender) and.push({ gender: opts.gender });
  if (opts.language) and.push({ language: opts.language });
  if (opts.source) and.push({ source: opts.source });
  if (opts.ageBand) and.push({ dateOfBirth: ageBandWhere(opts.ageBand, now) });

  const doctorId = opts.doctorId?.trim().slice(0, 64);
  if (doctorId) {
    and.push({
      OR: [
        { appointments: { some: { ...upcomingAppointmentWhere(tenantId, now), doctorId } } },
        { visits: { some: { tenantId, doctorId } } },
      ],
    });
  }

  if (opts.upcoming === "yes") and.push({ appointments: { some: upcomingAppointmentWhere(tenantId, now) } });
  if (opts.upcoming === "no") and.push({ appointments: { none: upcomingAppointmentWhere(tenantId, now) } });
  if (opts.upcoming === "week") {
    and.push({ appointments: { some: upcomingAppointmentWhere(tenantId, now, new Date(now.getTime() + 7 * DAY_MS)) } });
  }

  if (opts.lastVisit) {
    const since = (days: number) => new Date(now.getTime() - days * DAY_MS);
    switch (opts.lastVisit) {
      case "30":
      case "90":
      case "180":
        and.push({ visits: { some: { tenantId, createdAt: { gte: since(Number(opts.lastVisit)) } } } });
        break;
      case "over180":
        and.push({ visits: { some: { tenantId } } }, { visits: { none: { tenantId, createdAt: { gte: since(180) } } } });
        break;
      case "never":
        and.push({ visits: { none: { tenantId } } });
        break;
    }
  }

  if (opts.registeredFrom || opts.registeredTo) {
    and.push({
      createdAt: {
        ...(opts.registeredFrom ? { gte: opts.registeredFrom } : {}),
        ...(opts.registeredTo ? { lte: opts.registeredTo } : {}),
      },
    });
  }

  const where: Prisma.PatientWhereInput = {
    tenantId,
    ...(archived === "active" ? notDeleted : archived === "only" ? { deletedAt: { not: null } } : {}),
    ...(and.length ? { AND: and } : {}),
  };
  return { where, exact };
}

function orderFor(sort: SortKey): Prisma.PatientOrderByWithRelationInput[] {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" }, { id: "asc" }];
    case "name_asc":
      return [{ fullName: "asc" }, { id: "asc" }];
    case "name_desc":
      return [{ fullName: "desc" }, { id: "desc" }];
    case "age_desc":
      return [{ dateOfBirth: { sort: "asc", nulls: "last" } }, { id: "asc" }];
    case "age_asc":
      return [{ dateOfBirth: { sort: "desc", nulls: "last" } }, { id: "asc" }];
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

/** Most recent visit per patient. */
async function lastVisitByPatient(tenantId: string, ids: readonly string[]): Promise<Map<string, Date>> {
  if (!ids.length) return new Map();
  const rows = await db.visit.groupBy({
    by: ["patientId"],
    where: { tenantId, patientId: { in: [...ids] } },
    _max: { createdAt: true },
  });
  return new Map(rows.flatMap((r) => (r._max.createdAt ? [[r.patientId, r._max.createdAt] as const] : [])));
}

/** Soonest upcoming appointment and how many are booked, per patient. */
async function upcomingByPatient(
  tenantId: string,
  ids: readonly string[],
  now: Date,
): Promise<Map<string, { next: Date; count: number }>> {
  if (!ids.length) return new Map();
  const rows = await db.appointment.groupBy({
    by: ["patientId"],
    where: { patientId: { in: [...ids] }, ...upcomingAppointmentWhere(tenantId, now) },
    _min: { startsAt: true },
    _count: { _all: true },
  });
  return new Map(
    rows.flatMap((r) => (r._min.startsAt ? [[r.patientId, { next: r._min.startsAt, count: r._count._all }] as const] : [])),
  );
}

/** The last page that has rows (1 for an empty result). */
function lastPage(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Stable sort of ids by a per-id instant: present values first in the given direction, missing ones keep their order at the end. */
function sortIdsBy(ids: string[], at: (id: string) => Date | undefined, direction: "asc" | "desc"): string[] {
  const indexed = ids.map((id, index) => ({ id, index, t: at(id)?.getTime() }));
  indexed.sort((a, b) => {
    if (a.t === undefined && b.t === undefined) return a.index - b.index;
    if (a.t === undefined) return 1;
    if (b.t === undefined) return -1;
    if (a.t !== b.t) return direction === "asc" ? a.t - b.t : b.t - a.t;
    return a.index - b.index;
  });
  return indexed.map((x) => x.id);
}

async function queryPatients(
  tenantId: string,
  opts: ListPatientsOptions,
  limits = { pageSize: 25, maxPageSize: 100 },
): Promise<PatientPage> {
  // Reuse the request-level paging bounds (default 25, max 100) whoever calls.
  const params = new URLSearchParams();
  if (opts.page !== undefined) params.set("page", String(opts.page));
  if (opts.pageSize !== undefined) params.set("pageSize", String(opts.pageSize));
  const { page: requestedPage, pageSize, skip, take } = parsePaging(params, limits);
  const now = opts.now ?? new Date();
  const sort: SortKey = opts.sort ?? DEFAULT_SORT;
  const { where, exact } = patientsWhere(tenantId, opts);
  const aggregateSort = sort === "last_visit" || sort === "next_appointment";

  let rows: PatientListItem[];
  let total: number;
  let exactIds = new Set<string>();

  let page = requestedPage;
  if (!exact && !aggregateSort) {
    [rows, total] = await db.$transaction([
      db.patient.findMany({ where, orderBy: orderFor(sort), skip, take, include: listInclude }),
      db.patient.count({ where }),
    ]);
    // A page past the end (a stale link, ?page=99) shows the last page instead of an empty list.
    const last = lastPage(total, pageSize);
    if (!rows.length && page > last) {
      page = last;
      rows = await db.patient.findMany({ where, orderBy: orderFor(sort), skip: (page - 1) * pageSize, take, include: listInclude });
    }
  } else {
    // Order the ids of the whole result (exact matches first, aggregate sorts
    // in memory), then fetch just the page. Clinic registries are thousands
    // of rows at most, so the id scan is cheap and the count stays exact.
    const idRows = await db.patient.findMany({
      where,
      select: { id: true },
      orderBy: orderFor(aggregateSort ? DEFAULT_SORT : sort),
      take: SORT_SCAN_CAP,
    });
    let ids = idRows.map((r) => r.id);
    total = ids.length < SORT_SCAN_CAP ? ids.length : await db.patient.count({ where });
    if (sort === "last_visit") {
      const lastVisits = await lastVisitByPatient(tenantId, ids);
      ids = sortIdsBy(ids, (id) => lastVisits.get(id), "desc");
    } else if (sort === "next_appointment") {
      const upcoming = await upcomingByPatient(tenantId, ids, now);
      ids = sortIdsBy(ids, (id) => upcoming.get(id)?.next, "asc");
    }
    if (exact) {
      const hits = await db.patient.findMany({ where: { AND: [where, exact] }, select: { id: true }, take: 100 });
      exactIds = new Set(hits.map((h) => h.id));
      if (exactIds.size) ids = [...ids.filter((id) => exactIds.has(id)), ...ids.filter((id) => !exactIds.has(id))];
    }
    // Past the end (?page=99): the last page that has rows.
    page = Math.min(page, lastPage(ids.length, pageSize));
    const from = (page - 1) * pageSize;
    const pageIds = ids.slice(from, from + take);
    const fetched = pageIds.length
      ? await db.patient.findMany({ where: { tenantId, id: { in: pageIds } }, include: listInclude })
      : [];
    const byId = new Map(fetched.map((p) => [p.id, p]));
    rows = pageIds.flatMap((id) => {
      const p = byId.get(id);
      return p ? [p] : [];
    });
  }

  const pageIds = rows.map((r) => r.id);
  const [lastVisits, upcoming] = await Promise.all([
    lastVisitByPatient(tenantId, pageIds),
    upcomingByPatient(tenantId, pageIds, now),
  ]);
  const patients: PatientListRow[] = rows.map((p) => ({
    ...p,
    lastVisitAt: lastVisits.get(p.id) ?? null,
    nextAppointmentAt: upcoming.get(p.id)?.next ?? null,
    upcomingCount: upcoming.get(p.id)?.count ?? 0,
    exact: exactIds.has(p.id),
  }));
  return { patients, total, page, pageSize };
}

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

/** The whole filtered set (up to 5,000 rows) for the CSV export. */
export async function listPatientsForExport(tenantId: string, opts: ListPatientsOptions): Promise<PatientPage> {
  return queryPatients(
    tenantId,
    { ...opts, page: 1, pageSize: EXPORT_CAP },
    { pageSize: EXPORT_CAP, maxPageSize: EXPORT_CAP },
  );
}

/** Start of the clinic's current week / month / quarter, or the custom bounds, as instants. */
function registeredRange(query: PatientListQuery, timezone: string, now: Date): { from?: Date; to?: Date } | null {
  switch (query.reg) {
    case "week":
      return { from: startOfWeekInTz(now, timezone), to: now };
    case "month": {
      const p = zonedParts(now, timezone);
      return { from: zonedTimeToUtc({ year: p.year, month: p.month, day: 1 }, timezone), to: now };
    }
    case "quarter": {
      const p = zonedParts(now, timezone);
      const month = Math.floor((p.month - 1) / 3) * 3 + 1;
      return { from: zonedTimeToUtc({ year: p.year, month, day: 1 }, timezone), to: now };
    }
    case "custom": {
      const from = query.from ? fromDateKey(query.from, timezone) : null;
      const to = query.to ? fromDateKey(query.to, timezone) : null;
      if (!from && !to) return null;
      return { from: from ?? undefined, to: to ? endOfDayInTz(to, timezone) : undefined };
    }
    default:
      return null;
  }
}

/** Translate a validated URL query into service options on the clinic clock. */
export function listOptionsFromQuery(query: PatientListQuery, timezone: string, now = new Date()): ListPatientsOptions {
  const range = registeredRange(query, timezone, now);
  return {
    q: query.q,
    tag: query.tag,
    gender: query.gender,
    ageBand: query.age,
    doctorId: query.doctor,
    upcoming: query.upcoming,
    lastVisit: query.visit,
    registeredFrom: range?.from,
    registeredTo: range?.to,
    language: query.lang,
    source: query.source,
    archived: query.archived === "only" ? "only" : query.archived === "1" ? "include" : "active",
    sort: query.sort,
    page: query.page,
    now,
  };
}

/** The tenant's tags in use (active patients), most common first, for the tag picker. */
export async function listPatientTags(tenantId: string): Promise<{ tag: string; count: number }[]> {
  const rows = await db.$queryRaw<{ tag: string; n: number }[]>`
    SELECT t AS tag, count(*)::int AS n
    FROM "patients" p, unnest(p."tags") AS t
    WHERE p."tenantId" = ${tenantId} AND p."deletedAt" IS NULL
    GROUP BY t
    ORDER BY n DESC, t ASC
    LIMIT 50`;
  return rows.map((r) => ({ tag: r.tag, count: Number(r.n) }));
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
  // The same number or national id on another active patient: 409 unless confirmed.
  const duplicateOf = await guardDuplicates(tenantId, data, data.confirmDuplicate);
  const patient = await db.patient.create({
    data: {
      tenantId,
      fullName: data.fullName,
      gender: data.gender,
      dateOfBirth: data.dateOfBirth ?? null,
      phone: data.phone ?? null,
      whatsapp: data.whatsapp ?? null,
      email: data.email ?? null,
      nationalId: data.nationalId ?? null,
      city: data.city ?? null,
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
    after: { ...snapshot(patient), ...(duplicateOf.length ? { confirmedDuplicateOf: duplicateOf } : {}) },
  });
  // Keep the assistant's knowledge of this patient current (fire-and-forget).
  ingestInBackground({ kind: "patient", tenantId, id: patient.id });
  return patient;
}

/**
 * Partial profile update. Only the fields present in `input` change; a blank
 * or `null` clears an optional field. Archived patients must be restored
 * first. Returns `null` when the patient is not an active member of the tenant.
 */
export async function updatePatient(tenantId: string, id: string, input: unknown, actor: Actor = {}) {
  const { confirmDuplicate, ...fields } = PatientUpdateInput.parse(input);
  const patch = definedEntries(fields);
  const keys = Object.keys(patch) as ProfileKey[];

  const existing = await db.patient.findFirst({ where: { id, tenantId, ...notDeleted } });
  if (!existing) return null;
  if (keys.length === 0) return existing;

  // Only a number or id that changes is checked against the other patients.
  const changed = (key: "phone" | "whatsapp" | "nationalId") => (patch[key] && patch[key] !== existing[key] ? patch[key] : null);
  const duplicateOf = await guardDuplicates(
    tenantId,
    { phone: changed("phone"), whatsapp: changed("whatsapp"), nationalId: changed("nationalId") },
    Boolean(confirmDuplicate),
    id,
  );

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
    after: { ...snapshot(patient, keys), ...(duplicateOf.length ? { confirmedDuplicateOf: duplicateOf } : {}) },
  });
  // Keep the assistant's knowledge of this patient current (fire-and-forget).
  ingestInBackground({ kind: "patient", tenantId, id });
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
  // Keep the assistant's knowledge of this patient current (fire-and-forget).
  ingestInBackground({ kind: "patient", tenantId, id });
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
  // Keep the assistant's knowledge of this patient current (fire-and-forget).
  ingestInBackground({ kind: "patient", tenantId, id });
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
  // Keep the assistant's knowledge of this patient current (fire-and-forget).
  ingestInBackground({ kind: "patient", tenantId, id: patientId });
  return history;
}
