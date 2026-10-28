import type { Gender, Prisma } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { dateKeyInTz, zonedParts } from "@/lib/time";
import { jsonList, medicationSummary } from "@/modules/knowledge/documents";
import { describeCriterion, termDisplay, type Criterion, type Detail, type ParsedQuestion, type TermSpec } from "./parser";
import { findPhrase, joinList, words } from "./text";
import { SEX_SPECIFIC_CONDITIONS, conceptById, drugClassById } from "./vocabulary";

export { parseCohortQuestion, describeCriterion } from "./parser";
export type { Criterion, ParsedQuestion, TermSpec, Detail } from "./parser";

/**
 * The structured (cohort) path of the assistant: questions such as "which
 * patients have a documented allergy to lidocaine or penicillin?" are answered
 * by a tenant-scoped database query over EVERY patient record, never from the
 * handful of snippets retrieval returns. The answer lists every matching
 * patient (paged at 200, with the total), the fact that matched and where it is
 * recorded, and says precisely when nothing matches.
 *
 * Sources per criterion:
 *   allergy      MedicalHistory.allergies
 *   condition    MedicalHistory.chronicConditions and .diagnoses, plus the
 *                diagnoses of SIGNED consultations
 *   medication   active Medication rows (active, not stopped)
 *   procedure    MedicalHistory.surgeries and SIGNED procedures (treatment name)
 *   sex, age     the patient profile (age in completed years on the clinic clock)
 *   tag          Patient.tags
 *   doctor       a past visit with, or an upcoming appointment with, the clinician
 *   appointment  live bookings in the window (cancelled never count)
 *   lastVisit    the latest Visit; patients never seen count when registered before the cutoff
 * Archived patients are never included.
 */

export const COHORT_PAGE_SIZE = 200;

export type FactSource = "DIAGNOSIS" | "MEDICATION" | "TRANSCRIPT" | "VISIT_NOTE" | "APPOINTMENT" | "PROCEDURE" | "PROFILE";

export interface CohortFact {
  /** Index of the criterion this fact answers (-1 for a requested detail). */
  criterion: number;
  label: string;
  value: string;
  /** Where it is recorded ("Medical history · Allergies", "Medications · active since 2026-08-01"). */
  where: string;
  source: FactSource;
  refId: string;
  /** Extra context ("penicillin class", "not recorded"). */
  note?: string | null;
  /** The criterion is NOT met for this patient (yes/no checks). */
  unmet?: boolean;
}

export interface CohortRow {
  patientId: string;
  name: string;
  age: number | null;
  sex: Gender;
  facts: CohortFact[];
  href: string;
}

export interface CohortResult {
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  rows: CohortRow[];
  /** Every matching patient id (all pages), in answer order. */
  ids: string[];
  /** Per-term counts for "a or b" criteria. */
  termCounts: { criterion: number; term: string; count: number }[];
  /** Data-quality and completeness notes ("3 patients have no date of birth recorded"). */
  notes: string[];
}

export interface CohortOptions {
  page?: number;
  pageSize?: number;
  timeZone: string;
  now?: Date;
  /** Only consider these patients (a named patient, or an outer cohort). */
  restrictTo?: string[] | null;
  details?: Detail[];
}

interface BasePatient {
  id: string;
  fullName: string;
  gender: Gender;
  dateOfBirth: Date | null;
  createdAt: Date;
  tags: string[];
}

type FactMap = Map<string, CohortFact[]>;

interface CriterionMatch {
  facts: FactMap;
  /** term index → patients it matched (for "a or b" counts and "all of" checks). */
  byTerm: Map<number, Set<string>>;
}

// ── Running a cohort ─────────────────────────────────────────────────────────

