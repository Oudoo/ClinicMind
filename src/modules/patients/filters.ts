/**
 * The patient list's filter and sort vocabulary, shared by the server page,
 * the API route, the CSV export and the client-side filter bar. Deliberately
 * free of server imports (no Prisma, no env) so the client bundle can use it.
 *
 * URL shape: `?q=&gender=&age=&tag=&doctor=&upcoming=&visit=&reg=&from=&to=
 * &lang=&source=&archived=&sort=&page=`. Every value is validated against
 * the lists below; anything unknown is dropped rather than rejected, so a
 * stale bookmark still renders the list.
 */

export const PATIENT_FILTER_KEYS = [
  "q",
  "gender",
  "age",
  "tag",
  "doctor",
  "upcoming",
  "visit",
  "reg",
  "from",
  "to",
  "lang",
  "source",
  "archived",
] as const;
export type PatientFilterKey = (typeof PATIENT_FILTER_KEYS)[number];

export const GENDER_OPTIONS = [
  { key: "MALE", label: "Male" },
  { key: "FEMALE", label: "Female" },
  { key: "OTHER", label: "Other" },
  { key: "UNDISCLOSED", label: "Undisclosed" },
] as const;
export type GenderKey = (typeof GENDER_OPTIONS)[number]["key"];

/** Inclusive age bands; `max` null means open-ended. */
export const AGE_BANDS = [
  { key: "u18", label: "Under 18", min: 0, max: 17 },
  { key: "18-30", label: "18–30", min: 18, max: 30 },
  { key: "31-45", label: "31–45", min: 31, max: 45 },
  { key: "46-60", label: "46–60", min: 46, max: 60 },
  { key: "60p", label: "Over 60", min: 61, max: null },
] as const;
export type AgeBandKey = (typeof AGE_BANDS)[number]["key"];

export const UPCOMING_OPTIONS = [
  { key: "yes", label: "Has an upcoming appointment" },
  { key: "week", label: "Upcoming in the next 7 days" },
  { key: "no", label: "No upcoming appointment" },
] as const;
export type UpcomingKey = (typeof UPCOMING_OPTIONS)[number]["key"];

export const VISIT_WINDOWS = [
  { key: "30", label: "Within 30 days", days: 30 },
  { key: "90", label: "Within 90 days", days: 90 },
  { key: "180", label: "Within 180 days", days: 180 },
  { key: "over180", label: "More than 180 days ago", days: 180 },
  { key: "never", label: "Never visited", days: null },
] as const;
export type VisitWindowKey = (typeof VISIT_WINDOWS)[number]["key"];

export const REGISTERED_WINDOWS = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "quarter", label: "This quarter" },
  { key: "custom", label: "Custom range" },
] as const;
export type RegisteredKey = (typeof REGISTERED_WINDOWS)[number]["key"];

export const LANGUAGE_OPTIONS = [
  { key: "ar", label: "Arabic" },
  { key: "en", label: "English" },
] as const;
export type LanguageKey = (typeof LANGUAGE_OPTIONS)[number]["key"];

/** Mirrors the `LeadSource` Prisma enum (patients carry their first-touch source). */
export const SOURCE_OPTIONS = [
  { key: "CLICK_TO_WHATSAPP_AD", label: "Click-to-WhatsApp ad" },
  { key: "INSTAGRAM_ORGANIC", label: "Instagram (organic)" },
  { key: "WEBSITE", label: "Website / online form" },
  { key: "REFERRAL", label: "Referral" },
  { key: "WALK_IN", label: "Walk-in" },
  { key: "PHONE", label: "Phone" },
  { key: "OTHER", label: "Other" },
] as const;
export type SourceKey = (typeof SOURCE_OPTIONS)[number]["key"];

export const ARCHIVED_OPTIONS = [
  { key: "", label: "Active only" },
  { key: "1", label: "Include archived" },
  { key: "only", label: "Archived only" },
] as const;
export type ArchivedKey = "1" | "only";

