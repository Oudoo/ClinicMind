import { db, notDeleted } from "@/lib/db";
import { addDays, dateKeyInTz, startOfDayInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { treatmentNames } from "@/modules/treatments/service";
import { repeatPatientRate, shiftBackOneYear, type PaidVisitRow, type RepeatRate } from "./metrics";
import type { ResolvedPeriod } from "./period";
import { SOURCE_LABELS } from "./query";

/**
 * The patient data dashboard: who the clinic's patients are (population,
 * demographics, sources), what they come for, whether they come back, and who
 * has no follow-up booked after their last procedure.
 */

const DAY_MS = 86_400_000;
export const ACTIVE_DAYS = 180;

export interface Split {
  key: string;
  label: string;
  count: number;
}

export interface FollowUpGap {
  patientId: string;
  fullName: string;
  treatment: string;
  performedAt: Date;
  daysSince: number;
  doctor: string | null;
}

export interface Population {
  total: number;
  active: number;
  newInPeriod: number;
  newInPrevious: number;
  newPerMonth: { label: string; count: number }[];
  gender: Split[];
  ageBands: Split[];
  cities: Split[];
  languages: Split[];
  sources: Split[];
  topTreatments: (Split & { procedures: number })[];
  repeat: RepeatRate;
  followUpGaps: { count: number; items: FollowUpGap[] };
  averageVisits: number | null;
  visits: number;
}

const GENDER_LABELS: Record<string, string> = { MALE: "Male", FEMALE: "Female", OTHER: "Other", UNDISCLOSED: "Undisclosed" };
const LANGUAGE_LABELS: Record<string, string> = { ar: "Arabic", en: "English" };
const AGE_BANDS: [string, number, number][] = [
  ["Under 18", 0, 17],
  ["18–24", 18, 24],
  ["25–34", 25, 34],
  ["35–44", 35, 44],
  ["45–54", 45, 54],
  ["55–64", 55, 64],
  ["65+", 65, 200],
];

function countBy<T>(rows: readonly T[], key: (row: T) => string, label: (key: string) => string, order?: readonly string[]): Split[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = [...counts.entries()].map(([k, count]) => ({ key: k, label: label(k), count }));
  return order ? out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : out.sort((a, b) => b.count - a.count);
}

/** City from the city column, else the first part of the address ("Zamalek, Cairo" → "Zamalek"). */
export function cityOf(patient: { city: string | null; address: string | null }): string {
  const city = patient.city?.trim();
  if (city) return city;
  const first = patient.address?.split(",")[0]?.trim();
  return first || "unknown";
}

export async function getPatientPopulation(tenantId: string, period: ResolvedPeriod, timeZone: string, now: Date = new Date()): Promise<Population> {
  const activeSince = new Date(now.getTime() - ACTIVE_DAYS * DAY_MS);
  const [patients, activeVisits, visits, proceduresAll, feePayments, treatments] = await Promise.all([
    db.patient.findMany({
      where: { tenantId, ...notDeleted },
      select: { id: true, gender: true, dateOfBirth: true, city: true, address: true, language: true, source: true, createdAt: true },
      take: 50_000,
    }),
    db.visit.findMany({ where: { tenantId, createdAt: { gte: activeSince } }, select: { patientId: true }, distinct: ["patientId"], take: 50_000 }),
    db.visit.count({ where: { tenantId } }),
    db.procedure.findMany({
      where: { tenantId, ...notDeleted, status: "SIGNED" },
      select: { id: true, patientId: true, doctorId: true, performedAt: true, treatment: { select: { key: true, name: true } }, patient: { select: { fullName: true } } },
      orderBy: { performedAt: "asc" },
      take: 50_000,
    }),
    db.payment.findMany({ where: { tenantId, ...notDeleted, kind: "CONSULTATION_FEE" }, select: { patientId: true, paidAt: true }, take: 50_000 }),
    treatmentNames(tenantId),
  ]);

  const activeIds = new Set(activeVisits.map((v) => v.patientId));
  const inPeriod = (d: Date) => d >= period.from && d < period.to;
  const inPrevious = (d: Date) => d >= period.previous.from && d < period.previous.to;

  // New patients per month, 12 months ending this month (clinic clock).
  const p = zonedParts(now, timeZone);
  const months: { start: Date; end: Date; label: string }[] = [];
  for (let i = 11; i >= 0; i--) {
    const start = zonedTimeToUtc({ year: p.year, month: p.month - i, day: 1 }, timeZone);
    const end = zonedTimeToUtc({ year: p.year, month: p.month - i + 1, day: 1 }, timeZone);
    months.push({ start, end, label: new Intl.DateTimeFormat("en-GB", { timeZone, month: "short" }).format(start) });
  }
  const newPerMonth = months.map((m) => ({ label: m.label, count: patients.filter((x) => x.createdAt >= m.start && x.createdAt < m.end).length }));

  const ageOf = (dob: Date | null) => (dob ? Math.floor((now.getTime() - dob.getTime()) / (365.25 * DAY_MS)) : null);
  const ageBands = [
    ...AGE_BANDS.map(([label, lo, hi]) => ({ key: label, label, count: patients.filter((x) => { const a = ageOf(x.dateOfBirth); return a !== null && a >= lo && a <= hi; }).length })),
    { key: "unknown", label: "Unknown", count: patients.filter((x) => x.dateOfBirth === null).length },
  ];

  // Top treatments by distinct patients with a signed procedure in the period.
  const byTreatment = new Map<string, { patients: Set<string>; procedures: number; name: string }>();
  for (const proc of proceduresAll) {
    if (!inPeriod(proc.performedAt)) continue;
    const t = byTreatment.get(proc.treatment.key) ?? { patients: new Set<string>(), procedures: 0, name: proc.treatment.name };
    t.patients.add(proc.patientId);
    t.procedures += 1;
    byTreatment.set(proc.treatment.key, t);
  }
  const topTreatments = [...byTreatment.entries()]
    .map(([key, t]) => ({ key, label: t.name, count: t.patients.size, procedures: t.procedures }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Follow-up gap: the last signed procedure in the period per patient with no later (non-cancelled) appointment.
  const lastByPatient = new Map<string, (typeof proceduresAll)[number]>();
  for (const proc of proceduresAll) if (inPeriod(proc.performedAt)) lastByPatient.set(proc.patientId, proc);
  const gapCandidates = [...lastByPatient.values()];
  const laterAppointments = gapCandidates.length
    ? await db.appointment.findMany({
        where: {
          tenantId,
          ...notDeleted,
          patientId: { in: gapCandidates.map((g) => g.patientId) },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
          startsAt: { gt: new Date(Math.min(...gapCandidates.map((g) => g.performedAt.getTime()))) },
        },
        select: { patientId: true, startsAt: true },
        take: 50_000,
      })
    : [];
  const laterByPatient = new Map<string, Date[]>();
  for (const a of laterAppointments) {
    const list = laterByPatient.get(a.patientId) ?? [];
    list.push(a.startsAt);
    laterByPatient.set(a.patientId, list);
  }
  const doctorIds = [...new Set(gapCandidates.map((g) => g.doctorId).filter((id): id is string => Boolean(id)))];
  const doctors = doctorIds.length ? await db.user.findMany({ where: { tenantId, id: { in: doctorIds } }, select: { id: true, fullName: true, email: true } }) : [];
  const doctorName = new Map(doctors.map((d) => [d.id, d.fullName ?? d.email]));
  const gaps: FollowUpGap[] = gapCandidates
    .filter((g) => !(laterByPatient.get(g.patientId) ?? []).some((d) => d.getTime() > g.performedAt.getTime()))
    .map((g) => ({
      patientId: g.patientId,
      fullName: g.patient.fullName,
      treatment: g.treatment.name,
      performedAt: g.performedAt,
      daysSince: Math.floor((now.getTime() - g.performedAt.getTime()) / DAY_MS),
      doctor: g.doctorId ? (doctorName.get(g.doctorId) ?? null) : null,
    }))
    .sort((a, b) => a.performedAt.getTime() - b.performedAt.getTime());

  const paidVisits: PaidVisitRow[] = [
    ...proceduresAll.map((x) => ({ patientId: x.patientId, at: x.performedAt, treatmentKey: x.treatment.key })),
    ...feePayments.map((x) => ({ patientId: x.patientId, at: x.paidAt, treatmentKey: null })),
  ];
  const repeat = repeatPatientRate(paidVisits, shiftBackOneYear({ from: period.from, to: period.to }, timeZone), timeZone, { doctors: new Map(), treatments, campaigns: new Map() });

  return {
    total: patients.length,
    active: activeIds.size,
    newInPeriod: patients.filter((x) => inPeriod(x.createdAt)).length,
    newInPrevious: patients.filter((x) => inPrevious(x.createdAt)).length,
    newPerMonth,
    gender: countBy(patients, (x) => x.gender, (k) => GENDER_LABELS[k] ?? k, ["FEMALE", "MALE", "OTHER", "UNDISCLOSED"]),
    ageBands,
    cities: countBy(patients, cityOf, (k) => (k === "unknown" ? "Unknown" : k)).slice(0, 10),
    languages: countBy(patients, (x) => x.language, (k) => LANGUAGE_LABELS[k] ?? k),
    sources: countBy(patients, (x) => x.source ?? "unknown", (k) => SOURCE_LABELS[k as keyof typeof SOURCE_LABELS] ?? k),
    topTreatments,
    repeat,
    followUpGaps: { count: gaps.length, items: gaps.slice(0, 50) },
    averageVisits: patients.length ? visits / patients.length : null,
    visits,
  };
}

export { addDays, dateKeyInTz, startOfDayInTz };