export async function runCohortQuery(tenantId: string, criteria: Criterion[], opts: CohortOptions): Promise<CohortResult> {
  const now = opts.now ?? new Date();
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? COHORT_PAGE_SIZE, COHORT_PAGE_SIZE));
  const notes: string[] = [];

  // 1. The patients the profile criteria allow (sex, tag), tenant-scoped.
  const where: Prisma.PatientWhereInput = { tenantId, ...notDeleted };
  if (opts.restrictTo) where.id = { in: opts.restrictTo };
  const sexes = criteria.filter((c) => c.kind === "sex" && !c.negate).flatMap((c) => c.sexes ?? []);
  if (sexes.length) where.gender = { in: [...new Set(sexes)] };
  const base: BasePatient[] = await db.patient.findMany({
    where,
    select: { id: true, fullName: true, gender: true, dateOfBirth: true, createdAt: true, tags: true },
  });
  const byId = new Map(base.map((p) => [p.id, p]));
  let candidates = new Set(base.map((p) => p.id));
  const facts: FactMap = new Map();
  const termCounts: CohortResult["termCounts"] = [];
  const termSets: { criterion: number; term: string; ids: Set<string> }[] = [];

  for (let ci = 0; ci < criteria.length; ci++) {
    const c = criteria[ci]!;
    if (c.kind === "sex") continue;
    if (!candidates.size) break;
    if (c.kind === "age") {
      const today = zonedParts(now, opts.timeZone);
      let unknown = 0;
      const next = new Set<string>();
      for (const id of candidates) {
        const p = byId.get(id)!;
        const age = ageOn(p.dateOfBirth, today);
        if (age === null) {
          unknown++;
          continue;
        }
        if ((c.age?.min ?? null) !== null && age < c.age!.min!) continue;
        if ((c.age?.max ?? null) !== null && age > c.age!.max!) continue;
        next.add(id);
      }
      if (unknown) notes.push(`${unknown} patient${unknown === 1 ? " has" : "s have"} no date of birth recorded and could not be checked for age.`);
      candidates = next;
      continue;
    }
    if (c.kind === "tag") {
      const wanted = (c.tags ?? []).map(normTag);
      const next = new Set<string>();
      for (const id of candidates) {
        const p = byId.get(id)!;
        const hit = p.tags.filter((t) => wanted.includes(normTag(t)));
        const tagged = hit.length > 0;
        if (tagged === c.negate) continue;
        next.add(id);
        if (tagged) addFact(facts, id, { criterion: ci, label: "Tag", value: hit.join(", "), where: "Patient profile · Tags", source: "PROFILE", refId: id });
      }
      candidates = next;
      continue;
    }
    const scope = candidates.size === base.length && !opts.restrictTo ? null : [...candidates];
    const match = await matchCriterion(tenantId, c, ci, scope, { now, timeZone: opts.timeZone, details: opts.details ?? [], byId });
    const matched = new Set<string>();
    for (const id of candidates) {
      const termHits = [...match.byTerm.values()].map((s) => s.has(id));
      const hit = c.terms.length > 1 && c.match === "all" ? termHits.length === c.terms.length && termHits.every(Boolean) : match.facts.has(id);
      if (hit) matched.add(id);
    }
    if (c.negate) {
      candidates = new Set([...candidates].filter((id) => !matched.has(id)));
      for (const id of candidates) {
        addFact(facts, id, { criterion: ci, label: negatedLabel(c), value: "not recorded", where: negatedWhere(c), source: sourceOf(c), refId: id, note: null });
      }
    } else {
      candidates = matched;
      for (const id of matched) for (const f of match.facts.get(id) ?? []) addFact(facts, id, f);
      if (c.terms.length > 1) {
        c.terms.forEach((t, ti) => termSets.push({ criterion: ci, term: termLabel(t), ids: match.byTerm.get(ti) ?? new Set() }));
      }
    }
  }

  // 2. Order (by name), page, and build the rows.
  const ids = [...candidates].sort((a, b) => compareNames(byId.get(a)!.fullName, byId.get(b)!.fullName) || a.localeCompare(b));
  for (const t of termSets) termCounts.push({ criterion: t.criterion, term: t.term, count: ids.filter((id) => t.ids.has(id)).length });
  const total = ids.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const pageIds = ids.slice((page - 1) * pageSize, page * pageSize);
  const today = zonedParts(now, opts.timeZone);

  if (pageIds.length && (opts.details ?? []).some((d) => d === "medications" || d === "dose") && !criteria.some((c) => c.kind === "medication" && !c.negate)) {
    const meds = await activeMedications(tenantId, pageIds);
    for (const id of pageIds) {
      const list = meds.get(id) ?? [];
      addFact(facts, id, {
        criterion: -1,
        label: "Active medications",
        value: list.length ? list.map((m) => medicationSummary(m)).join("; ") : "none recorded",
        where: "Medications",
        source: "MEDICATION",
        refId: id,
      });
    }
  }

  const rows: CohortRow[] = pageIds.map((id) => {
    const p = byId.get(id)!;
    return {
      patientId: id,
      name: p.fullName,
      age: ageOn(p.dateOfBirth, today),
      sex: p.gender,
      facts: facts.get(id) ?? [],
      href: patientHref(id),
    };
  });

  // 3. Data-quality notes: a female-only condition recorded for male patients.
  const male = criteria.some((c) => c.kind === "sex" && !c.negate && (c.sexes ?? []).length === 1 && c.sexes![0] === "MALE");
  if (male && total > 0) {
    for (const c of criteria) {
      if (c.kind !== "condition" || c.negate) continue;
      for (const t of c.terms) {
        if (t.conceptId && SEX_SPECIFIC_CONDITIONS[t.conceptId] === "FEMALE") {
          notes.push(`${t.label} is recorded for ${total} male patient${total === 1 ? "" : "s"}; check these entries, they may be recording errors.`);
        }
      }
    }
  }

  return { total, page, pageSize, pages, rows, ids, termCounts, notes };
}

export function patientHref(id: string): string {
  return `/dashboard/patients/${encodeURIComponent(id)}`;
}

// ── Matchers per criterion ───────────────────────────────────────────────────

interface MatchContext {
  now: Date;
  timeZone: string;
  details: Detail[];
  byId: Map<string, BasePatient>;
}