export const SORT_OPTIONS = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "name_asc", label: "Name A–Z" },
  { key: "name_desc", label: "Name Z–A" },
  { key: "last_visit", label: "Last visit (most recent first)" },
  { key: "next_appointment", label: "Next appointment (soonest first)" },
  { key: "age_desc", label: "Age (oldest first)" },
  { key: "age_asc", label: "Age (youngest first)" },
] as const;
export type SortKey = (typeof SORT_OPTIONS)[number]["key"];
export const DEFAULT_SORT: SortKey = "newest";

export interface PatientListQuery {
  q?: string;
  gender?: GenderKey;
  age?: AgeBandKey;
  tag?: string;
  doctor?: string;
  upcoming?: UpcomingKey;
  visit?: VisitWindowKey;
  reg?: RegisteredKey;
  /** `YYYY-MM-DD`, only with `reg=custom`. */
  from?: string;
  to?: string;
  lang?: LanguageKey;
  source?: SourceKey;
  archived?: ArchivedKey;
  sort?: SortKey;
  page?: number;
}

/** One-click presets shown above the table; each is just a query. */
export const QUICK_VIEWS: { key: string; label: string; query: PatientListQuery }[] = [
  { key: "new-month", label: "New this month", query: { reg: "month" } },
  { key: "no-visit-6m", label: "No visit in 6 months", query: { visit: "over180" } },
  { key: "upcoming-week", label: "Upcoming this week", query: { upcoming: "week" } },
  { key: "vip", label: "VIP", query: { tag: "vip" } },
  { key: "hair-transplant", label: "Hair transplant", query: { tag: "hair-transplant" } },
  { key: "archived", label: "Archived", query: { archived: "only" } },
];

type RawValue = string | string[] | undefined | null;
type RawQuery = Record<string, RawValue> | URLSearchParams;