async function matchCriterion(
  tenantId: string,
  c: Criterion,
  ci: number,
  scope: string[] | null,
  ctx: MatchContext,
): Promise<CriterionMatch> {
  const patientFilter = scope ? { patientId: { in: scope } } : {};
  switch (c.kind) {
    case "allergy": {
      const rows = await db.medicalHistory.findMany({
        where: { tenantId, ...patientFilter, patient: notDeleted },
        select: { patientId: true, allergies: true },
      });
      return matchLists(c, ci, rows.map((r) => ({ patientId: r.patientId, lists: [{ label: "Allergy", where: "Medical history · Allergies", entries: jsonList(r.allergies) }] })));
    }
    case "condition": {
      const [histories, consultations] = await Promise.all([
        db.medicalHistory.findMany({
          where: { tenantId, ...patientFilter, patient: notDeleted },
          select: { patientId: true, chronicConditions: true, diagnoses: true },
        }),
        db.consultation.findMany({
          where: { tenantId, status: "SIGNED", ...patientFilter, patient: notDeleted },
          select: { id: true, patientId: true, reviewedAt: true, createdAt: true, extraction: true },
          orderBy: [{ reviewedAt: "desc" }, { createdAt: "desc" }],
        }),
      ]);
      const sources = histories.map((h) => ({
        patientId: h.patientId,
        lists: [
          { label: "Chronic condition", where: "Medical history · Chronic conditions", entries: jsonList(h.chronicConditions) },
          { label: "Diagnosis", where: "Medical history · Diagnoses", entries: jsonList(h.diagnoses) },
        ],
      }));
      const fromHistory = matchLists(c, ci, sources);
      // Signed consultations add diagnoses that never reached the history list.
      for (const con of consultations) {
        const diagnoses = jsonList((con.extraction as { diagnoses?: unknown } | null)?.diagnoses);
        if (!diagnoses.length) continue;
        const at = con.reviewedAt ?? con.createdAt;
        const consult = matchLists(c, ci, [
          { patientId: con.patientId, lists: [{ label: "Diagnosis", where: `Signed consultation · ${dateKeyInTz(at, ctx.timeZone)}`, entries: diagnoses, source: "TRANSCRIPT" as const, refId: con.id }] },
        ]);
        for (const [pid, fs] of consult.facts) {
          const existing = fromHistory.facts.get(pid) ?? [];
          for (const f of fs) {
            const dup = existing.some((e) => e.value.toLowerCase() === f.value.toLowerCase());
            if (!dup && existing.filter((e) => e.source === "TRANSCRIPT").length < 1) existing.push(f);
          }
          fromHistory.facts.set(pid, existing);
        }
        for (const [ti, set] of consult.byTerm) {
          if (!fromHistory.byTerm.has(ti)) fromHistory.byTerm.set(ti, new Set());
          for (const pid of set) fromHistory.byTerm.get(ti)!.add(pid);
        }
      }
      return fromHistory;
    }
    case "medication": {
      const meds = await db.medication.findMany({
        where: { tenantId, active: true, stoppedAt: null, ...patientFilter, patient: notDeleted },
        select: { id: true, patientId: true, name: true, dosage: true, frequency: true, startDate: true },
        orderBy: { createdAt: "asc" },
      });
      const out: CriterionMatch = { facts: new Map(), byTerm: new Map() };
      for (const m of meds) {
        const nameWords = words(m.name);
        c.terms.forEach((t, ti) => {
          const hit = matchTerm(t, nameWords);
          if (!hit) return;
          if (t.strength && !strengthMatches(t.strength, `${m.name} ${m.dosage ?? ""}`)) return;
          if (!out.byTerm.has(ti)) out.byTerm.set(ti, new Set());
          out.byTerm.get(ti)!.add(m.patientId);
          addFact(out.facts, m.patientId, {
            criterion: ci,
            label: "Medication",
            value: medicationSummary(m),
            where: `Medications · active${m.startDate ? ` since ${dateKeyInTz(m.startDate, ctx.timeZone)}` : ""}`,
            source: "MEDICATION",
            refId: m.id,
            note: hit.note,
          });
        });
      }
      return out;
    }
    case "procedure": {
      const [histories, procedures] = await Promise.all([
        db.medicalHistory.findMany({
          where: { tenantId, ...patientFilter, patient: notDeleted },
          select: { patientId: true, surgeries: true },
        }),
        db.procedure.findMany({
          where: { tenantId, status: "SIGNED", ...notDeleted, ...patientFilter, patient: notDeleted },
          select: { id: true, patientId: true, performedAt: true, notes: true, treatment: { select: { name: true, key: true } } },
          orderBy: { performedAt: "desc" },
        }),
      ]);
      const out = matchLists(c, ci, histories.map((h) => ({ patientId: h.patientId, lists: [{ label: "Surgery", where: "Medical history · Surgeries", entries: jsonList(h.surgeries) }] })));
      if (c.terms.some((t) => t.any)) return out;
      for (const p of procedures) {
        const text = words(`${p.treatment.name} ${p.treatment.key.replace(/-/g, " ")}`);
        c.terms.forEach((t, ti) => {
          const hit = matchTerm(t, text);
          if (!hit) return;
          if (!out.byTerm.has(ti)) out.byTerm.set(ti, new Set());
          out.byTerm.get(ti)!.add(p.patientId);
          const existing = out.facts.get(p.patientId) ?? [];
          if (existing.filter((f) => f.source === "PROCEDURE").length >= 1) return;
          const noteText = p.notes?.trim();
          addFact(out.facts, p.patientId, {
            criterion: ci,
            label: "Procedure",
            value: `${p.treatment.name}${noteText && ctx.details.includes("grafts") ? ` — ${noteText.slice(0, 80)}` : ""}`,
            where: `Procedures · signed ${dateKeyInTz(p.performedAt, ctx.timeZone)}`,
            source: "PROCEDURE",
            refId: p.id,
            note: hit.note,
          });
        });
      }
      return out;
    }
    case "doctor": {
      const doctorIds = (c.doctors ?? []).map((d) => d.id);
      const names = new Map((c.doctors ?? []).map((d) => [d.id, d.name]));
      const [visits, upcoming] = await Promise.all([
        db.visit.groupBy({
          by: ["patientId", "doctorId"],
          where: { tenantId, doctorId: { in: doctorIds }, ...patientFilter, patient: notDeleted },
          _max: { createdAt: true },
        }),
        db.appointment.groupBy({
          by: ["patientId", "doctorId"],
          where: { tenantId, ...notDeleted, doctorId: { in: doctorIds }, startsAt: { gte: ctx.now }, status: { notIn: ["CANCELLED", "NO_SHOW"] }, ...patientFilter, patient: notDeleted },
          _min: { startsAt: true },
        }),
      ]);
      const out: CriterionMatch = { facts: new Map(), byTerm: new Map() };
      for (const v of visits) {
        if (!v._max.createdAt || !v.doctorId) continue;
        addFact(out.facts, v.patientId, {
          criterion: ci,
          label: "Last visit",
          value: `${dateKeyInTz(v._max.createdAt, ctx.timeZone)} with ${names.get(v.doctorId) ?? "the doctor"}`,
          where: "Visits",
          source: "VISIT_NOTE",
          refId: v.patientId,
        });
      }
      for (const a of upcoming) {
        if (!a._min.startsAt || !a.doctorId) continue;
        if (out.facts.has(a.patientId) && out.facts.get(a.patientId)!.length >= 1 && !ctx.details.includes("dates")) {
          // one fact per patient is enough unless dates were asked for
          continue;
        }
        addFact(out.facts, a.patientId, {
          criterion: ci,
          label: "Next appointment",
          value: `${dateKeyInTz(a._min.startsAt, ctx.timeZone)} with ${names.get(a.doctorId) ?? "the doctor"}`,
          where: "Appointments",
          source: "APPOINTMENT",
          refId: a.patientId,
        });
      }
      return out;
    }
    case "appointment": {
      const w = c.window!;
      const from = new Date(w.from);
      const to = w.to ? new Date(w.to) : null;
      const appts = await db.appointment.findMany({
        where: {
          tenantId,
          ...notDeleted,
          startsAt: to ? { gte: from, lte: to } : { gte: from },
          status: { notIn: w.upcomingOnly ? ["CANCELLED", "NO_SHOW", "COMPLETED"] : ["CANCELLED"] },
          ...patientFilter,
          patient: notDeleted,
        },
        select: { id: true, patientId: true, startsAt: true, status: true, reason: true, doctorId: true },
        orderBy: { startsAt: "asc" },
      });
      const doctorIds = [...new Set(appts.map((a) => a.doctorId).filter((d): d is string => Boolean(d)))];
      const doctors = doctorIds.length
        ? new Map((await db.user.findMany({ where: { tenantId, id: { in: doctorIds } }, select: { id: true, fullName: true, email: true } })).map((u) => [u.id, u.fullName ?? u.email]))
        : new Map<string, string>();
      const out: CriterionMatch = { facts: new Map(), byTerm: new Map() };
      for (const a of appts) {
        if (out.facts.has(a.patientId)) continue; // the first (soonest) one
        const when = `${dateKeyInTz(a.startsAt, ctx.timeZone)} ${new Intl.DateTimeFormat("en-GB", { timeZone: ctx.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(a.startsAt)}`;
        addFact(out.facts, a.patientId, {
          criterion: ci,
          label: "Appointment",
          value: `${when}${a.doctorId && doctors.get(a.doctorId) ? ` with ${doctors.get(a.doctorId)}` : ""} (${a.status.toLowerCase().replace(/_/g, " ")})${a.reason ? ` — ${a.reason}` : ""}`,
          where: "Appointments",
          source: "APPOINTMENT",
          refId: a.id,
        });
      }
      return out;
    }
    case "lastVisit": {
      const visits = await db.visit.groupBy({
        by: ["patientId"],
        where: { tenantId, ...patientFilter, patient: notDeleted },
        _max: { createdAt: true },
      });
      const last = new Map(visits.map((v) => [v.patientId, v._max.createdAt]));
      const before = c.cutoff?.before ? new Date(c.cutoff.before) : null;
      const out: CriterionMatch = { facts: new Map(), byTerm: new Map() };
      const pool = scope ?? [...ctx.byId.keys()];
      for (const id of pool) {
        const p = ctx.byId.get(id);
        if (!p) continue;
        const seen = last.get(id) ?? null;
        const qualifies = before ? (seen ? seen < before : p.createdAt < before) : !seen;
        if (!qualifies) continue;
        addFact(out.facts, id, {
          criterion: ci,
          label: "Last visit",
          value: seen ? dateKeyInTz(seen, ctx.timeZone) : `none on record (registered ${dateKeyInTz(p.createdAt, ctx.timeZone)})`,
          where: "Visits",
          source: "VISIT_NOTE",
          refId: id,
        });
      }
      return out;
    }
    default:
      return { facts: new Map(), byTerm: new Map() };
  }
}

interface ListSource {
  patientId: string;
  lists: { label: string; where: string; entries: string[]; source?: FactSource; refId?: string }[];
}

/** Match a criterion's terms against JSON list entries (allergies, conditions, surgeries). */
function matchLists(c: Criterion, ci: number, sources: ListSource[]): CriterionMatch {
  const out: CriterionMatch = { facts: new Map(), byTerm: new Map() };
  const anyTerm = c.terms.some((t) => t.any);
  for (const s of sources) {
    for (const list of s.lists) {
      if (anyTerm) {
        if (!list.entries.length) continue;
        if (!out.byTerm.has(0)) out.byTerm.set(0, new Set());
        out.byTerm.get(0)!.add(s.patientId);
        addFact(out.facts, s.patientId, {
          criterion: ci,
          label: list.label === "Allergy" ? "Allergies" : list.label === "Surgery" ? "Surgeries" : list.label,
          value: list.entries.join("; "),
          where: list.where,
          source: list.source ?? "DIAGNOSIS",
          refId: list.refId ?? s.patientId,
        });
        continue;
      }
      for (const entry of list.entries) {
        const entryWords = words(entry);
        c.terms.forEach((t, ti) => {
          const hit = matchTerm(t, entryWords);
          if (!hit) return;
          if (!out.byTerm.has(ti)) out.byTerm.set(ti, new Set());
          out.byTerm.get(ti)!.add(s.patientId);
          const existing = out.facts.get(s.patientId) ?? [];
          if (existing.some((f) => f.value === entry && f.where === list.where)) return;
          addFact(out.facts, s.patientId, {
            criterion: ci,
            label: list.label,
            value: entry,
            where: list.where,
            source: list.source ?? "DIAGNOSIS",
            refId: list.refId ?? s.patientId,
            note: hit.note,
          });
        });
      }
    }
  }
  return out;
}