const first = (v: RawValue): string | undefined => (Array.isArray(v) ? v[0] : (v ?? undefined));
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function oneOf<T extends string>(value: string | undefined, keys: readonly T[]): T | undefined {
  return value && (keys as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * Validate a raw query (Next `searchParams` or `URLSearchParams`) into a
 * `PatientListQuery`. Unknown values are dropped; text is trimmed and bounded.
 */
export function parsePatientListQuery(raw: RawQuery): PatientListQuery {
  const get = (key: string): string | undefined => {
    const value = raw instanceof URLSearchParams ? (raw.get(key) ?? undefined) : first(raw[key]);
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const q = get("q")?.slice(0, 100);
  const tag = get("tag")?.slice(0, 30);
  const doctor = get("doctor")?.slice(0, 64);
  const reg = oneOf(get("reg"), REGISTERED_WINDOWS.map((r) => r.key));
  const from = get("from");
  const to = get("to");
  const pageRaw = Number.parseInt(get("page") ?? "1", 10);
  const query: PatientListQuery = {
    q,
    gender: oneOf(get("gender"), GENDER_OPTIONS.map((g) => g.key)),
    age: oneOf(get("age"), AGE_BANDS.map((a) => a.key)),
    tag,
    doctor,
    upcoming: oneOf(get("upcoming"), UPCOMING_OPTIONS.map((u) => u.key)),
    visit: oneOf(get("visit"), VISIT_WINDOWS.map((v) => v.key)),
    reg,
    from: reg === "custom" && from && DATE_KEY.test(from) ? from : undefined,
    to: reg === "custom" && to && DATE_KEY.test(to) ? to : undefined,
    lang: oneOf(get("lang"), LANGUAGE_OPTIONS.map((l) => l.key)),
    source: oneOf(get("source"), SOURCE_OPTIONS.map((s) => s.key)),
    archived: oneOf(get("archived"), ["1", "only"] as const),
    sort: oneOf(get("sort"), SORT_OPTIONS.map((s) => s.key)),
    page: Number.isFinite(pageRaw) && pageRaw > 1 ? pageRaw : undefined,
  };
  // A custom range without either bound is no filter at all.
  if (query.reg === "custom" && !query.from && !query.to) query.reg = undefined;
  return stripUndefined(query);
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== "")) as T;
}

/** The query as URL parameters (defaults and blanks omitted; `page` only when > 1). */
export function patientQueryParams(query: PatientListQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of PATIENT_FILTER_KEYS) {
    const value = query[key];
    if (value) params.set(key, String(value));
  }
  if (query.sort && query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  return params;
}

export function patientListHref(query: PatientListQuery, basePath = "/dashboard/patients"): string {
  const qs = patientQueryParams(query).toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** True when any filter (not sort or page) is set. */
export function hasPatientFilters(query: PatientListQuery): boolean {
  return PATIENT_FILTER_KEYS.some((key) => Boolean(query[key]));
}

/** The filters only (no sort, no page), for saved views and the audit trail. */
export function patientFiltersOnly(query: PatientListQuery): Partial<Record<PatientFilterKey | "sort", string>> {
  const out: Partial<Record<PatientFilterKey | "sort", string>> = {};
  for (const key of PATIENT_FILTER_KEYS) {
    const value = query[key];
    if (value) out[key] = String(value);
  }
  if (query.sort && query.sort !== DEFAULT_SORT) out.sort = query.sort;
  return out;
}

export interface FilterChip {
  key: PatientFilterKey;
  label: string;
}

/**
 * Human labels for the active filters, as chips with an X. `doctorName`
 * resolves a doctor id picked from the staff list.
 */
export function patientFilterChips(
  query: PatientListQuery,
  lookup: { doctorName?: (id: string) => string | undefined } = {},
): FilterChip[] {
  const chips: FilterChip[] = [];
  const label = <T extends { key: string; label: string }>(options: readonly T[], key: string | undefined) =>
    options.find((o) => o.key === key)?.label ?? key ?? "";
  if (query.q) chips.push({ key: "q", label: `“${query.q}”` });
  if (query.gender) chips.push({ key: "gender", label: label(GENDER_OPTIONS, query.gender) });
  if (query.age) chips.push({ key: "age", label: `Age ${label(AGE_BANDS, query.age).toLowerCase()}` });
  if (query.tag) chips.push({ key: "tag", label: `Tag: ${query.tag}` });
  if (query.doctor) chips.push({ key: "doctor", label: `Doctor: ${lookup.doctorName?.(query.doctor) ?? "selected"}` });
  if (query.upcoming) chips.push({ key: "upcoming", label: label(UPCOMING_OPTIONS, query.upcoming) });
  if (query.visit) chips.push({ key: "visit", label: `Last visit: ${label(VISIT_WINDOWS, query.visit).toLowerCase()}` });
  if (query.reg) {
    const range =
      query.reg === "custom"
        ? [query.from ?? "…", query.to ?? "…"].join(" → ")
        : label(REGISTERED_WINDOWS, query.reg).toLowerCase();
    chips.push({ key: "reg", label: `Registered ${range}` });
  }
  if (query.lang) chips.push({ key: "lang", label: label(LANGUAGE_OPTIONS, query.lang) });
  if (query.source) chips.push({ key: "source", label: `Source: ${label(SOURCE_OPTIONS, query.source)}` });
  if (query.archived) chips.push({ key: "archived", label: query.archived === "only" ? "Archived only" : "Including archived" });
  return chips;
}

/** Remove one filter (the custom date bounds go with `reg`) and reset to page 1. */
export function withoutFilter(query: PatientListQuery, key: PatientFilterKey): PatientListQuery {
  const next: PatientListQuery = { ...query, page: undefined };
  delete next[key];
  if (key === "reg") {
    delete next.from;
    delete next.to;
  }
  return next;
}

/** True when the query is exactly the quick view (ignoring sort and page). */
export function matchesQuickView(query: PatientListQuery, view: PatientListQuery): boolean {
  const a = patientFiltersOnly({ ...query, sort: undefined });
  const b = patientFiltersOnly({ ...view, sort: undefined });
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key as PatientFilterKey] !== b[key as PatientFilterKey]) return false;
  return true;
}