/**
 * Whether a recorded text (as words) contains one of the term's phrases.
 * Returns a note when the match came through the drug class ("penicillin class").
 */
export function matchTerm(t: TermSpec, text: string[]): { note: string | null } | null {
  if (t.any) return text.length ? { note: null } : null;
  for (let k = 0; k < t.phrases.length; k++) {
    const phrase = t.phrases[k]!;
    if (findPhrase(text, phrase) === -1) continue;
    const owner = t.phraseOwners[k] ?? null;
    let note: string | null = null;
    if (owner && t.classLabel) {
      const viaOther = owner !== t.conceptId && owner !== t.classId;
      if (viaOther || t.classId) note = t.classLabel;
    }
    return { note };
  }
  return null;
}

/** "20 mg" ↔ "Isotretinoin 20mg"; "5%" ↔ "Minoxidil 5 % solution". */
export function strengthMatches(strength: string, text: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/(\d)\s+(?=[a-z%])/g, "$1").replace(/,/g, ".");
  const want = norm(strength);
  const value = /^(\d+(?:\.\d+)?)/.exec(want)?.[1];
  if (!value) return true;
  const unit = want.slice(value.length);
  const hay = norm(text);
  const re = new RegExp(`(?:^|[^\\d.])${value.replace(".", "\\.")}${unit ? unit.replace(/[%]/g, "%") : "(?![\\d.])"}`);
  return re.test(hay);
}

async function activeMedications(tenantId: string, patientIds: string[]) {
  const meds = await db.medication.findMany({
    where: { tenantId, patientId: { in: patientIds }, active: true, stoppedAt: null },
    select: { patientId: true, name: true, dosage: true, frequency: true },
    orderBy: { createdAt: "asc" },
  });
  const out = new Map<string, { name: string; dosage: string | null; frequency: string | null }[]>();
  for (const m of meds) {
    if (!out.has(m.patientId)) out.set(m.patientId, []);
    out.get(m.patientId)!.push(m);
  }
  return out;
}

// ── Single-patient checks ("Is Tarek Ezzat on cephalexin?") ──────────────────

export interface PatientCheck {
  patient: { id: string; name: string; age: number | null; sex: Gender };
  /** Every criterion is met. */
  met: boolean;
  items: { criterion: Criterion; met: boolean; facts: CohortFact[] }[];
}

/** Evaluate each criterion for one patient, with what the record says when it is not met. */
export async function checkPatient(
  tenantId: string,
  patientId: string,
  criteria: Criterion[],
  opts: { timeZone: string; now?: Date; details?: Detail[] },
): Promise<PatientCheck | null> {
  const now = opts.now ?? new Date();
  const patient = await db.patient.findFirst({
    where: { id: patientId, tenantId, ...notDeleted },
    select: { id: true, fullName: true, gender: true, dateOfBirth: true, tags: true },
  });
  if (!patient) return null;
  const today = zonedParts(now, opts.timeZone);
  const items: PatientCheck["items"] = [];
  for (let ci = 0; ci < criteria.length; ci++) {
    const c = criteria[ci]!;
    const result = await runCohortQuery(tenantId, [c], { timeZone: opts.timeZone, now, restrictTo: [patientId], details: opts.details });
    const met = result.total === 1;
    const facts = met ? (result.rows[0]?.facts ?? []).map((f) => ({ ...f, criterion: ci })) : await recordedFacts(tenantId, patient, c, ci, opts.timeZone, today);
    items.push({ criterion: c, met, facts: facts.map((f) => (met ? f : { ...f, unmet: true })) });
  }
  return {
    patient: { id: patient.id, name: patient.fullName, age: ageOn(patient.dateOfBirth, today), sex: patient.gender },
    met: items.every((i) => i.met),
    items,
  };
}

/** What the chart says for a criterion that is not met (the active medication list, the allergy list…). */
async function recordedFacts(
  tenantId: string,
  patient: { id: string; gender: Gender; dateOfBirth: Date | null; tags: string[] },
  c: Criterion,
  ci: number,
  timeZone: string,
  today: ReturnType<typeof zonedParts>,
): Promise<CohortFact[]> {
  const base = { criterion: ci, refId: patient.id };
  switch (c.kind) {
    case "allergy":
    case "condition":
    case "procedure": {
      const h = await db.medicalHistory.findFirst({ where: { tenantId, patientId: patient.id }, select: { allergies: true, chronicConditions: true, diagnoses: true, surgeries: true } });
      if (c.kind === "allergy") {
        const list = jsonList(h?.allergies);
        return [{ ...base, label: "Allergies", value: list.length ? list.join("; ") : "none recorded", where: "Medical history · Allergies", source: "DIAGNOSIS" }];
      }
      if (c.kind === "condition") {
        const conditions = [...jsonList(h?.chronicConditions), ...jsonList(h?.diagnoses)];
        return [{ ...base, label: "Conditions and diagnoses", value: conditions.length ? [...new Set(conditions)].join("; ") : "none recorded", where: "Medical history", source: "DIAGNOSIS" }];
      }
      const surgeries = jsonList(h?.surgeries);
      return [{ ...base, label: "Surgeries", value: surgeries.length ? surgeries.join("; ") : "none recorded", where: "Medical history · Surgeries", source: "DIAGNOSIS" }];
    }
    case "medication": {
      const meds = await db.medication.findMany({
        where: { tenantId, patientId: patient.id },
        select: { id: true, name: true, dosage: true, frequency: true, active: true, stoppedAt: true, stopReason: true, endDate: true },
        orderBy: { createdAt: "asc" },
      });
      const active = meds.filter((m) => m.active && !m.stoppedAt);
      const out: CohortFact[] = [
        { ...base, label: "Active medications", value: active.length ? active.map((m) => medicationSummary(m)).join("; ") : "none recorded", where: "Medications", source: "MEDICATION" },
      ];
      // A matching medication that was stopped is worth saying.
      for (const m of meds.filter((x) => !x.active || x.stoppedAt)) {
        if (c.terms.some((t) => matchTerm(t, words(m.name)))) {
          const when = m.stoppedAt ?? m.endDate;
          out.push({
            ...base,
            refId: m.id,
            label: "Stopped",
            value: `${medicationSummary(m)}${when ? ` — stopped ${dateKeyInTz(when, timeZone)}` : " — stopped"}${m.stopReason ? ` (${m.stopReason})` : ""}`,
            where: "Medications · stopped",
            source: "MEDICATION",
          });
        }
      }
      return out;
    }
    case "sex":
      return [{ ...base, label: "Sex", value: sexLabel(patient.gender), where: "Patient profile", source: "PROFILE" }];
    case "age": {
      const age = ageOn(patient.dateOfBirth, today);
      return [{ ...base, label: "Age", value: age === null ? "no date of birth recorded" : String(age), where: "Patient profile", source: "PROFILE" }];
    }
    case "tag":
      return [{ ...base, label: "Tags", value: patient.tags.length ? patient.tags.join(", ") : "none", where: "Patient profile · Tags", source: "PROFILE" }];
    case "doctor":
      return [{ ...base, label: "Clinician", value: `no visit with and no upcoming appointment with ${(c.doctors ?? []).map((d) => d.name).join(" or ")}`, where: "Visits and appointments", source: "VISIT_NOTE" }];
    case "appointment": {
      const next = await db.appointment.findFirst({
        where: { tenantId, patientId: patient.id, ...notDeleted, startsAt: { gte: new Date() }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
        orderBy: { startsAt: "asc" },
        select: { startsAt: true, status: true },
      });
      return [{ ...base, label: "Next appointment", value: next ? `${dateKeyInTz(next.startsAt, timeZone)} (${next.status.toLowerCase()})` : "none booked", where: "Appointments", source: "APPOINTMENT" }];
    }
    case "lastVisit": {
      const last = await db.visit.findFirst({ where: { tenantId, patientId: patient.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      return [{ ...base, label: "Last visit", value: last ? dateKeyInTz(last.createdAt, timeZone) : "none on record", where: "Visits", source: "VISIT_NOTE" }];
    }
  }
}

// ── Answer text ──────────────────────────────────────────────────────────────

export interface CohortSummary {
  headline: string;
  /** Extra sentences: per-term zero counts, data notes, caveats for negated criteria. */
  lines: string[];
}

const SEX_ADJ = { MALE: "male", FEMALE: "female" } as const;

/** The headline and notes of a cohort answer, in the question's language. */
export function summarizeCohort(parsed: ParsedQuestion, criteria: Criterion[], result: CohortResult): CohortSummary {
  return parsed.language === "ar" ? summarizeAr(criteria, result) : summarizeEn(criteria, result);
}

function shownNote(result: CohortResult): string {
  if (!result.total) return "";
  if (result.total <= result.pageSize) return result.total === 1 ? " (shown below)" : ` (all ${result.total} shown)`;
  const from = (result.page - 1) * result.pageSize + 1;
  const to = Math.min(result.total, result.page * result.pageSize);
  return ` (showing ${from}–${to} of ${result.total})`;
}

function summarizeEn(criteria: Criterion[], result: CohortResult): CohortSummary {
  const lines: string[] = [];
  const content = criteria.filter((c) => !["sex", "age", "tag"].includes(c.kind));
  const sex = criteria.find((c) => c.kind === "sex" && (c.sexes ?? []).length === 1);
  const others = criteria.filter((c) => c !== sex);
  const n = result.total;
  const patients = (k: number) => `${k} ${sex ? `${SEX_ADJ[sex.sexes![0]!]} ` : ""}patient${k === 1 ? "" : "s"}`;
  let headline: string;
  const single = others.length === 1 ? others[0]! : null;
  if (single && content.length === 1 && !single.negate && single.terms.length && !single.terms.some((t) => t.any) && ["allergy", "condition", "medication", "procedure"].includes(single.kind)) {
    const terms = joinList(single.terms.map(termText), single.match === "all" ? "and" : "or");
    const tail = recordedAs(single);
    headline = n
      ? `${patients(n)} ${n === 1 ? "has" : "have"} ${terms} ${tail}${shownNote(result)}.`
      : `No ${sex ? `${SEX_ADJ[sex.sexes![0]!]} ` : ""}patient has ${terms} ${tail}.`;
  } else {
    const desc = criteria.map(describeCriterion).join(" · ");
    headline = n ? `${n} patient${n === 1 ? " matches" : "s match"} ${criteria.length > 1 ? "all of" : ""}: ${desc}${shownNote(result)}.`.replace(" : ", ": ") : `No patient matches ${criteria.length > 1 ? "all of" : ""}: ${desc}.`.replace(" : ", ": ");
  }
  // Per-term results for "a or b": say plainly which term found nobody.
  for (const tc of result.termCounts) {
    const c = criteria[tc.criterion]!;
    if (c.match !== "any") continue;
    if (tc.count === 0) lines.push(`No ${sex ? `${SEX_ADJ[sex.sexes![0]!]} ` : ""}patient${criteria.length > 2 || (criteria.length === 2 && !sex) ? " in this list" : ""} has ${tc.term} ${recordedAs(c)}.`);
  }
  if (result.termCounts.some((t) => t.count > 0) && result.termCounts.length > 1) {
    lines.push(`By term: ${result.termCounts.map((t) => `${t.term} ${t.count}`).join(" · ")}.`);
  }
  if (criteria.some((c) => c.negate && c.kind === "allergy")) {
    lines.push("Not recorded is not the same as not allergic: confirm with the patient before acting.");
  }
  lines.push(...result.notes);
  return { headline, lines };
}

function recordedAs(c: Criterion): string {
  switch (c.kind) {
    case "allergy":
      return "recorded as an allergy";
    case "condition":
      return "recorded as a condition or diagnosis";
    case "medication":
      return "recorded as an active medication";
    case "procedure":
      return "recorded as a surgery or procedure";
    default:
      return "recorded";
  }
}

function termText(t: TermSpec): string {
  return termDisplay(t);
}

function termLabel(t: TermSpec): string {
  return t.any ? "any" : termText(t);
}

// Arabic headlines: grammatical with any count ("عدد المرضى: 10").
function summarizeAr(criteria: Criterion[], result: CohortResult): CohortSummary {
  const lines: string[] = [];
  const desc = criteria.map(describeCriterionAr).join(" · ");
  const n = result.total;
  const shown = n === 0 ? "" : n <= result.pageSize ? " (معروضين كلهم)" : ` (معروض ${Math.min(result.pageSize, n - (result.page - 1) * result.pageSize)} من ${n})`;
  const headline = n ? `عدد المرضى المطابقين: ${n}${shown} — ${desc}.` : `لا يوجد مريض مطابق: ${desc}.`;
  for (const tc of result.termCounts) {
    const c = criteria[tc.criterion]!;
    if (c.match === "any" && tc.count === 0) lines.push(`لا يوجد مريض مسجل له: ${tc.term}.`);
  }
  if (result.termCounts.length > 1 && result.termCounts.some((t) => t.count > 0)) lines.push(`حسب البند: ${result.termCounts.map((t) => `${t.term} ${t.count}`).join(" · ")}.`);
  if (criteria.some((c) => c.negate && c.kind === "allergy")) lines.push("عدم تسجيل الحساسية لا يعني عدم وجودها: تأكد مع المريض.");
  lines.push(...result.notes);
  return { headline, lines };
}

export function describeCriterionAr(c: Criterion): string {
  const terms = c.terms.map(termDisplay).join(c.match === "all" ? " و " : " أو ");
  switch (c.kind) {
    case "allergy":
      if (c.terms.some((t) => t.any)) return c.negate ? "بدون حساسية مسجلة" : "أي حساسية مسجلة";
      return `${c.negate ? "بدون حساسية من" : "حساسية من"} ${terms}`;
    case "condition":
      return `${c.negate ? "بدون" : "مرض أو تشخيص:"} ${terms}`;
    case "medication":
      return `${c.negate ? "لا ياخد" : "دواء حالي:"} ${terms}`;
    case "procedure":
      return `${c.negate ? "بدون" : "عملية أو إجراء:"} ${terms}`;
    case "sex":
      return (c.sexes ?? []).map((s) => (s === "MALE" ? "ذكور" : "إناث")).join(" و ");
    case "age": {
      const min = c.age?.min ?? null;
      const max = c.age?.max ?? null;
      if (min !== null && max !== null) return min === max ? `السن ${min}` : `السن من ${min} إلى ${max}`;
      if (min !== null) return `السن ${min} فأكثر`;
      return `السن ${max} فأقل`;
    }
    case "tag":
      return `${c.negate ? "بدون الوسم" : "الوسم"} ${(c.tags ?? []).join("، ")}`;
    case "doctor":
      return `${c.negate ? "ليسوا من مرضى" : "مرضى"} ${(c.doctors ?? []).map((d) => d.name).join(" أو ")}`;
    case "appointment": {
      const label: Record<string, string> = { today: "النهارده", tomorrow: "بكرة", upcoming: "قادم", "this week": "الأسبوع ده", "next week": "الأسبوع الجاي", "this month": "الشهر ده", "next month": "الشهر الجاي" };
      return `${c.negate ? "مالوش ميعاد" : "عنده ميعاد"} ${label[c.window?.label ?? "upcoming"] ?? c.window?.label ?? ""}`.trim();
    }
    case "lastVisit":
      return c.cutoff?.before ? `لم يزر العيادة منذ ${c.cutoff.label.replace(/^no visit since /, "")}` : "لا توجد زيارة مسجلة";
  }
}

/** One line per patient for the plain-text answer (and the AiRun record). */
export function rowLine(row: CohortRow, index: number): string {
  const who = [row.age !== null ? String(row.age) : null, row.sex === "MALE" ? "male" : row.sex === "FEMALE" ? "female" : null].filter(Boolean).join(", ");
  const facts = row.facts.map((f) => `${f.label}: ${f.value}${f.note ? ` (${f.note})` : ""} · ${f.where}`).join("; ");
  return `${index}. ${row.name}${who ? ` (${who})` : ""}${facts ? ` — ${facts}` : ""} [${index}]`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function addFact(map: FactMap, id: string, fact: CohortFact): void {
  const list = map.get(id);
  if (list) list.push(fact);
  else map.set(id, [fact]);
}

/** Completed years on the clinic's calendar day (dates of birth are stored at UTC midnight). */
export function ageOn(dob: Date | null, today: { year: number; month: number; day: number }): number | null {
  if (!dob || Number.isNaN(dob.getTime())) return null;
  const y = dob.getUTCFullYear();
  const m = dob.getUTCMonth() + 1;
  const d = dob.getUTCDate();
  let age = today.year - y;
  if (today.month < m || (today.month === m && today.day < d)) age--;
  return age >= 0 && age < 150 ? age : null;
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

function normTag(t: string): string {
  return t.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function sexLabel(g: Gender): string {
  return g === "MALE" ? "male" : g === "FEMALE" ? "female" : g === "OTHER" ? "other" : "not recorded";
}

function sourceOf(c: Criterion): FactSource {
  switch (c.kind) {
    case "medication":
      return "MEDICATION";
    case "appointment":
      return "APPOINTMENT";
    case "lastVisit":
    case "doctor":
      return "VISIT_NOTE";
    case "tag":
    case "sex":
    case "age":
      return "PROFILE";
    default:
      return "DIAGNOSIS";
  }
}

function negatedLabel(c: Criterion): string {
  switch (c.kind) {
    case "allergy":
      return c.terms.some((t) => t.any) ? "Allergies" : `Allergy to ${c.terms.map((t) => t.label).join(" / ")}`;
    case "condition":
      return c.terms.map((t) => t.label).join(" / ");
    case "medication":
      return c.terms.map((t) => t.label).join(" / ");
    case "procedure":
      return c.terms.some((t) => t.any) ? "Surgeries" : c.terms.map((t) => t.label).join(" / ");
    case "appointment":
      return `Appointment ${c.window?.label ?? "upcoming"}`;
    case "doctor":
      return (c.doctors ?? []).map((d) => d.name).join(" / ");
    case "tag":
      return `Tag ${(c.tags ?? []).join(" / ")}`;
    default:
      return describeCriterion(c);
  }
}

function negatedWhere(c: Criterion): string {
  switch (c.kind) {
    case "allergy":
      return "Medical history · Allergies";
    case "condition":
      return "Medical history and signed consultations";
    case "medication":
      return "Medications · active";
    case "procedure":
      return "Medical history · Surgeries and procedures";
    case "appointment":
      return "Appointments";
    case "doctor":
      return "Visits and appointments";
    case "tag":
      return "Patient profile · Tags";
    default:
      return "Patient record";
  }
}

/** Descriptions used in the API response, the UI chips and the audit row. */
export function criteriaSummary(criteria: Criterion[]): string[] {
  return criteria.map(describeCriterion);
}

/** A compact, JSON-safe form of the criteria for the audit trail (no patient data). */
export function criteriaForAudit(criteria: Criterion[]): Record<string, unknown>[] {
  return criteria.map((c) => ({
    kind: c.kind,
    negate: c.negate,
    match: c.match,
    terms: c.terms.map((t) => (t.any ? "any" : t.label)),
    ...(c.sexes ? { sexes: c.sexes } : {}),
    ...(c.age ? { age: { min: c.age.min, max: c.age.max } } : {}),
    ...(c.tags ? { tags: c.tags } : {}),
    ...(c.doctors ? { doctorIds: c.doctors.map((d) => d.id) } : {}),
    ...(c.window ? { window: c.window.label } : {}),
    ...(c.cutoff ? { before: c.cutoff.before } : {}),
  }));
}

/** Labels of concepts and classes, re-exported for the eval report. */
export function conceptLabel(id: string): string {
  return conceptById(id)?.label ?? drugClassById(id)?.label ?? id;
}
